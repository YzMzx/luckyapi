import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lte, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { creditGrants, moneyTransfers, peerLoanLedger, peerLoans, users } from "@db/schema";
import {
  accruedInterestUnits,
  allocateLoanCollection,
  interestTaxUnits,
  moneyFromUnits,
  transferFeeUnits,
  unitsFromMoney,
} from "@contracts/finance";
import { createRouter } from "../middleware";
import { memberQuery } from "../auth";
import { getDb } from "../queries/connection";
import { debitPermanentBalance } from "../queries/credit-grants";
import { recordTx } from "../queries/ledger";
import { currentBusinessDay } from "../queries/entertainment-control";
import { assertModuleAvailable, readFinanceRules, readUserPolicy, stricterLimit, type FinanceRules } from "../queries/policies";

const pageInput = z.object({ page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(50).default(20) });
const loanVolumeLeaderboardInput = pageInput.extend({ side: z.enum(["borrower", "lender"]) });
const requestIdSchema = z.string().min(8).max(100).regex(/^[a-zA-Z0-9:_-]+$/);
const loanOfferInput = z.object({
  borrowerAccountId: z.string().trim().regex(/^\d+$/).max(32),
  principal: z.number().min(0.01).max(1_000_000),
  monthlyRatePercent: z.number().min(0).max(100),
  dueAt: z.coerce.date(),
  requestId: requestIdSchema,
});
const senderUser = alias(users, "sender");
const recipientUser = alias(users, "recipient");
const lenderUser = alias(users, "lender");
const borrowerUser = alias(users, "borrower");
type FinanceDb = ReturnType<typeof getDb>;
type FinanceTx = Parameters<Parameters<FinanceDb["transaction"]>[0]>[0];

function rawBalanceUnits(value: number) {
  const units = Math.round(Number(value) * 1_000_000);
  if (!Number.isSafeInteger(units)) throw new Error("余额单位无效");
  return units;
}

function snapshotRules(loan: typeof peerLoans.$inferSelect): FinanceRules {
  try {
    const parsed = JSON.parse(loan.ruleSnapshotJson) as Partial<FinanceRules>;
    if (Number.isInteger(parsed.loanInterestTaxBasisPoints)) return { ...readFinanceRules(getDb()), ...parsed } as FinanceRules;
  } catch { /* legacy contract */ }
  return readFinanceRules(getDb());
}

function activeTemporaryUnits(tx: FinanceTx, userId: number, now: Date) {
  return tx.select({ total: sql<number>`coalesce(sum(${creditGrants.remainingUnits}), 0)` }).from(creditGrants).where(and(
    eq(creditGrants.userId, userId), eq(creditGrants.status, "active"), gt(creditGrants.remainingUnits, 0), gt(creditGrants.expiresAt, now),
  )).get()?.total ?? 0;
}

function creditLender(tx: FinanceTx, lenderId: number, units: number, loanId: number, note: string) {
  if (units <= 0) return rawBalanceUnits(Number(tx.select({ balance: users.balance }).from(users).where(eq(users.id, lenderId)).get()?.balance ?? 0));
  const lender = tx.select({ balance: users.balance }).from(users).where(eq(users.id, lenderId)).get();
  if (!lender) throw new Error("放贷方不存在");
  const after = rawBalanceUnits(Number(lender.balance)) + units;
  tx.update(users).set({ balance: moneyFromUnits(after) }).where(eq(users.id, lenderId)).run();
  recordTx(tx, lenderId, "loan_repayment", moneyFromUnits(units), `借贷 #${loanId} ${note}`);
  return after;
}

function applyCollection(tx: FinanceTx, loan: typeof peerLoans.$inferSelect, availableUnits: number, requestId: string, type: string, borrowerBalanceAfterUnits: number) {
  const rules = snapshotRules(loan);
  const allocation = allocateLoanCollection({
    availableUnits,
    outstandingPrincipalUnits: loan.outstandingPrincipalUnits,
    outstandingInterestUnits: loan.outstandingInterestUnits,
    interestTaxBasisPoints: rules.loanInterestTaxBasisPoints,
  });
  // 分次收息时按“累计已收利息应纳税额 - 已纳税额”补差，避免微额拆分规避 10% 利息税。
  const cumulativeTaxUnits = interestTaxUnits(loan.paidInterestUnits + allocation.interestUnits, rules.loanInterestTaxBasisPoints);
  const taxUnits = Math.max(0, cumulativeTaxUnits - loan.taxPaidUnits);
  const lenderCreditUnits = allocation.principalUnits + allocation.interestUnits - taxUnits;
  const lenderAfter = creditLender(tx, loan.lenderId, lenderCreditUnits, loan.id, type === "due_collection" ? "到期回收" : "后续回收");
  const fulfilled = allocation.remainingPrincipalUnits + allocation.remainingInterestUnits === 0;
  tx.update(peerLoans).set({
    status: fulfilled ? "fulfilled" : (type === "due_collection" ? "defaulted" : "collecting"),
    outstandingPrincipalUnits: allocation.remainingPrincipalUnits,
    outstandingInterestUnits: allocation.remainingInterestUnits,
    paidPrincipalUnits: loan.paidPrincipalUnits + allocation.principalUnits,
    paidInterestUnits: loan.paidInterestUnits + allocation.interestUnits,
    taxPaidUnits: loan.taxPaidUnits + taxUnits,
    defaultedAt: !fulfilled && !loan.defaultedAt ? new Date() : loan.defaultedAt,
    settledAt: fulfilled ? new Date() : null,
    updatedAt: new Date(),
  }).where(eq(peerLoans.id, loan.id)).run();
  tx.insert(peerLoanLedger).values({
    loanId: loan.id, requestId, type, amountUnits: allocation.collectedUnits,
    principalUnits: allocation.principalUnits, interestUnits: allocation.interestUnits, taxUnits,
    borrowerBalanceAfterUnits, lenderBalanceAfterUnits: lenderAfter,
    note: fulfilled ? "债务已全部履约" : "不足部分进入持续追缴",
  }).onConflictDoNothing().run();
  return allocation;
}

export function processExpiredLoanOffers(now = new Date()) {
  const db = getDb();
  return db.transaction((tx) => {
    const expired = tx.select().from(peerLoans).where(and(eq(peerLoans.status, "pending"), lte(peerLoans.offerExpiresAt, now))).orderBy(asc(peerLoans.id)).all();
    for (const loan of expired) {
      const changed = tx.update(peerLoans).set({ status: "cancelled", terminalReason: "expired", settledAt: now, updatedAt: now })
        .where(and(eq(peerLoans.id, loan.id), eq(peerLoans.status, "pending"))).returning({ id: peerLoans.id }).get();
      if (!changed) continue;
      const lender = tx.select({ balance: users.balance }).from(users).where(eq(users.id, loan.lenderId)).get();
      if (!lender) continue;
      const after = rawBalanceUnits(Number(lender.balance)) + loan.principalUnits;
      tx.update(users).set({ balance: moneyFromUnits(after) }).where(eq(users.id, loan.lenderId)).run();
      recordTx(tx, loan.lenderId, "loan_offer_refund", moneyFromUnits(loan.principalUnits), `借贷 #${loan.id} 五分钟未接受，本金退回`);
      tx.insert(peerLoanLedger).values({ loanId: loan.id, requestId: `loan:${loan.id}:offer-expire`, type: "offer_expired_refund", amountUnits: loan.principalUnits, lenderBalanceAfterUnits: after, note: "五分钟未接受，合同作废并退回冻结本金" }).onConflictDoNothing().run();
    }
    return expired.length;
  });
}

export function processDueLoans(now = new Date()) {
  processExpiredLoanOffers(now);
  const db = getDb();
  return db.transaction((tx) => {
    const due = tx.select().from(peerLoans).where(and(eq(peerLoans.status, "active"), lte(peerLoans.dueAt, now))).orderBy(asc(peerLoans.dueAt), asc(peerLoans.id)).all();
    let processed = 0;
    for (const loan of due) {
      const borrower = tx.select({ balance: users.balance }).from(users).where(eq(users.id, loan.borrowerId)).get();
      if (!borrower || !loan.acceptedAt) continue;
      const interest = accruedInterestUnits({
        principalUnits: loan.principalUnits, monthlyRateBasisPoints: loan.monthlyRateBasisPoints,
        acceptedAtMs: loan.acceptedAt.getTime(), settlementAtMs: now.getTime(), dueAtMs: loan.dueAt.getTime(),
      });
      const total = loan.principalUnits + interest;
      const before = rawBalanceUnits(Number(borrower.balance));
      const temporary = activeTemporaryUnits(tx, loan.borrowerId, now);
      const available = Math.min(total, Math.max(0, before - temporary));
      const after = before - total;
      tx.update(users).set({ balance: moneyFromUnits(after) }).where(eq(users.id, loan.borrowerId)).run();
      recordTx(tx, loan.borrowerId, "loan_due", -moneyFromUnits(total), `借贷 #${loan.id} 到期自动扣款`);
      const rules = snapshotRules(loan);
      const dueTax = interestTaxUnits(interest, rules.loanInterestTaxBasisPoints);
      const dueSnapshot = { ...loan, accruedInterestUnits: interest, interestTaxUnits: dueTax, outstandingPrincipalUnits: loan.principalUnits, outstandingInterestUnits: interest };
      tx.update(peerLoans).set({
        accruedInterestUnits: interest, interestTaxUnits: dueTax,
        outstandingPrincipalUnits: loan.principalUnits, outstandingInterestUnits: interest, updatedAt: now,
      }).where(eq(peerLoans.id, loan.id)).run();
      applyCollection(tx, dueSnapshot, available, `loan:${loan.id}:due`, "due_collection", after);
      processed += 1;
    }
    return processed;
  });
}

export function processLoanIncomeInterception(now = new Date()) {
  processDueLoans(now);
  const db = getDb();
  return db.transaction((tx) => {
    const loans = tx.select().from(peerLoans).where(inArray(peerLoans.status, ["collecting", "defaulted"])).orderBy(asc(peerLoans.dueAt), asc(peerLoans.id)).all();
    const byBorrower = new Map<number, typeof loans>();
    for (const loan of loans) byBorrower.set(loan.borrowerId, [...(byBorrower.get(loan.borrowerId) ?? []), loan]);
    let collections = 0;
    for (const [borrowerId, debts] of byBorrower) {
      const borrower = tx.select({ balance: users.balance }).from(users).where(eq(users.id, borrowerId)).get();
      if (!borrower) continue;
      const balance = rawBalanceUnits(Number(borrower.balance));
      const temporary = activeTemporaryUnits(tx, borrowerId, now);
      const permanentEconomicBalance = balance - temporary;
      const totalOutstanding = debts.reduce((sum, loan) => sum + loan.outstandingPrincipalUnits + loan.outstandingInterestUnits, 0);
      let incoming = Math.max(0, totalOutstanding - Math.max(0, -permanentEconomicBalance));
      for (const loan of debts) {
        if (incoming <= 0) break;
        const available = Math.min(incoming, loan.outstandingPrincipalUnits + loan.outstandingInterestUnits);
        const allocation = applyCollection(tx, loan, available, `loan:${loan.id}:intercept:${now.getTime()}`, "income_interception", balance);
        incoming -= allocation.collectedUnits;
        collections += allocation.collectedUnits > 0 ? 1 : 0;
      }
    }
    return collections;
  });
}

function safeUser(user: { id: number; linuxdoId: string; username: string; displayName: string; groupName: string | null; avatarUrl: string }) {
  return { id: user.id, accountId: user.linuxdoId, username: user.username, displayName: user.displayName, groupName: user.groupName, avatarUrl: user.avatarUrl };
}

export const financeRouter = createRouter({
  lookupAccount: memberQuery.input(z.object({ accountId: z.string().regex(/^\d+$/).max(32) })).query(({ input, ctx }) => {
    const db = getDb();
    const user = db.select({ id: users.id, linuxdoId: users.linuxdoId, username: users.username, displayName: users.displayName, groupName: users.groupName, avatarUrl: users.avatarUrl })
      .from(users).where(and(eq(users.linuxdoId, input.accountId), isNotNull(users.groupName))).get();
    if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "未找到该正式账号" });
    return { ...safeUser(user), isSelf: user.id === ctx.user.id };
  }),

  searchAccounts: memberQuery.input(z.object({ query: z.string().trim().min(1).max(64) })).query(({ input, ctx }) => {
    const db = getDb();
    // Treat LIKE wildcards as plain characters so input cannot broaden a search.
    const escaped = input.query.replace(/[\\%_]/g, "\\$&");
    const contains = `%${escaped}%`;
    const prefix = `${escaped}%`;
    const rows = db.select({
      id: users.id,
      linuxdoId: users.linuxdoId,
      username: users.username,
      displayName: users.displayName,
      groupName: users.groupName,
      avatarUrl: users.avatarUrl,
    }).from(users).where(and(
      isNotNull(users.groupName),
      sql`trim(${users.groupName}) != ''`,
      or(
        sql`${users.linuxdoId} LIKE ${prefix} ESCAPE '\\'`,
        sql`lower(${users.groupName}) LIKE lower(${contains}) ESCAPE '\\'`,
        sql`lower(${users.username}) LIKE lower(${contains}) ESCAPE '\\'`,
        sql`lower(${users.displayName}) LIKE lower(${contains}) ESCAPE '\\'`,
      ),
    )).orderBy(
      sql`CASE WHEN ${users.linuxdoId} = ${input.query} THEN 0 WHEN lower(${users.groupName}) = lower(${input.query}) THEN 1 WHEN ${users.linuxdoId} LIKE ${prefix} ESCAPE '\\' THEN 2 ELSE 3 END`,
      asc(users.id),
    ).limit(8).all();
    return rows.map((user) => ({ ...safeUser(user), isSelf: user.id === ctx.user.id }));
  }),

  transfer: memberQuery.input(z.object({ accountId: z.string().regex(/^\d+$/).max(32), amount: z.number().positive().max(1_000_000), requestId: requestIdSchema })).mutation(({ input, ctx }) => {
    processLoanIncomeInterception();
    const db = getDb();
    try {
      return db.transaction((tx) => {
        assertModuleAvailable(tx, "transfer", ctx.user.id);
        const rules = readFinanceRules(tx);
        const policy = readUserPolicy(tx, ctx.user.id);
        const recipient = tx.select({ id: users.id, username: users.username }).from(users).where(and(eq(users.linuxdoId, input.accountId), isNotNull(users.groupName))).get();
        if (!recipient) throw new Error("未找到该正式账号");
        if (recipient.id === ctx.user.id) throw new Error("不能给自己转账");
        const amountUnits = unitsFromMoney(input.amount);
        if (amountUnits < rules.transferMinUnits || amountUnits > rules.transferMaxUnits)
          throw new Error(`单笔转账须在 $${moneyFromUnits(rules.transferMinUnits).toFixed(2)}–$${moneyFromUnits(rules.transferMaxUnits).toFixed(2)} 之间`);
        const day = currentBusinessDay(tx);
        const sentToday = Number(tx.select({ n: sql<number>`COALESCE(SUM(${moneyTransfers.amountUnits}), 0)` }).from(moneyTransfers).where(and(
          eq(moneyTransfers.senderId, ctx.user.id), eq(moneyTransfers.status, "completed"), gte(moneyTransfers.createdAt, day.startsAt), lt(moneyTransfers.createdAt, day.endsAt),
        )).get()?.n ?? 0);
        const dailyLimit = stricterLimit(rules.transferDailyLimitUnits, policy.transferDailyLimitUnits);
        if (sentToday + amountUnits > dailyLimit) throw new Error(`今日累计转账不能超过 $${moneyFromUnits(dailyLimit).toFixed(2)}`);
        const feeUnits = transferFeeUnits(amountUnits, rules.transferFeeBasisPoints);
        const prior = tx.select().from(moneyTransfers).where(eq(moneyTransfers.requestId, input.requestId)).get();
        if (prior) {
          if (prior.senderId !== ctx.user.id || prior.recipientId !== recipient.id || prior.amountUnits !== amountUnits || prior.feeUnits !== feeUnits)
            throw new TRPCError({ code: "CONFLICT", message: "requestId 已用于不同的转账参数" });
          return { id: prior.id, amount: moneyFromUnits(prior.amountUnits), fee: moneyFromUnits(prior.feeUnits), duplicated: true };
        }
        const totalUnits = amountUnits + feeUnits;
        debitPermanentBalance(tx, { userId: ctx.user.id, amount: moneyFromUnits(totalUnits), kind: "transfer_out", note: `转账给账号 ${input.accountId}（到账 ${moneyFromUnits(amountUnits).toFixed(6)}，手续费 ${(rules.transferFeeBasisPoints / 100).toFixed(2)}% / $${moneyFromUnits(feeUnits).toFixed(6)}）` });
        const receiver = tx.select({ balance: users.balance }).from(users).where(eq(users.id, recipient.id)).get();
        if (!receiver) throw new Error("收款账号不存在");
        const receiverAfter = rawBalanceUnits(Number(receiver.balance)) + amountUnits;
        tx.update(users).set({ balance: moneyFromUnits(receiverAfter) }).where(eq(users.id, recipient.id)).run();
        recordTx(tx, recipient.id, "transfer_in", input.amount, `收到账号 ${ctx.user.linuxdoId} 转账`);
        const row = tx.insert(moneyTransfers).values({ requestId: input.requestId, senderId: ctx.user.id, recipientId: recipient.id, amountUnits, feeUnits }).returning({ id: moneyTransfers.id }).get();
        return { id: row.id, amount: input.amount, fee: moneyFromUnits(feeUnits), recipient: recipient.username, duplicated: false };
      });
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "转账失败" });
    }
  }),

  createLoan: memberQuery.input(loanOfferInput).mutation(({ input, ctx }) => {
    const now = new Date();
    const rateBps = Math.round(input.monthlyRatePercent * 100);
    const principalUnits = unitsFromMoney(input.principal);
    const db = getDb();
    try {
      return db.transaction((tx) => {
        assertModuleAvailable(tx, "lending", ctx.user.id);
        const rules = readFinanceRules(tx);
        const lenderPolicy = readUserPolicy(tx, ctx.user.id);
        const minDue = now.getTime() + rules.loanMinDurationDays * 86_400_000;
        const maxDue = now.getTime() + rules.loanMaxDurationDays * 86_400_000;
        if (input.dueAt.getTime() < minDue || input.dueAt.getTime() > maxDue)
          throw new Error(`还款期限须在 ${rules.loanMinDurationDays} 至 ${rules.loanMaxDurationDays} 天内`);
        if (principalUnits < rules.loanMinPrincipalUnits || principalUnits > rules.loanMaxPrincipalUnits)
          throw new Error(`借贷本金须在 $${moneyFromUnits(rules.loanMinPrincipalUnits).toFixed(2)}–$${moneyFromUnits(rules.loanMaxPrincipalUnits).toFixed(2)} 之间`);
        if (rateBps < rules.loanMinRateBasisPoints || rateBps > rules.loanMaxRateBasisPoints)
          throw new Error(`月利率须在 ${(rules.loanMinRateBasisPoints / 100).toFixed(2)}%–${(rules.loanMaxRateBasisPoints / 100).toFixed(2)}% 之间`);
        const borrower = tx.select({ id: users.id, username: users.username }).from(users).where(and(
          eq(users.linuxdoId, input.borrowerAccountId), isNotNull(users.groupName), sql`trim(${users.groupName}) != ''`,
        )).get();
        if (!borrower) throw new Error("未找到借款正式玩家");
        if (borrower.id === ctx.user.id) throw new Error("不能向自己放贷");
        const borrowerPolicy = readUserPolicy(tx, borrower.id);
        if (borrowerPolicy.financeFrozen) throw new Error("借款方金融权限已被冻结");
        const day = currentBusinessDay(tx);
        const lentToday = Number(tx.select({ n: sql<number>`COALESCE(SUM(${peerLoans.principalUnits}), 0)` }).from(peerLoans).where(and(
          eq(peerLoans.lenderId, ctx.user.id), isNotNull(peerLoans.acceptedAt), gte(peerLoans.acceptedAt, day.startsAt), lt(peerLoans.acceptedAt, day.endsAt),
        )).get()?.n ?? 0);
        const lendingLimit = stricterLimit(rules.lendingDailyLimitUnits, lenderPolicy.lendingDailyLimitUnits);
        if (lentToday + principalUnits > lendingLimit) throw new Error(`今日累计放贷不能超过 $${moneyFromUnits(lendingLimit).toFixed(2)}`);
        const outstanding = Number(tx.select({ n: sql<number>`COALESCE(SUM(${peerLoans.outstandingPrincipalUnits} + ${peerLoans.outstandingInterestUnits}), 0)` }).from(peerLoans).where(and(
          eq(peerLoans.borrowerId, borrower.id), inArray(peerLoans.status, ["active", "collecting", "defaulted"]),
        )).get()?.n ?? 0);
        const borrowLimit = stricterLimit(rules.outstandingBorrowLimitUnits, borrowerPolicy.outstandingBorrowLimitUnits);
        if (outstanding + principalUnits > borrowLimit) throw new Error(`借款方未偿债务不能超过 $${moneyFromUnits(borrowLimit).toFixed(2)}`);
        const prior = tx.select().from(peerLoans).where(eq(peerLoans.requestId, input.requestId)).get();
        if (prior) {
          if (prior.lenderId !== ctx.user.id || prior.borrowerId !== borrower.id || prior.principalUnits !== principalUnits || prior.monthlyRateBasisPoints !== rateBps || prior.dueAt.getTime() !== input.dueAt.getTime())
            throw new TRPCError({ code: "CONFLICT", message: "requestId 已用于不同的借贷合同参数" });
          return { id: prior.id, duplicated: true, offerExpiresAt: prior.offerExpiresAt };
        }
        debitPermanentBalance(tx, { userId: ctx.user.id, amount: input.principal, kind: "loan_disbursement", note: "民间贷待接收合同冻结本金" });
        const offerExpiresAt = new Date(now.getTime() + rules.loanOfferExpiryMinutes * 60_000);
        const row = tx.insert(peerLoans).values({ requestId: input.requestId, lenderId: ctx.user.id, borrowerId: borrower.id, principalUnits, monthlyRateBasisPoints: rateBps, ruleSnapshotJson: JSON.stringify(rules), dueAt: input.dueAt, offerExpiresAt }).returning({ id: peerLoans.id }).get();
        tx.insert(peerLoanLedger).values({ loanId: row.id, requestId: `loan:${row.id}:offer-escrow`, type: "offer_escrow", amountUnits: principalUnits, note: "合同发出，冻结本金五分钟" }).run();
        return { id: row.id, borrower: borrower.username, offerExpiresAt, duplicated: false };
      });
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "合同发送失败" });
    }
  }),

  acceptLoan: memberQuery.input(z.object({ loanId: z.number().int().positive() })).mutation(({ input, ctx }) => {
    processLoanIncomeInterception();
    const db = getDb();
    try {
      return db.transaction((tx) => {
        assertModuleAvailable(tx, "lending", ctx.user.id);
        const loan = tx.select().from(peerLoans).where(eq(peerLoans.id, input.loanId)).get();
        if (!loan || loan.borrowerId !== ctx.user.id) throw new Error("借贷合同不存在");
        if (loan.status !== "pending") throw new Error("该合同已处理或五分钟接收期已结束");
        if (loan.offerExpiresAt.getTime() <= Date.now()) throw new Error("五分钟接收期已结束，本金已退回放贷方");
        if (loan.dueAt.getTime() <= Date.now()) throw new Error("该合同已过期");
        const changed = tx.update(peerLoans).set({ status: "active", acceptedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(peerLoans.id, loan.id), eq(peerLoans.status, "pending"))).returning({ id: peerLoans.id }).get();
        if (!changed) throw new Error("该合同已由其他请求处理");
        const borrower = tx.select({ balance: users.balance }).from(users).where(eq(users.id, loan.borrowerId)).get();
        if (!borrower) throw new Error("借款方不存在");
        const after = rawBalanceUnits(Number(borrower.balance)) + loan.principalUnits;
        tx.update(users).set({ balance: moneyFromUnits(after) }).where(eq(users.id, loan.borrowerId)).run();
        recordTx(tx, loan.borrowerId, "loan_disbursement", moneyFromUnits(loan.principalUnits), `借贷 #${loan.id} 本金到账`);
        tx.insert(peerLoanLedger).values({ loanId: loan.id, requestId: `loan:${loan.id}:accept`, type: "disbursement", amountUnits: loan.principalUnits, borrowerBalanceAfterUnits: after, note: "借款方接受，合同生效" }).run();
        return { id: loan.id, principal: moneyFromUnits(loan.principalUnits) };
      });
    } catch (error) { throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "接受失败" }); }
  }),

  rejectOrCancelLoan: memberQuery.input(z.object({ loanId: z.number().int().positive() })).mutation(({ input, ctx }) => {
    const db = getDb();
    try {
      return db.transaction((tx) => {
        const loan = tx.select().from(peerLoans).where(eq(peerLoans.id, input.loanId)).get();
        if (!loan || (loan.lenderId !== ctx.user.id && loan.borrowerId !== ctx.user.id)) throw new Error("合同不存在");
        if (loan.status !== "pending") throw new Error("仅待接受合同可取消");
        const changed = tx.update(peerLoans).set({ status: "cancelled", terminalReason: loan.borrowerId === ctx.user.id ? "rejected" : "cancelled", settledAt: new Date(), updatedAt: new Date() })
          .where(and(eq(peerLoans.id, loan.id), eq(peerLoans.status, "pending"))).returning({ id: peerLoans.id }).get();
        if (!changed) throw new Error("该合同已由其他请求处理");
        const lender = tx.select({ balance: users.balance }).from(users).where(eq(users.id, loan.lenderId)).get();
        if (!lender) throw new Error("放贷方不存在");
        const after = rawBalanceUnits(Number(lender.balance)) + loan.principalUnits;
        tx.update(users).set({ balance: moneyFromUnits(after) }).where(eq(users.id, loan.lenderId)).run();
        recordTx(tx, loan.lenderId, "loan_offer_refund", moneyFromUnits(loan.principalUnits), `借贷 #${loan.id} 取消/拒绝，本金退回`);
        tx.insert(peerLoanLedger).values({ loanId: loan.id, requestId: `loan:${loan.id}:offer-cancel`, type: "offer_cancelled_refund", amountUnits: loan.principalUnits, lenderBalanceAfterUnits: after, note: "合同取消或拒绝，冻结本金退回" }).onConflictDoNothing().run();
        return { success: true };
      });
    } catch (error) { throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "取消失败" }); }
  }),

  repayEarly: memberQuery.input(z.object({ loanId: z.number().int().positive(), requestId: requestIdSchema })).mutation(({ input, ctx }) => {
    const now = new Date();
    const db = getDb();
    try {
      return db.transaction((tx) => {
        const loan = tx.select().from(peerLoans).where(eq(peerLoans.id, input.loanId)).get();
        if (!loan || loan.borrowerId !== ctx.user.id) throw new Error("合同不存在");
        const prior = tx.select().from(peerLoanLedger).where(eq(peerLoanLedger.requestId, input.requestId)).get();
        if (prior) {
          if (prior.loanId !== loan.id || prior.type !== "early_repayment") throw new TRPCError({ code: "CONFLICT", message: "requestId 已用于其他借贷操作" });
          return { total: moneyFromUnits(prior.amountUnits), interest: moneyFromUnits(prior.interestUnits), tax: moneyFromUnits(prior.taxUnits), duplicated: true };
        }
        if (loan.status !== "active" || !loan.acceptedAt) throw new Error("该合同不能提前还款");
        const interest = accruedInterestUnits({ principalUnits: loan.principalUnits, monthlyRateBasisPoints: loan.monthlyRateBasisPoints, acceptedAtMs: loan.acceptedAt.getTime(), settlementAtMs: now.getTime(), dueAtMs: loan.dueAt.getTime() });
        const tax = interestTaxUnits(interest, snapshotRules(loan).loanInterestTaxBasisPoints);
        const total = loan.principalUnits + interest;
        debitPermanentBalance(tx, { userId: loan.borrowerId, amount: moneyFromUnits(total), kind: "loan_repayment", note: `借贷 #${loan.id} 提前还款` });
        const lenderAfter = creditLender(tx, loan.lenderId, loan.principalUnits + interest - tax, loan.id, "提前还款");
        const borrowerAfter = rawBalanceUnits(Number(tx.select({ balance: users.balance }).from(users).where(eq(users.id, loan.borrowerId)).get()?.balance ?? 0));
        tx.update(peerLoans).set({ status: "fulfilled", accruedInterestUnits: interest, interestTaxUnits: tax, paidPrincipalUnits: loan.principalUnits, paidInterestUnits: interest, taxPaidUnits: tax, settledAt: now, updatedAt: now }).where(eq(peerLoans.id, loan.id)).run();
        tx.insert(peerLoanLedger).values({ loanId: loan.id, requestId: input.requestId, type: "early_repayment", amountUnits: total, principalUnits: loan.principalUnits, interestUnits: interest, taxUnits: tax, borrowerBalanceAfterUnits: borrowerAfter, lenderBalanceAfterUnits: lenderAfter, note: "按实际经过时间折算月息" }).run();
        return { total: moneyFromUnits(total), interest: moneyFromUnits(interest), tax: moneyFromUnits(tax), duplicated: false };
      });
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "还款失败" });
    }
  }),

  myFinance: memberQuery.input(pageInput).query(({ input, ctx }) => {
    processLoanIncomeInterception();
    const db = getDb();
    const offset = (input.page - 1) * input.pageSize;
    const transferWhere = or(eq(moneyTransfers.senderId, ctx.user.id), eq(moneyTransfers.recipientId, ctx.user.id));
    const loanWhere = or(eq(peerLoans.lenderId, ctx.user.id), eq(peerLoans.borrowerId, ctx.user.id));
    const transferTotal = db.select({ count: sql<number>`count(*)` }).from(moneyTransfers).where(transferWhere).get()?.count ?? 0;
    const loanTotal = db.select({ count: sql<number>`count(*)` }).from(peerLoans).where(loanWhere).get()?.count ?? 0;
    const transfers = db.select({ transfer: moneyTransfers, senderName: senderUser.username, recipientName: recipientUser.username, senderAccountId: senderUser.linuxdoId, recipientAccountId: recipientUser.linuxdoId })
      .from(moneyTransfers).innerJoin(senderUser, eq(senderUser.id, moneyTransfers.senderId)).innerJoin(recipientUser, eq(recipientUser.id, moneyTransfers.recipientId))
      .where(transferWhere).orderBy(desc(moneyTransfers.id)).limit(input.pageSize).offset(offset).all();
    const loans = db.select({ loan: peerLoans, lenderName: lenderUser.username, borrowerName: borrowerUser.username, lenderAccountId: lenderUser.linuxdoId, borrowerAccountId: borrowerUser.linuxdoId })
      .from(peerLoans).innerJoin(lenderUser, eq(lenderUser.id, peerLoans.lenderId)).innerJoin(borrowerUser, eq(borrowerUser.id, peerLoans.borrowerId))
      .where(loanWhere).orderBy(desc(peerLoans.id)).limit(input.pageSize).offset(offset).all();
    return { transfers, loans, transferTotal, loanTotal, page: input.page, pageSize: input.pageSize, meId: ctx.user.id };
  }),

  creditLeaderboard: memberQuery.input(pageInput).query(({ input, ctx }) => {
    processLoanIncomeInterception();
    const db = getDb();
    const creditBase = db.select({
      userId: users.id, username: users.username, groupName: users.groupName, avatarUrl: users.avatarUrl,
      loanCount: sql<number>`count(${peerLoans.id})`.as("loan_count"),
      fulfilledCount: sql<number>`sum(case when ${peerLoans.status} = 'fulfilled' then 1 else 0 end)`.as("fulfilled_count"),
      defaultCount: sql<number>`sum(case when ${peerLoans.defaultedAt} is not null then 1 else 0 end)`.as("default_count"),
    }).from(users).innerJoin(peerLoans, eq(peerLoans.borrowerId, users.id)).where(and(isNotNull(users.groupName), isNotNull(peerLoans.acceptedAt)))
      .groupBy(users.id).as("credit_base");
    const ranked = db.select({
      userId: creditBase.userId,
      username: creditBase.username,
      groupName: creditBase.groupName,
      avatarUrl: creditBase.avatarUrl,
      loanCount: creditBase.loanCount,
      fulfilledCount: creditBase.fulfilledCount,
      defaultCount: creditBase.defaultCount,
      rank: sql<number>`row_number() over (order by ${creditBase.fulfilledCount} desc, ${creditBase.defaultCount} asc, ${creditBase.loanCount} desc, ${creditBase.userId} asc)`.as("rank"),
    }).from(creditBase).as("credit_ranked");
    const total = db.select({ count: sql<number>`count(*)` }).from(ranked).get()?.count ?? 0;
    const items = db.select().from(ranked).orderBy(asc(ranked.rank)).limit(input.pageSize).offset((input.page - 1) * input.pageSize).all();
    const myRank = db.select().from(ranked).where(eq(ranked.userId, ctx.user.id)).get() ?? null;
    return { items, total, totalPages: Math.ceil(total / input.pageSize), page: input.page, pageSize: input.pageSize, myRank };
  }),

  loanVolumeLeaderboard: memberQuery.input(loanVolumeLeaderboardInput).query(({ input, ctx }) => {
    processLoanIncomeInterception();
    const db = getDb();
    const partyColumn = input.side === "borrower" ? peerLoans.borrowerId : peerLoans.lenderId;
    const volumeBase = db.select({
      userId: users.id,
      username: users.username,
      groupName: users.groupName,
      avatarUrl: users.avatarUrl,
      totalPrincipalUnits: sql<number>`sum(${peerLoans.principalUnits})`.as("total_principal_units"),
      loanCount: sql<number>`count(${peerLoans.id})`.as("loan_count"),
    }).from(users)
      .innerJoin(peerLoans, eq(partyColumn, users.id))
      .where(and(isNotNull(users.groupName), sql`trim(${users.groupName}) != ''`, isNotNull(peerLoans.acceptedAt)))
      .groupBy(users.id)
      .as("loan_volume_base");
    const ranked = db.select({
      userId: volumeBase.userId,
      username: volumeBase.username,
      groupName: volumeBase.groupName,
      avatarUrl: volumeBase.avatarUrl,
      totalPrincipalUnits: volumeBase.totalPrincipalUnits,
      loanCount: volumeBase.loanCount,
      rank: sql<number>`row_number() over (order by ${volumeBase.totalPrincipalUnits} desc, ${volumeBase.loanCount} desc, ${volumeBase.userId} asc)`.as("rank"),
    }).from(volumeBase).as("loan_volume_ranked");
    const total = db.select({ count: sql<number>`count(*)` }).from(ranked).get()?.count ?? 0;
    const items = db.select().from(ranked).orderBy(asc(ranked.rank)).limit(input.pageSize).offset((input.page - 1) * input.pageSize).all();
    const myRank = db.select().from(ranked).where(eq(ranked.userId, ctx.user.id)).get() ?? null;
    return { items, total, totalPages: Math.ceil(total / input.pageSize), page: input.page, pageSize: input.pageSize, myRank };
  }),
});
