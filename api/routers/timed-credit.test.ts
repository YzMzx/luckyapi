import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";

process.env.SQLITE_PATH = join(tmpdir(), `lucky-timed-credit-${process.pid}-${Date.now()}.db`);

describe("timed redeem credit grants", () => {
  it("consumes the gross slot stake for winning, break-even and losing rounds", async () => {
    const [{ getDb }, schema, grants] = await Promise.all([
      import("../queries/connection"),
      import("../../db/schema"),
      import("../queries/credit-grants"),
    ]);
    const { users, creditGrants } = schema;
    const db = getDb();
    const players = await db.insert(users).values(["win", "even", "loss"].map((kind) => ({
      linuxdoId: `slot-grant-${kind}`, username: `slot-grant-${kind}`, groupName: `老虎机临时额度-${kind}`, balance: 10,
    }))).returning();
    const expiry = new Date(Date.now() + 24 * 60 * 60_000);
    await db.insert(creditGrants).values(players.map((player, index) => ({
      redemptionId: 10_000 + index,
      codeId: 10_000 + index,
      code: `SLOT-GRANT-${index}`,
      userId: player.id,
      originalUnits: 5_000_000,
      remainingUnits: 5_000_000,
      expiresAt: expiry,
    })));
    const payouts = [4, 2, 0];
    players.forEach((player, index) => db.transaction((tx) => {
      grants.debitUserBalance(tx, { userId: player.id, amount: 2, sourceKind: "slot", requestId: `slot-gross-${index}`, note: "gross stake" });
      if (payouts[index] > 0) tx.update(users).set({ balance: sql`${users.balance} + ${payouts[index]}` }).where(eq(users.id, player.id)).run();
    }));
    const rows = await db.select().from(creditGrants).where(eq(creditGrants.codeId, 10_000)).orderBy(asc(creditGrants.id));
    const allRows = await db.select().from(creditGrants).orderBy(asc(creditGrants.id));
    const slotRows = allRows.filter((row) => row.code.startsWith("SLOT-GRANT-"));
    expect(rows).toHaveLength(1);
    expect(slotRows.map((row) => row.remainingUnits)).toEqual([3_000_000, 3_000_000, 3_000_000]);
    const balances = await Promise.all(players.map(async (player) => (await db.select().from(users).where(eq(users.id, player.id)))[0].balance));
    expect(balances).toEqual([12, 10, 8]);
  });

  it("restores the original temporary and permanent sources without laundering expired credit", async () => {
    const [{ getDb }, schema, grants] = await Promise.all([
      import("../queries/connection"),
      import("../../db/schema"),
      import("../queries/credit-grants"),
    ]);
    const { users, creditGrants, creditGrantLedger } = schema;
    const db = getDb();
    const now = Date.now();
    const people = await db.insert(users).values([
      { linuxdoId: "refund-live", username: "refund-live", groupName: "退款未到期", balance: 8 },
      { linuxdoId: "refund-expired", username: "refund-expired", groupName: "退款已到期", balance: 8 },
    ]).returning();
    const created = await db.insert(creditGrants).values(people.map((person, index) => ({
      redemptionId: 40_001 + index,
      codeId: 40_001 + index,
      code: `REFUND-SOURCE-${index}`,
      userId: person.id,
      originalUnits: 5_000_000,
      remainingUnits: 5_000_000,
      expiresAt: new Date(now + (index === 0 ? 24 * 60 * 60_000 : 60_000)),
    }))).returning();

    for (const [index, person] of people.entries()) db.transaction((tx) => grants.debitUserBalance(tx, {
      userId: person.id,
      amount: 8,
      sourceKind: index === 0 ? "duel" : "team_battle",
      requestId: `refund-source-${index}`,
      note: "escrow debit",
      now: new Date(now),
    }));
    expect((await db.select().from(users).where(eq(users.id, people[0].id)))[0].balance).toBe(0);
    expect((await db.select().from(users).where(eq(users.id, people[1].id)))[0].balance).toBe(0);

    const live = db.transaction((tx) => grants.reverseUserBalanceDebit(tx, {
      userId: people[0].id,
      amount: 8,
      sourceKind: "duel",
      requestId: "refund-source-0",
      note: "live refund",
      now: new Date(now + 30_000),
    }));
    expect(live).toEqual({ credited: 8, permanentRestored: 3, temporaryRestored: 5, expiredTemporary: 0 });
    expect((await db.select().from(users).where(eq(users.id, people[0].id)))[0].balance).toBe(8);
    expect((await db.select().from(creditGrants).where(eq(creditGrants.id, created[0].id)))[0]).toMatchObject({
      status: "active", consumedUnits: 0, remainingUnits: 5_000_000,
    });
    expect((await db.select().from(creditGrantLedger).where(eq(creditGrantLedger.userId, people[0].id))).map((entry) => entry.type))
      .toEqual(["consume", "restore"]);

    const expired = db.transaction((tx) => grants.reverseUserBalanceDebit(tx, {
      userId: people[1].id,
      amount: 8,
      sourceKind: "team_battle",
      requestId: "refund-source-1",
      note: "expired refund",
      now: new Date(now + 61_000),
    }));
    expect(expired).toEqual({ credited: 3, permanentRestored: 3, temporaryRestored: 0, expiredTemporary: 5 });
    expect((await db.select().from(users).where(eq(users.id, people[1].id)))[0].balance).toBe(3);
    expect((await db.select().from(creditGrants).where(eq(creditGrants.id, created[1].id)))[0]).toMatchObject({
      status: "exhausted", consumedUnits: 5_000_000, remainingUnits: 0,
    });
    expect((await db.select().from(creditGrantLedger).where(eq(creditGrantLedger.userId, people[1].id))).map((entry) => entry.type))
      .toEqual(["consume"]);
  });

  it("redeems per account, consumes earliest expiry first and clears only unspent temporary credit", async () => {
    const [{ getDb }, schema, { appRouter }, grants] = await Promise.all([
      import("../queries/connection"),
      import("../../db/schema"),
      import("../router"),
      import("../queries/credit-grants"),
    ]);
    const { users, sessions, adminSessions, inviteCodes, creditGrants, creditGrantLedger } = schema;
    const db = getDb();
    const people = await db.insert(users).values([
      { linuxdoId: "timed-1", username: "timed-1", groupName: "限时一", balance: 10 },
      { linuxdoId: "timed-2", username: "timed-2", groupName: "限时二", balance: 0 },
      { linuxdoId: "timed-3", username: "timed-3", groupName: "永久三", balance: 0 },
      { linuxdoId: "timed-4", username: "timed-4", groupName: "并发四", balance: 2 },
    ]).returning();
    await db.insert(sessions).values(people.map((user, index) => ({ token: `timed-${index}`, userId: user.id, expiresAt: new Date(Date.now() + 60_000) })));
    await db.insert(adminSessions).values({ token: "timed-admin", expiresAt: new Date(Date.now() + 60_000) });
    const member = (index: number) => appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: `ld_session=timed-${index}` } }), resHeaders: new Headers(),
    });
    const admin = appRouter.createCaller({ req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_admin=timed-admin" } }), resHeaders: new Headers() });
    const now = Date.now();
    const firstExpiry = now + 60 * 60_000;
    const secondExpiry = now + 2 * 60 * 60_000;

    const generated = await admin.admin.generateInvites({
      count: 1, type: "redeem", amount: 5, mode: "reusable", maxUses: 2, balanceBelow: null, creditExpiresAt: firstExpiry,
    });
    const firstCode = generated.codes[0];
    expect((await admin.admin.listInvitesPage({ page: 1, pageSize: 20, status: "active", type: "redeem" })).items[0].creditExpiresAt?.getTime()).toBe(firstExpiry);
    await expect(member(0).member.redeemCode({ code: firstCode })).resolves.toMatchObject({ amount: 5, creditExpiresAt: new Date(firstExpiry) });
    await expect(member(0).member.redeemCode({ code: firstCode })).rejects.toThrow("已经兑换过");
    await expect(member(1).member.redeemCode({ code: firstCode })).resolves.toMatchObject({ remainingUses: 0 });

    const [secondCode, permanentCode] = await db.insert(inviteCodes).values([
      { code: "LD-TIMED-LATER", type: "redeem", amount: 5, mode: "single", creditExpiresAt: new Date(secondExpiry) },
      { code: "LD-PERMANENT", type: "redeem", amount: 3, mode: "single", creditExpiresAt: null },
    ]).returning();
    await member(0).member.redeemCode({ code: secondCode.code });
    await expect(member(2).member.redeemCode({ code: permanentCode.code })).resolves.toMatchObject({ creditExpiresAt: null });
    expect((await db.select().from(creditGrants)).filter((grant) => people.some((person) => person.id === grant.userId))).toHaveLength(3);

    const debit = db.transaction((tx) => grants.debitUserBalance(tx, {
      userId: people[0].id, amount: 6, sourceKind: "usage", requestId: "timed-debit", note: "FIFO test",
    }));
    expect(debit).toMatchObject({ balanceBefore: 20, balanceAfter: 14, temporaryConsumed: 6, permanentConsumed: 0 });
    const ordered = await db.select().from(creditGrants).where(eq(creditGrants.userId, people[0].id)).orderBy(asc(creditGrants.expiresAt));
    expect(ordered.map((grant) => [grant.status, grant.consumedUnits, grant.remainingUnits])).toEqual([
      ["exhausted", 5_000_000, 0],
      ["active", 1_000_000, 4_000_000],
    ]);

    const recovery = db.transaction((tx) => grants.expireAllCreditGrants(tx, new Date(secondExpiry + 1)));
    expect(recovery).toMatchObject({ users: 2, grants: 2, units: 9_000_000 });
    const balances = new Map((await db.select({ id: users.id, balance: users.balance }).from(users)).map((row) => [row.id, row.balance]));
    expect(balances.get(people[0].id)).toBe(10);
    expect(balances.get(people[1].id)).toBe(0);
    expect(balances.get(people[2].id)).toBe(3);
    await expect(Promise.resolve().then(() => db.transaction((tx) => grants.debitUserBalance(tx, {
      userId: people[2].id, amount: 4, sourceKind: "adjust", note: "insufficient",
    })))).rejects.toThrow("余额不足");

    const history = await admin.admin.listCodeRedemptionsPage({ page: 1, pageSize: 20 });
    const timedRow = history.items.find((row) => row.code === secondCode.code)!;
    expect(timedRow).toMatchObject({ grantConsumedUnits: 1_000_000, grantRemainingUnits: 0, grantExpiredUnits: 4_000_000, grantStatus: "expired" });

    const [racingCode] = await db.insert(inviteCodes).values({
      code: "LD-TIMED-RACE", type: "redeem", amount: 4, mode: "single", creditExpiresAt: new Date(now + 30 * 60_000),
    }).returning();
    await member(3).member.redeemCode({ code: racingCode.code });
    const concurrent = await Promise.allSettled([
      Promise.resolve().then(() => db.transaction((tx) => grants.debitUserBalance(tx, {
        userId: people[3].id, amount: 3, sourceKind: "usage", requestId: "race-debit", note: "concurrent debit",
      }))),
      Promise.resolve().then(() => db.transaction((tx) => grants.expireUserCreditGrants(tx, people[3].id, new Date(now + 31 * 60_000)))),
    ]);
    expect(concurrent.filter((result) => result.status === "rejected").length).toBeLessThanOrEqual(1);
    expect((await db.select().from(users).where(eq(users.id, people[3].id)))[0].balance).toBe(2);
    const racedGrant = (await db.select().from(creditGrants).where(eq(creditGrants.userId, people[3].id)))[0];
    expect(racedGrant.status).toBe("expired");
    expect(racedGrant.consumedUnits + racedGrant.expiredUnits).toBe(4_000_000);
    expect((await db.select().from(creditGrantLedger)).map((row) => row.type)).toEqual(expect.arrayContaining(["grant", "consume", "expire"]));
  });
});
