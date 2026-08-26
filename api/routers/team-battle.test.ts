import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

process.env.SQLITE_PATH = join(tmpdir(), `lucky-team-battle-${process.pid}-${Date.now()}.db`);

describe("team battle router", () => {
  it("locks rosters, escrows bets, hides votes and settles/refunds without creating money", async () => {
    const [{ getDb }, schema, { appRouter }] = await Promise.all([
      import("../queries/connection"), import("../../db/schema"), import("../router"),
    ]);
    const { users, sessions, adminSessions, creditGrants, creditGrantLedger, teamBattleRooms, teamBattleBets, teamBattleFund, teamBattleLedger, transactions } = schema;
    const db = getDb();
    const people = await db.insert(users).values(Array.from({ length: 6 }, (_, index) => ({
      linuxdoId: `battle-${index + 1}`, username: `battle-${index + 1}`, groupName: `战队测试${index + 1}`, balance: 100,
    }))).returning();
    await db.insert(sessions).values(people.map((user, index) => ({ token: `battle-member-${index + 1}`, userId: user.id, expiresAt: new Date(Date.now() + 60_000) })));
    await db.insert(adminSessions).values({ token: "battle-admin", expiresAt: new Date(Date.now() + 60_000) });
    const member = (index: number) => appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: `ld_session=battle-member-${index + 1}` } }), resHeaders: new Headers(),
    });
    const admin = appRouter.createCaller({ req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_admin=battle-admin" } }), resHeaders: new Headers() });
    const anonymous = appRouter.createCaller({ req: new Request("http://localhost/api/trpc"), resHeaders: new Headers() });

    const config = await member(0).teamBattle.config();
    expect(config).toMatchObject({ enabled: true, version: 1 });
    expect(config.modes.map((mode) => [mode.mode, mode.voteThreshold])).toEqual([["1v1", 2], ["3v3", 4], ["5v5", 6]]);
    await expect(anonymous.teamBattle.adminControl()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const room = await member(0).teamBattle.create({ requestId: randomUUID(), mode: "1v1", visibility: "public", expectedConfigVersion: config.version });
    expect(room).toMatchObject({ ownerId: people[0].id, viewer: { player: null }, players: [] });
    await expect(member(0).teamBattle.lockRoster({ roomId: room.id, requestId: randomUUID() })).rejects.toThrow("各满 1 人");
    const ownerSeatRequest = randomUUID();
    await member(0).teamBattle.takeSeat({ roomId: room.id, requestId: ownerSeatRequest, team: "A", seat: 1 });
    await expect(member(0).teamBattle.takeSeat({ roomId: room.id, requestId: ownerSeatRequest, team: "A", seat: 1 })).resolves.toMatchObject({ viewer: { player: { team: "A", seat: 1 } } });
    await expect(member(0).teamBattle.takeSeat({ roomId: room.id, requestId: ownerSeatRequest, team: "B", seat: 1 })).rejects.toThrow("请求编号已用于其他席位");
    expect(await member(1).teamBattle.join({ requestId: randomUUID(), code: room.code! })).toMatchObject({ viewer: { player: null } });
    await member(1).teamBattle.takeSeat({ roomId: room.id, requestId: randomUUID(), team: "B", seat: 1 });
    await member(0).teamBattle.lockRoster({ roomId: room.id, requestId: randomUUID() });
    await expect(member(0).teamBattle.placeBet({ roomId: room.id, requestId: randomUUID(), team: "B", amount: 1 }))
      .rejects.toThrow("只能押自己所在队");

    const betRequest = randomUUID();
    await Promise.all([
      member(2).teamBattle.placeBet({ roomId: room.id, requestId: betRequest, team: "A", amount: 1 }),
      member(2).teamBattle.placeBet({ roomId: room.id, requestId: betRequest, team: "A", amount: 1 }),
    ]);
    await expect(member(2).teamBattle.placeBet({ roomId: room.id, requestId: betRequest, team: "A", amount: 2 }))
      .rejects.toThrow("请求编号已用于其他投注");
    await member(2).teamBattle.placeBet({ roomId: room.id, requestId: randomUUID(), team: "A", amount: 2 });
    await member(3).teamBattle.placeBet({ roomId: room.id, requestId: randomUUID(), team: "B", amount: 10 });
    expect(await db.select().from(teamBattleBets).where(eq(teamBattleBets.roomId, room.id))).toHaveLength(3);
    const beforeVote = await member(4).teamBattle.room({ roomId: room.id });
    expect(beforeVote).toMatchObject({ status: "betting", poolA: 3, poolB: 10, odds: { ready: true, A: { decimal: 4 } } });

    const firstVote = await member(0).teamBattle.vote({ roomId: room.id, requestId: randomUUID(), winnerTeam: "A" });
    expect(firstVote).toMatchObject({ status: "voting", voteProgress: { submitted: 1, threshold: 2 } });
    expect(firstVote.votes).toBeUndefined();
    expect(firstVote.events.find((event) => event.type === "vote_cast")).toMatchObject({ userId: null, requestId: null });
    await expect(member(4).teamBattle.placeBet({ roomId: room.id, requestId: randomUUID(), team: "A", amount: 1 }))
      .rejects.toThrow("投注已关闭");
    const settled = await member(1).teamBattle.vote({ roomId: room.id, requestId: randomUUID(), winnerTeam: "A" });
    expect(settled).toMatchObject({ status: "settled", winnerTeam: "A", losingPoolTaxUnits: 1_000_000, playerTaxUnits: 500_000, platformTaxUnits: 500_000 });
    expect(settled.votes).toHaveLength(2);
    expect((await db.select().from(users).where(eq(users.id, people[2].id)))[0].balance).toBeCloseTo(109, 6);
    expect((await db.select().from(users).where(eq(users.id, people[0].id)))[0].balance).toBeCloseTo(100.25, 6);
    expect((await db.select().from(users).where(eq(users.id, people[1].id)))[0].balance).toBeCloseTo(100.25, 6);
    expect((await db.select().from(teamBattleFund).where(eq(teamBattleFund.id, 1)))[0].balanceUnits).toBe(500_000);
    const finalBalances = (await db.select().from(users)).reduce((sum, user) => sum + user.balance, 0);
    expect(finalBalances + 0.5).toBeCloseTo(600, 6);
    expect((await db.select().from(transactions).where(eq(transactions.kind, "team_battle"))).length).toBeGreaterThan(3);
    expect((await db.select().from(teamBattleLedger).where(eq(teamBattleLedger.roomId, room.id))).reduce((sum, row) => sum + row.amountUnits, 0)).toBe(0);

    const disputed = await member(0).teamBattle.create({ requestId: randomUUID(), mode: "1v1", visibility: "public", expectedConfigVersion: config.version });
    await member(0).teamBattle.takeSeat({ roomId: disputed.id, requestId: randomUUID(), team: "A", seat: 1 });
    await member(1).teamBattle.join({ requestId: randomUUID(), code: disputed.code! });
    await member(1).teamBattle.takeSeat({ roomId: disputed.id, requestId: randomUUID(), team: "B", seat: 1 });
    await member(0).teamBattle.lockRoster({ roomId: disputed.id, requestId: randomUUID() });
    const [refundGrant] = await db.insert(creditGrants).values({
      redemptionId: 20_001,
      codeId: 20_001,
      code: "TEAM-REFUND-TEMP",
      userId: people[4].id,
      originalUnits: 1_000_000,
      remainingUnits: 1_000_000,
      expiresAt: new Date(Date.now() + 60_000),
    }).returning();
    await expect(member(2).teamBattle.placeBet({ roomId: disputed.id, requestId: betRequest, team: "A", amount: 1 }))
      .rejects.toThrow("请求编号已用于其他投注");
    const expiringBetRequest = randomUUID();
    await member(4).teamBattle.placeBet({ roomId: disputed.id, requestId: expiringBetRequest, team: "A", amount: 1 });
    await expect(member(0).teamBattle.vote({ roomId: disputed.id, requestId: randomUUID(), winnerTeam: "A" })).rejects.toThrow("两侧奖池");
    await member(5).teamBattle.placeBet({ roomId: disputed.id, requestId: randomUUID(), team: "B", amount: 1 });
    expect((await db.select().from(creditGrants).where(eq(creditGrants.id, refundGrant.id)))[0]).toMatchObject({ status: "exhausted", remainingUnits: 0 });
    expect((await db.select().from(creditGrantLedger).where(eq(creditGrantLedger.userId, people[4].id)))[0]).toMatchObject({
      sourceKind: "team_battle", requestId: expiringBetRequest, type: "consume", amountUnits: -1_000_000,
    });
    await db.update(creditGrants).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(creditGrants.id, refundGrant.id));
    await member(0).teamBattle.vote({ roomId: disputed.id, requestId: randomUUID(), winnerTeam: "A" });
    const split = await member(1).teamBattle.vote({ roomId: disputed.id, requestId: randomUUID(), winnerTeam: "B" });
    expect(split).toMatchObject({ status: "disputed", votes: undefined });
    const refundRequest = randomUUID();
    await admin.teamBattle.adminRefundDisputed({ roomId: disputed.id, requestId: refundRequest, reason: "测试争议全额退款" });
    await expect(admin.teamBattle.adminRefundDisputed({ roomId: disputed.id, requestId: refundRequest, reason: "测试争议全额退款" }))
      .resolves.toMatchObject({ ok: true, idempotent: true });
    expect((await db.select().from(teamBattleRooms).where(eq(teamBattleRooms.id, disputed.id)))[0].status).toBe("refunded");
    const refundedBets = await db.select().from(teamBattleBets).where(and(eq(teamBattleBets.roomId, disputed.id), eq(teamBattleBets.status, "refunded")));
    expect(refundedBets).toHaveLength(2);
    expect(refundedBets.find((bet) => bet.userId === people[4].id)?.payoutUnits).toBe(0);
    expect(refundedBets.find((bet) => bet.userId === people[5].id)?.payoutUnits).toBe(1_000_000);
    expect((await db.select().from(users).where(eq(users.id, people[4].id)))[0].balance).toBe(99);
    expect((await db.select().from(users).where(eq(users.id, people[5].id)))[0].balance).toBe(100);

    const reopened = await member(0).teamBattle.create({ requestId: randomUUID(), mode: "1v1", visibility: "public", expectedConfigVersion: config.version });
    await member(0).teamBattle.takeSeat({ roomId: reopened.id, requestId: randomUUID(), team: "A", seat: 1 });
    await member(1).teamBattle.join({ requestId: randomUUID(), code: reopened.code! });
    await member(1).teamBattle.takeSeat({ roomId: reopened.id, requestId: randomUUID(), team: "B", seat: 1 });
    await member(0).teamBattle.lockRoster({ roomId: reopened.id, requestId: randomUUID() });
    await member(4).teamBattle.placeBet({ roomId: reopened.id, requestId: randomUUID(), team: "A", amount: 1 });
    await member(5).teamBattle.placeBet({ roomId: reopened.id, requestId: randomUUID(), team: "B", amount: 1 });
    await member(0).teamBattle.vote({ roomId: reopened.id, requestId: randomUUID(), winnerTeam: "A" });
    await member(1).teamBattle.vote({ roomId: reopened.id, requestId: randomUUID(), winnerTeam: "B" });
    const reopenRequest = randomUUID();
    expect(await admin.teamBattle.adminReopenVoting({ roomId: reopened.id, requestId: reopenRequest, reason: "要求全员重新确认" }))
      .toMatchObject({ voteRound: 2, idempotent: false });
    expect(await admin.teamBattle.adminReopenVoting({ roomId: reopened.id, requestId: reopenRequest, reason: "要求全员重新确认" }))
      .toMatchObject({ voteRound: 2, idempotent: true });
    await member(0).teamBattle.vote({ roomId: reopened.id, requestId: randomUUID(), winnerTeam: "A" });
    expect((await member(1).teamBattle.vote({ roomId: reopened.id, requestId: randomUUID(), winnerTeam: "A" })).status).toBe("settled");

    const three = await member(0).teamBattle.create({ requestId: randomUUID(), mode: "3v3", visibility: "public", expectedConfigVersion: config.version });
    await member(0).teamBattle.takeSeat({ roomId: three.id, requestId: randomUUID(), team: "A", seat: 1 });
    await member(1).teamBattle.takeSeat({ roomId: three.id, requestId: randomUUID(), team: "A", seat: 2 });
    await member(2).teamBattle.takeSeat({ roomId: three.id, requestId: randomUUID(), team: "A", seat: 3 });
    await member(3).teamBattle.takeSeat({ roomId: three.id, requestId: randomUUID(), team: "B", seat: 1 });
    await member(4).teamBattle.takeSeat({ roomId: three.id, requestId: randomUUID(), team: "B", seat: 2 });
    await member(5).teamBattle.takeSeat({ roomId: three.id, requestId: randomUUID(), team: "B", seat: 3 });
    await member(0).teamBattle.lockRoster({ roomId: three.id, requestId: randomUUID() });
    await member(0).teamBattle.placeBet({ roomId: three.id, requestId: randomUUID(), team: "A", amount: 1 });
    await member(3).teamBattle.placeBet({ roomId: three.id, requestId: randomUUID(), team: "B", amount: 1 });
    await member(0).teamBattle.vote({ roomId: three.id, requestId: randomUUID(), winnerTeam: "A" });
    await member(1).teamBattle.vote({ roomId: three.id, requestId: randomUUID(), winnerTeam: "A" });
    const threeVotes = await member(2).teamBattle.vote({ roomId: three.id, requestId: randomUUID(), winnerTeam: "A" });
    expect(threeVotes).toMatchObject({ status: "voting", voteProgress: { submitted: 3, threshold: 4 } });
    expect((await member(3).teamBattle.vote({ roomId: three.id, requestId: randomUUID(), winnerTeam: "A" })).status).toBe("settled");

    const page = await admin.teamBattle.adminRoomsPage({ page: 1, pageSize: 1, status: "settled" });
    expect(page).toMatchObject({ total: 3, totalPages: 3 });
    expect((await admin.teamBattle.adminRoom({ roomId: room.id })).ledger.length).toBeGreaterThan(0);
    expect((await admin.teamBattle.adminBetsPage({ page: 1, pageSize: 2, roomId: room.id })).total).toBe(3);
    expect((await admin.teamBattle.adminLedgerPage({ page: 1, pageSize: 2, roomId: room.id })).total).toBeGreaterThan(3);

    const privateRoom = await member(0).teamBattle.create({ requestId: randomUUID(), mode: "3v3", visibility: "private", expectedConfigVersion: config.version });
    expect(privateRoom).toMatchObject({ ownerId: people[0].id, viewer: { player: null } });
    expect(await member(1).teamBattle.join({ requestId: randomUUID(), code: privateRoom.code! })).toMatchObject({ viewer: { player: null } });
    const race = await Promise.allSettled([1, 2].map((index) => member(index).teamBattle.takeSeat({ roomId: privateRoom.id, roomCode: privateRoom.code!, requestId: randomUUID(), team: "A", seat: 1 })));
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winnerIndex = race[0].status === "fulfilled" ? 1 : 2;
    const left = await member(winnerIndex).teamBattle.leaveSeat({ roomId: privateRoom.id, roomCode: privateRoom.code!, requestId: randomUUID() });
    expect(left).toMatchObject({ ownerId: people[0].id, viewer: { player: null }, status: "lobby" });
    await member(0).teamBattle.takeSeat({ roomId: privateRoom.id, requestId: randomUUID(), team: "B", seat: 2 });
    const ownerDown = await member(0).teamBattle.leaveSeat({ roomId: privateRoom.id, requestId: randomUUID() });
    expect(ownerDown).toMatchObject({ ownerId: people[0].id, viewer: { player: null }, status: "lobby" });
    await expect(admin.teamBattle.updateAdminConfig({ enabled: true, singleBetLimit: 5, userBetLimit: 4, roomBetLimit: 50 }))
      .rejects.toThrow("单笔 ≤ 单用户 ≤ 房间总额");
    expect(await admin.teamBattle.updateAdminConfig({ enabled: true, singleBetLimit: 5, userBetLimit: 20, roomBetLimit: 100 }))
      .toMatchObject({ version: 2, singleBetLimitUnits: 5_000_000 });
  });
});
