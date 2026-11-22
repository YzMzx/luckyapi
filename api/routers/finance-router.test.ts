import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

process.env.SQLITE_PATH = join(tmpdir(), `lucky-finance-${process.pid}-${Date.now()}.db`);

describe("player transfer and peer loans", () => {
  it("conserves transfers and loans, rejects temporary credit and recovers overdue debt", async () => {
    const [{ getDb }, schema, { appRouter }, finance, grants] = await Promise.all([
      import("../queries/connection"), import("../../db/schema"), import("../router"), import("./financeRouter"), import("../queries/credit-grants"),
    ]);
    const { users, sessions, adminSessions, moneyTransfers, peerLoans, peerLoanLedger, creditGrants } = schema;
    const db = getDb();
    const [lender, borrower, recipient, earlyBorrower, temporaryOnly] = await db.insert(users).values([
      { linuxdoId: "88001", username: "lender", groupName: "放贷方", balance: 100 },
      { linuxdoId: "88002", username: "borrower", groupName: "借款方", balance: 10 },
      { linuxdoId: "88003", username: "recipient", groupName: "收款方", balance: 0 },
      { linuxdoId: "88004", username: "early", groupName: "提前还款方", balance: 100 },
      { linuxdoId: "88005", username: "temporary", groupName: "仅临时额度", balance: 5 },
      { linuxdoId: "88006", username: "incomplete", groupName: null, balance: 100 },
    ]).returning();
    await db.insert(sessions).values([
      { token: "finance-lender", userId: lender.id, expiresAt: new Date(Date.now() + 60_000) },
      { token: "finance-borrower", userId: borrower.id, expiresAt: new Date(Date.now() + 60_000) },
      { token: "finance-early", userId: earlyBorrower.id, expiresAt: new Date(Date.now() + 60_000) },
      { token: "finance-temporary", userId: temporaryOnly.id, expiresAt: new Date(Date.now() + 60_000) },
    ]);
    await db.insert(adminSessions).values({ token: "finance-admin", expiresAt: new Date(Date.now() + 60_000) });
    const caller = (token: string) => appRouter.createCaller({ req: new Request("http://localhost/api/trpc", { headers: { cookie: `ld_session=${token}` } }), resHeaders: new Headers() });
    const lenderCaller = caller("finance-lender");
    const borrowerCaller = caller("finance-borrower");
    const earlyCaller = caller("finance-early");
    const temporaryCaller = caller("finance-temporary");
    const adminCaller = appRouter.createCaller({ req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_admin=finance-admin" } }), resHeaders: new Headers() });

    expect((await lenderCaller.finance.lookupAccount({ accountId: "88003" })).groupName).toBe("收款方");
    await expect(lenderCaller.finance.lookupAccount({ accountId: "999999" })).rejects.toThrow("未找到该正式账号");
    expect(await lenderCaller.finance.searchAccounts({ query: "收款" })).toEqual([
      expect.objectContaining({ accountId: "88003", groupName: "收款方", isSelf: false }),
    ]);
    expect((await lenderCaller.finance.searchAccounts({ query: "8800" })).map((row) => row.accountId)).toEqual([
      "88001", "88002", "88003", "88004", "88005",
    ]);
    expect(await lenderCaller.finance.searchAccounts({ query: "放贷方" })).toEqual([
      expect.objectContaining({ accountId: "88001", isSelf: true }),
    ]);
    expect(await lenderCaller.finance.searchAccounts({ query: "incomplete" })).toEqual([]);
    await expect(lenderCaller.finance.createLoan({ borrowerAccountId: "88001", principal: 1, monthlyRatePercent: 0, dueAt: new Date(Date.now() + 2 * 86_400_000), requestId: randomUUID() })).rejects.toThrow("不能向自己放贷");
    await expect(lenderCaller.finance.createLoan({ borrowerAccountId: "88006", principal: 1, monthlyRatePercent: 0, dueAt: new Date(Date.now() + 2 * 86_400_000), requestId: randomUUID() })).rejects.toThrow("未找到借款正式玩家");
    const transferRequestId = randomUUID();
    expect(await lenderCaller.finance.transfer({ accountId: "88003", amount: 10, requestId: transferRequestId })).toMatchObject({ amount: 10, fee: 0.3 });
    expect(Number((await db.select().from(users).where(eq(users.id, lender.id)))[0].balance)).toBe(89.7);
    expect(Number((await db.select().from(users).where(eq(users.id, recipient.id)))[0].balance)).toBe(10);
    expect(await lenderCaller.finance.transfer({ accountId: "88003", amount: 10, requestId: transferRequestId })).toMatchObject({ duplicated: true });
    await expect(lenderCaller.finance.transfer({ accountId: "88003", amount: 11, requestId: transferRequestId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.select().from(moneyTransfers)).toHaveLength(1);

    await db.insert(creditGrants).values({
      redemptionId: 88_005, codeId: 88_005, code: "TEMP-FINANCE", userId: temporaryOnly.id,
      originalUnits: 5_000_000, remainingUnits: 5_000_000, expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(temporaryCaller.finance.transfer({ accountId: "88003", amount: 1, requestId: randomUUID() })).rejects.toThrow("永久额度不足");
    await expect(temporaryCaller.finance.createLoan({ borrowerAccountId: "88002", principal: 1, monthlyRatePercent: 0, dueAt: new Date(Date.now() + 2 * 86_400_000), requestId: randomUUID() })).rejects.toThrow("永久额度不足");

    const loanRequestId = randomUUID();
    const loanDueAt = new Date(Date.now() + 2 * 86_400_000);
    const offer = await lenderCaller.finance.createLoan({ borrowerAccountId: "88002", principal: 30, monthlyRatePercent: 0, dueAt: loanDueAt, requestId: loanRequestId });
    expect(Number((await db.select().from(users).where(eq(users.id, lender.id)))[0].balance)).toBe(59.7);
    expect(await lenderCaller.finance.createLoan({ borrowerAccountId: "88002", principal: 30, monthlyRatePercent: 0, dueAt: loanDueAt, requestId: loanRequestId })).toMatchObject({ duplicated: true });
    await expect(lenderCaller.finance.createLoan({ borrowerAccountId: "88002", principal: 31, monthlyRatePercent: 0, dueAt: loanDueAt, requestId: loanRequestId })).rejects.toMatchObject({ code: "CONFLICT" });
    await borrowerCaller.finance.acceptLoan({ loanId: offer.id });
    expect(Number((await db.select().from(users).where(eq(users.id, borrower.id)))[0].balance)).toBe(40);
    await db.update(users).set({ balance: 10 }).where(eq(users.id, borrower.id));
    await db.update(peerLoans).set({ dueAt: new Date(Date.now() - 1) }).where(eq(peerLoans.id, offer.id));
    finance.processDueLoans(new Date());
    expect(Number((await db.select().from(users).where(eq(users.id, borrower.id)))[0].balance)).toBe(-20);
    expect(Number((await db.select().from(users).where(eq(users.id, lender.id)))[0].balance)).toBe(69.7);
    expect((await db.select().from(peerLoans).where(eq(peerLoans.id, offer.id)))[0]).toMatchObject({ status: "defaulted", outstandingPrincipalUnits: 20_000_000 });

    // 临时收入在负永久余额之上到期时，只清退临时部分并恢复原负债，不得吞掉债务。
    const negativeExpiryAt = new Date(Date.now() + 1_000);
    await db.insert(creditGrants).values({
      redemptionId: 88_006, codeId: 88_006, code: "TEMP-ON-DEBT", userId: borrower.id,
      originalUnits: 5_000_000, remainingUnits: 5_000_000, expiresAt: negativeExpiryAt,
    });
    await db.update(users).set({ balance: -15 }).where(eq(users.id, borrower.id));
    db.transaction((tx) => grants.expireUserCreditGrants(tx, borrower.id, new Date(negativeExpiryAt.getTime() + 1)));
    expect(Number((await db.select().from(users).where(eq(users.id, borrower.id)))[0].balance)).toBe(-20);

    // 随后真正到账 5 元永久额度时，追缴只给放贷方入账一次。
    await db.update(users).set({ balance: -15 }).where(eq(users.id, borrower.id));
    finance.processLoanIncomeInterception(new Date(Date.now() + 1_000));
    expect(Number((await db.select().from(users).where(eq(users.id, lender.id)))[0].balance)).toBe(74.7);
    expect((await db.select().from(peerLoans).where(eq(peerLoans.id, offer.id)))[0]).toMatchObject({ status: "collecting", outstandingPrincipalUnits: 15_000_000 });
    expect((await db.select().from(peerLoanLedger).where(eq(peerLoanLedger.loanId, offer.id))).map((row) => row.type)).toEqual(["offer_escrow", "disbursement", "due_collection", "income_interception"]);

    const earlyOffer = await lenderCaller.finance.createLoan({ borrowerAccountId: "88004", principal: 10, monthlyRatePercent: 10, dueAt: new Date(Date.now() + 30 * 86_400_000), requestId: randomUUID() });
    await earlyCaller.finance.acceptLoan({ loanId: earlyOffer.id });
    await db.update(peerLoans).set({ acceptedAt: new Date(Date.now() - 15 * 86_400_000) }).where(eq(peerLoans.id, earlyOffer.id));
    const lenderBeforeRepay = Number((await db.select().from(users).where(eq(users.id, lender.id)))[0].balance);
    const borrowerBeforeRepay = Number((await db.select().from(users).where(eq(users.id, earlyBorrower.id)))[0].balance);
    const repayRequestId = randomUUID();
    const repaid = await earlyCaller.finance.repayEarly({ loanId: earlyOffer.id, requestId: repayRequestId });
    expect(repaid.interest).toBeCloseTo(0.5, 4);
    expect(repaid.tax).toBeCloseTo(0.05, 4);
    expect(Number((await db.select().from(users).where(eq(users.id, lender.id)))[0].balance) - lenderBeforeRepay).toBeCloseTo(10.45, 4);
    expect(borrowerBeforeRepay - Number((await db.select().from(users).where(eq(users.id, earlyBorrower.id)))[0].balance)).toBeCloseTo(10.5, 4);
    expect(await earlyCaller.finance.repayEarly({ loanId: earlyOffer.id, requestId: repayRequestId })).toMatchObject({ duplicated: true });

    const expiring = await lenderCaller.finance.createLoan({ borrowerAccountId: "88003", principal: 2, monthlyRatePercent: 0, dueAt: new Date(Date.now() + 2 * 86_400_000), requestId: randomUUID() });
    const lenderBeforeExpiry = Number((await db.select().from(users).where(eq(users.id, lender.id)))[0].balance);
    await db.update(peerLoans).set({ offerExpiresAt: new Date(Date.now() - 1) }).where(eq(peerLoans.id, expiring.id));
    finance.processExpiredLoanOffers(new Date());
    finance.processExpiredLoanOffers(new Date(Date.now() + 1_000));
    expect(Number((await db.select().from(users).where(eq(users.id, lender.id)))[0].balance)).toBeCloseTo(lenderBeforeExpiry + 2, 6);

    const audit = await adminCaller.admin.listPeerLoansPage({ page: 1, pageSize: 2, party: "借款方" });
    expect(audit.total).toBeGreaterThanOrEqual(1);
    expect(audit.items.length).toBeLessThanOrEqual(2);
    expect(audit.items.some((row) => row.borrowerAccountId === "88002")).toBe(true);
    const auditById = await adminCaller.admin.listPeerLoansPage({ page: 1, pageSize: 20, loanId: offer.id, status: "overdue" });
    expect(auditById.items).toHaveLength(1);
    expect(auditById.items[0]).toMatchObject({ id: offer.id, auditStatus: "overdue", lenderAccountId: "88001", borrowerAccountId: "88002" });
    expect((await adminCaller.admin.listPeerLoansPage({ page: 1, pageSize: 20, loanId: expiring.id, status: "expired" })).items).toHaveLength(1);
    const ledgerAudit = await adminCaller.admin.listPeerLoanLedgerPage({ loanId: offer.id, page: 1, pageSize: 2 });
    expect(ledgerAudit.total).toBe(4);
    expect(ledgerAudit.items).toHaveLength(2);

    const { grantExperience } = await import("../queries/levels");
    grantExperience(borrower.id, "finance-test", 797_900);
    await borrowerCaller.levels.equip({ level: 10 });
    const ranking = await borrowerCaller.finance.creditLeaderboard({ page: 1, pageSize: 1 });
    expect(ranking.items).toHaveLength(1);
    const equipped = { level: 10, rank: 1 };
    expect(ranking.myRank?.badge).toEqual(equipped);
    expect(ranking.items[0].badge).toEqual(ranking.items[0].userId === borrower.id ? equipped : { level: 1, rank: null });
    expect(ranking.total).toBeGreaterThanOrEqual(2);
    expect(ranking.totalPages).toBe(ranking.total);
    expect(ranking.items[0]).not.toHaveProperty("accountId");
    const borrowing = await borrowerCaller.finance.loanVolumeLeaderboard({ side: "borrower", page: 1, pageSize: 20 });
    expect(borrowing.items.find((row) => row.userId === borrower.id)).toMatchObject({ totalPrincipalUnits: 30_000_000, loanCount: 1, badge: equipped });
    expect(borrowing.myRank?.badge).toEqual(equipped);
    expect(borrowing.items.some((row) => row.userId === recipient.id)).toBe(false);
    expect(borrowing.items[0]).not.toHaveProperty("accountId");
    const lending = await borrowerCaller.finance.loanVolumeLeaderboard({ side: "lender", page: 1, pageSize: 20 });
    expect(lending.items.find((row) => row.userId === lender.id)).toMatchObject({ totalPrincipalUnits: 40_000_000, loanCount: 2 });
    expect(lending.myRank).toBeNull();
    const anonymous = appRouter.createCaller({ req: new Request("http://localhost/api/trpc"), resHeaders: new Headers() });
    await expect(anonymous.finance.creditLeaderboard({ page: 1, pageSize: 20 })).rejects.toThrow("请先登录");
    await expect(anonymous.finance.loanVolumeLeaderboard({ side: "borrower", page: 1, pageSize: 20 })).rejects.toThrow("请先登录");
    await expect(anonymous.admin.listPeerLoansPage({ page: 1, pageSize: 20 })).rejects.toThrow("需要管理员登录");
    await expect(anonymous.admin.listPeerLoanLedgerPage({ loanId: offer.id, page: 1, pageSize: 20 })).rejects.toThrow("需要管理员登录");
  });
});
