import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { duelSeedCommitment, initialBlackjackState, type BlackjackRoomState } from "../queries/duel-engine";
import { blackjackScore } from "@contracts/duel";

process.env.SQLITE_PATH = join(tmpdir(), `lucky-duel-${process.pid}-${Date.now()}.db`);

describe("persistent duel rooms", () => {
  it("settles dice and PVP blackjack atomically with idempotency, limits, recovery and audit", async () => {
    const [{ getDb }, schema, { appRouter }] = await Promise.all([
      import("../queries/connection"),
      import("../../db/schema"),
      import("../router"),
    ]);
    const { users, sessions, adminSessions, adminLogs, creditGrants, creditGrantLedger, duelRooms, duelPlayers, duelRoundResults, duelEvents, duelFund, duelLedger, transactions } = schema;
    const db = getDb();
    const createdUsers = await db.insert(users).values(Array.from({ length: 9 }, (_, index) => ({
      linuxdoId: `duel-${index + 1}`,
      username: `duel-${index + 1}`,
      groupName: `决斗测试${index + 1}`,
      balance: index === 8 ? 0.5 : 100,
    }))).returning();
    await db.insert(sessions).values(createdUsers.map((user, index) => ({
      token: `duel-member-${index + 1}`,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    })));
    await db.insert(adminSessions).values({ token: "duel-admin", expiresAt: new Date(Date.now() + 60_000) });

    const member = (index: number) => appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: `ld_session=duel-member-${index + 1}` } }),
      resHeaders: new Headers(),
    });
    const admin = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_admin=duel-admin" } }),
      resHeaders: new Headers(),
    });
    const anonymous = appRouter.createCaller({ req: new Request("http://localhost/api/trpc"), resHeaders: new Headers() });

    const config = await member(0).duel.config();
    expect(config).toMatchObject({
      version: 1,
      enabled: true,
      games: { dice: true, blackjack: true },
      minPlayers: 2,
      maxPlayers: 6,
      minBet: 0.1,
      maxBet: 5,
      betPrecision: 2,
      blackjackActionWindowSeconds: 60,
    });
    await expect(anonymous.duel.config()).rejects.toThrow("请先登录");

    const custom = await member(2).duel.create({
      requestId: randomUUID(), game: "dice", visibility: "private", bet: 0.75, maxPlayers: 2, expectedConfigVersion: config.version,
    });
    expect(custom.bet).toBe(0.75); // 不在快捷档位中，仍允许范围内自定义金额。
    await expect(member(3).duel.create({
      requestId: randomUUID(), game: "dice", visibility: "private", bet: 0.755, maxPlayers: 2, expectedConfigVersion: config.version,
    })).rejects.toThrow("最多保留 2 位小数");
    await expect(member(3).duel.create({
      requestId: randomUUID(), game: "dice", visibility: "private", bet: 0.01, maxPlayers: 2, expectedConfigVersion: config.version,
    })).rejects.toThrow("自定义押注需在");
    expect((await member(2).duel.leave({ roomId: custom.id, requestId: randomUUID() })).status).toBe("cancelled");

    const createRequest = randomUUID();
    const created = await member(0).duel.create({
      requestId: createRequest, game: "dice", visibility: "public", bet: 1, maxPlayers: 2, expectedConfigVersion: config.version,
    });
    expect(created.seedHash).toHaveLength(64); // 资金托管和开奖之前即公开承诺
    const repeatedCreate = await member(0).duel.create({
      requestId: createRequest, game: "dice", visibility: "public", bet: 1, maxPlayers: 2, expectedConfigVersion: config.version,
    });
    expect(repeatedCreate.id).toBe(created.id);
    await expect(member(1).duel.join({ requestId: createRequest, code: created.code })).rejects.toThrow("请求编号已用于其他决斗操作");
    const joinRequest = randomUUID();
    await member(1).duel.join({ requestId: joinRequest, code: created.code });
    expect((await member(1).duel.join({ requestId: joinRequest, code: created.code })).id).toBe(created.id);
    await member(0).duel.setReady({ roomId: created.id, requestId: randomUUID(), ready: true });
    let diceRoom = await member(1).duel.setReady({ roomId: created.id, requestId: randomUUID(), ready: true });
    expect(diceRoom).toMatchObject({ status: "active", pot: 2 });
    expect(diceRoom.seedHash).toHaveLength(64);
    expect(diceRoom.seedReveal).toBeNull();
    expect((await db.select().from(users).where(eq(users.id, createdUsers[0].id)))[0].balance).toBe(99);

    await db.update(duelRooms).set({ actionDeadlineAt: new Date(Date.now() - 1) }).where(eq(duelRooms.id, created.id));
    diceRoom = await member(1).duel.room({ roomId: created.id });
    expect(diceRoom.events.some((event) => event.type === "dice_auto_rolled")).toBe(true);

    for (let guard = 0; guard < 20 && diceRoom.status === "active"; guard += 1) {
      diceRoom = await member(0).duel.rollDice({ roomId: created.id, requestId: randomUUID() });
    }
    expect(diceRoom.status).toBe("settled");
    expect(diceRoom.seedReveal).toHaveLength(64);
    expect(duelSeedCommitment(diceRoom.seedReveal!, diceRoom.id, "dice", 1)).toBe(diceRoom.seedHash);
    const dicePlayers = await db.select().from(duelPlayers).where(eq(duelPlayers.roomId, created.id));
    expect(dicePlayers.filter((player) => player.status === "winner")).toHaveLength(1);
    expect(dicePlayers.reduce((sum, player) => sum + player.payoutUnits, 0) + diceRoom.feeUnits).toBe(diceRoom.potUnits);
    expect(diceRoom).toMatchObject({
      grossPrizePoolUnits: diceRoom.potUnits,
      winnerTaxUnits: diceRoom.feeUnits,
      netPrizePoolUnits: diceRoom.potUnits - diceRoom.feeUnits,
    });
    expect(dicePlayers.every((player) => player.gameType === "dice" && player.settledNetUnits === player.payoutUnits - player.stakeUnits && ["win", "loss"].includes(player.result) && player.settledAt)).toBe(true);

    // 六人房验证容量、全员原子扣款和唯一赢家/并列加赛直至结算。
    const six = await member(0).duel.create({ requestId: randomUUID(), game: "dice", visibility: "private", bet: 0.5, maxPlayers: 6, expectedConfigVersion: config.version });
    await Promise.all(Array.from({ length: 5 }, (_, offset) => member(offset + 1).duel.join({ requestId: randomUUID(), code: six.code })));
    for (let index = 0; index < 5; index += 1) await member(index).duel.setReady({ roomId: six.id, requestId: randomUUID(), ready: true });
    let sixRoom = await member(5).duel.setReady({ roomId: six.id, requestId: randomUUID(), ready: true });
    expect(sixRoom.players).toHaveLength(6);
    expect(sixRoom.pot).toBe(3);
    for (let guard = 0; guard < 20 && sixRoom.status === "active"; guard += 1) sixRoom = await member(0).duel.rollDice({ roomId: six.id, requestId: randomUUID() });
    expect(sixRoom.status).toBe("settled");

    // 回归：二十一点 0.5 局的 3 元是六人总奖池，每名玩家只能扣 0.5，重复就绪不得重复托管。
    const balancesBeforeHalfBlackjack = await Promise.all(createdUsers.slice(0, 6).map(async (user) => Number((await db.select({ balance: users.balance }).from(users).where(eq(users.id, user.id)))[0].balance)));
    const halfBlackjack = await member(0).duel.create({ requestId: randomUUID(), game: "blackjack", visibility: "private", bet: 0.5, maxPlayers: 6, expectedConfigVersion: config.version });
    await Promise.all(Array.from({ length: 5 }, (_, offset) => member(offset + 1).duel.join({ requestId: randomUUID(), code: halfBlackjack.code })));
    for (let index = 0; index < 5; index += 1) await member(index).duel.setReady({ roomId: halfBlackjack.id, requestId: randomUUID(), ready: true });
    const finalReadyRequest = randomUUID();
    const halfBlackjackActive = await member(5).duel.setReady({ roomId: halfBlackjack.id, requestId: finalReadyRequest, ready: true });
    await member(5).duel.setReady({ roomId: halfBlackjack.id, requestId: finalReadyRequest, ready: true });
    expect(halfBlackjackActive).toMatchObject({ status: "active", bet: 0.5, pot: 3 });
    const halfBlackjackStakeRows = await db.select().from(duelLedger).where(and(eq(duelLedger.roomId, halfBlackjack.id), eq(duelLedger.type, "stake")));
    expect(halfBlackjackStakeRows).toHaveLength(6);
    expect(halfBlackjackStakeRows.every((row) => row.amountUnits === -500_000)).toBe(true);
    const balancesAfterHalfBlackjack = await Promise.all(createdUsers.slice(0, 6).map(async (user) => Number((await db.select({ balance: users.balance }).from(users).where(eq(users.id, user.id)))[0].balance)));
    balancesAfterHalfBlackjack.forEach((balance, index) => expect(balancesBeforeHalfBlackjack[index] - balance).toBeCloseTo(0.5, 6));

    // 同一房间进入第二回合时再次且仅再次扣一份底注；操作和轮询都不能产生额外 stake。
    let halfRound = halfBlackjackActive;
    for (let guard = 0; guard < 24 && halfRound.status === "active"; guard += 1) {
      const acting = halfRound.players.find((player) => player.status === "acting");
      if (!acting) break;
      const memberIndex = createdUsers.findIndex((user) => user.id === acting.userId);
      halfRound = await member(memberIndex).duel.blackjackAction({ roomId: halfBlackjack.id, requestId: randomUUID(), action: "stand" });
    }
    expect(halfRound.status).toBe("settled");
    const balancesBeforeHalfBlackjackRoundTwo = await Promise.all(createdUsers.slice(0, 6).map(async (user) => Number((await db.select({ balance: users.balance }).from(users).where(eq(users.id, user.id)))[0].balance)));
    for (let index = 0; index < 5; index += 1) await member(index).duel.setReady({ roomId: halfBlackjack.id, requestId: randomUUID(), ready: true });
    const halfBlackjackRoundTwo = await member(5).duel.setReady({ roomId: halfBlackjack.id, requestId: randomUUID(), ready: true });
    expect(halfBlackjackRoundTwo).toMatchObject({ status: "active", roundNo: 2, bet: 0.5, pot: 3 });
    const balancesAfterHalfBlackjackRoundTwo = await Promise.all(createdUsers.slice(0, 6).map(async (user) => Number((await db.select({ balance: users.balance }).from(users).where(eq(users.id, user.id)))[0].balance)));
    balancesAfterHalfBlackjackRoundTwo.forEach((balance, index) => expect(balancesBeforeHalfBlackjackRoundTwo[index] - balance).toBeCloseTo(0.5, 6));
    const halfBlackjackAllStakeRows = await db.select().from(duelLedger).where(and(eq(duelLedger.roomId, halfBlackjack.id), eq(duelLedger.type, "stake")));
    expect(halfBlackjackAllStakeRows).toHaveLength(12);
    for (const roundNo of [1, 2]) for (const user of createdUsers.slice(0, 6)) {
      expect(halfBlackjackAllStakeRows.filter((row) => row.requestId === `duel:${halfBlackjack.id}:${roundNo}:${user.id}:stake`)).toHaveLength(1);
    }

    const transfer = await member(4).duel.create({ requestId: randomUUID(), game: "dice", visibility: "private", bet: 0.5, maxPlayers: 2, expectedConfigVersion: config.version });
    await member(5).duel.join({ requestId: randomUUID(), code: transfer.code });
    const leaveRequest = randomUUID();
    const transferred = await member(4).duel.leave({ roomId: transfer.id, requestId: leaveRequest });
    expect(transferred.ownerId).toBe(createdUsers[5].id);
    expect((await member(4).duel.leave({ roomId: transfer.id, requestId: leaveRequest })).ownerId).toBe(createdUsers[5].id);
    const cancelled = await member(5).duel.leave({ roomId: transfer.id, requestId: randomUUID() });
    expect(cancelled.status).toBe("cancelled");

    // 二十一点状态持久化；通过手动设置一副可审计测试牌让两人依次爆牌，必须全额退款。
    const blackjack = await member(6).duel.create({ requestId: randomUUID(), game: "blackjack", visibility: "public", bet: 1, maxPlayers: 2, expectedConfigVersion: config.version });
    await member(7).duel.join({ requestId: randomUUID(), code: blackjack.code });
    await member(6).duel.setReady({ roomId: blackjack.id, requestId: randomUUID(), ready: true });
    const testSeed = Array.from({ length: 100 }, (_, index) => index.toString(16).padStart(64, "0")).find((seed) => {
      const state = initialBlackjackState(seed, blackjack.id, 1, [1, 2]);
      return [1, 2].some((seat) => blackjackScore(state.hands[seat]).score !== 21);
    })!;
    await db.update(duelRooms).set({ seedSecret: testSeed, seedHash: duelSeedCommitment(testSeed, blackjack.id, "blackjack", 1) }).where(eq(duelRooms.id, blackjack.id));
    let blackjackRoom = await member(7).duel.setReady({ roomId: blackjack.id, requestId: randomUUID(), ready: true });
    const recovered = await member(6).duel.room({ roomId: blackjack.id });
    expect(recovered.id).toBe(blackjack.id); // 新 caller 可恢复，无内存房间状态依赖
    expect(recovered.stateJson).toBeUndefined();
    if (recovered.status === "active") {
      const mySeat = recovered.players.find((player) => player.userId === createdUsers[6].id)!.seat;
      const hands = (recovered.state as { hands: Record<string, unknown[]> }).hands;
      expect(hands[String(mySeat)].every((card) => typeof card === "string")).toBe(true);
      expect(Object.entries(hands).filter(([seat]) => Number(seat) !== mySeat).every(([, cards]) => cards.every((card) => card === null))).toBe(true);
      const opponent = recovered.players.find((player) => player.userId === createdUsers[7].id)!;
      expect(opponent).toMatchObject({ hand: null, score: null, result: "pending" });
      expect(["acting", "completed"]).toContain(opponent.status);
    }
    const orderedPlayers = (await db.select().from(duelPlayers).where(eq(duelPlayers.roomId, blackjack.id))).sort((a, b) => a.seat - b.seat);
    for (const player of orderedPlayers) await db.update(duelPlayers).set({ status: "active" }).where(eq(duelPlayers.id, player.id));
    await db.update(duelRooms).set({ status: "active", currentSeat: orderedPlayers[0].seat, actionDeadlineAt: new Date(Date.now() - 1), finishedAt: null, seedReveal: null }).where(eq(duelRooms.id, blackjack.id));
    await member(6).duel.room({ roomId: blackjack.id });
    expect((await db.select().from(duelEvents).where(eq(duelEvents.roomId, blackjack.id))).some((event) => event.type === "blackjack_auto_stand")).toBe(true);
    const [allBustGrant] = await db.insert(creditGrants).values({
      redemptionId: 30_001,
      codeId: 30_001,
      code: "DUEL-ALL-BUST-TEMP",
      userId: createdUsers[6].id,
      originalUnits: 1_000_000,
      remainingUnits: 1_000_000,
      expiresAt: new Date(Date.now() + 60_000),
    }).returning();
    const nextLobby = await member(6).duel.setReady({ roomId: blackjack.id, requestId: randomUUID(), ready: true });
    expect(nextLobby).toMatchObject({ status: "lobby", roundNo: 2 });
    await member(7).duel.setReady({ roomId: blackjack.id, requestId: randomUUID(), ready: true });
    expect((await db.select().from(creditGrants).where(eq(creditGrants.id, allBustGrant.id)))[0]).toMatchObject({ status: "exhausted", remainingUnits: 0 });
    expect((await db.select().from(creditGrantLedger).where(eq(creditGrantLedger.userId, createdUsers[6].id)))[0]).toMatchObject({
      sourceKind: "duel", requestId: `duel:${blackjack.id}:2:${createdUsers[6].id}:stake`, type: "consume", amountUnits: -1_000_000,
    });
    await db.update(creditGrants).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(creditGrants.id, allBustGrant.id));
    const duelFundBeforeExpiredRefund = (await db.select().from(duelFund).where(eq(duelFund.id, 1)))[0].balanceUnits;
    const forced: BlackjackRoomState = {
      kind: "blackjack",
      deck: ["2S", "2H", "2D", "2C", "KS", "KH"],
      cursor: 4,
      hands: { [orderedPlayers[0].seat]: ["10S", "QH"], [orderedPlayers[1].seat]: ["10D", "QC"] },
      actions: [],
    };
    await db.update(duelRooms).set({ stateJson: JSON.stringify(forced), currentSeat: orderedPlayers[0].seat, actionDeadlineAt: new Date(Date.now() + 60_000) }).where(eq(duelRooms.id, blackjack.id));
    for (const player of orderedPlayers) await db.update(duelPlayers).set({ status: "active", score: 20, handJson: JSON.stringify(forced.hands[player.seat]) }).where(eq(duelPlayers.id, player.id));
    blackjackRoom = await member(6).duel.blackjackAction({ roomId: blackjack.id, requestId: randomUUID(), action: "hit" });
    expect(blackjackRoom.status).toBe("active");
    const opponentView = await member(7).duel.room({ roomId: blackjack.id });
    expect(opponentView.players.find((player) => player.userId === createdUsers[6].id)).toMatchObject({ hand: null, score: null, status: "completed", result: "pending" });
    const hiddenAction = opponentView.events.find((event) => event.type === "blackjack_action" && event.userId === createdUsers[6].id);
    expect(hiddenAction?.payload).toEqual(expect.objectContaining({ completed: true }));
    expect(hiddenAction?.payload).not.toHaveProperty("card");
    expect(hiddenAction?.payload).not.toHaveProperty("score");
    blackjackRoom = await member(7).duel.blackjackAction({ roomId: blackjack.id, requestId: randomUUID(), action: "hit" });
    expect(blackjackRoom.status).toBe("refunded");
    expect(blackjackRoom.players.find((player) => player.userId === createdUsers[6].id)).toMatchObject({ payout: 0, status: "refunded" });
    expect(blackjackRoom.players.find((player) => player.userId === createdUsers[7].id)).toMatchObject({ payout: 1, status: "refunded" });
    const refundedPlayers = await db.select().from(duelPlayers).where(eq(duelPlayers.roomId, blackjack.id));
    expect(refundedPlayers.every((player) => player.result === "refund" && player.voidedAt)).toBe(true);
    expect(refundedPlayers.find((player) => player.userId === createdUsers[6].id)?.settledNetUnits).toBe(-1_000_000);
    expect((await db.select().from(duelFund).where(eq(duelFund.id, 1)))[0].balanceUnits).toBe(duelFundBeforeExpiredRefund + 1_000_000);
    const blackjackHistory = await db.select().from(duelRoundResults).where(eq(duelRoundResults.roomId, blackjack.id));
    expect(blackjackHistory).toHaveLength(4);
    expect([...new Set(blackjackHistory.map((row) => row.roundNo))]).toEqual([1, 2]);

    // 余额不足在最后一人准备时整笔回滚：不扣任何人，触发者的 ready 也不落库。
    const poor = await member(8).duel.create({ requestId: randomUUID(), game: "dice", visibility: "private", bet: 5, maxPlayers: 2, expectedConfigVersion: config.version });
    await member(7).duel.join({ requestId: randomUUID(), code: poor.code });
    await member(8).duel.setReady({ roomId: poor.id, requestId: randomUUID(), ready: true });
    const richBefore = (await db.select().from(users).where(eq(users.id, createdUsers[7].id)))[0].balance;
    await expect(member(7).duel.setReady({ roomId: poor.id, requestId: randomUUID(), ready: true })).rejects.toThrow("余额不足");
    expect((await db.select().from(users).where(eq(users.id, createdUsers[7].id)))[0].balance).toBe(richBefore);
    expect((await db.select().from(duelPlayers).where(and(eq(duelPlayers.roomId, poor.id), eq(duelPlayers.userId, createdUsers[7].id))))[0].ready).toBe(false);

    // 后台配置是不可变新版本，权限受保护；0/100% 平台费边界均可精确保存。
    await expect(anonymous.admin.updateDuelConfig({
      enabled: true, diceEnabled: true, blackjackEnabled: true, feeBasisPoints: 0, betOptions: [1], minPlayers: 2, maxPlayers: 6,
      roomTimeoutSeconds: 1800, actionTimeoutSeconds: 60, singleBetLimit: 1, dailyStakeLimit: 10, dailyNetLossLimit: 10,
    })).rejects.toThrow("需要管理员登录");
    const zeroFee = await admin.admin.updateDuelConfig({
      enabled: true, diceEnabled: true, blackjackEnabled: true, feeBasisPoints: 0, betOptions: [1], minPlayers: 2, maxPlayers: 6,
      roomTimeoutSeconds: 1800, actionTimeoutSeconds: 60, singleBetLimit: 1, dailyStakeLimit: 10, dailyNetLossLimit: 10,
    });
    expect(zeroFee.version).toBe(2);
    const zeroRoom = await member(2).duel.create({ requestId: randomUUID(), game: "dice", visibility: "private", bet: 1, maxPlayers: 2, expectedConfigVersion: zeroFee.version });
    await member(3).duel.join({ requestId: randomUUID(), code: zeroRoom.code });
    await member(2).duel.setReady({ roomId: zeroRoom.id, requestId: randomUUID(), ready: true });
    let zeroSettled = await member(3).duel.setReady({ roomId: zeroRoom.id, requestId: randomUUID(), ready: true });
    for (let guard = 0; guard < 20 && zeroSettled.status === "active"; guard += 1) zeroSettled = await member(2).duel.rollDice({ roomId: zeroRoom.id, requestId: randomUUID() });
    expect(zeroSettled.feeUnits).toBe(0);
    expect(zeroSettled.players.reduce((sum, player) => sum + player.payoutUnits, 0)).toBe(zeroSettled.potUnits);

    const tieRoom = await member(4).duel.create({ requestId: randomUUID(), game: "blackjack", visibility: "private", bet: 1, maxPlayers: 2, expectedConfigVersion: zeroFee.version });
    await member(5).duel.join({ requestId: randomUUID(), code: tieRoom.code });
    await member(4).duel.setReady({ roomId: tieRoom.id, requestId: randomUUID(), ready: true });
    const tieSeed = Array.from({ length: 100 }, (_, index) => (index + 100).toString(16).padStart(64, "0")).find((seed) => {
      const state = initialBlackjackState(seed, tieRoom.id, 1, [1, 2]);
      return [1, 2].some((seat) => blackjackScore(state.hands[seat]).score !== 21);
    })!;
    await db.update(duelRooms).set({ seedSecret: tieSeed, seedHash: duelSeedCommitment(tieSeed, tieRoom.id, "blackjack", 1) }).where(eq(duelRooms.id, tieRoom.id));
    await member(5).duel.setReady({ roomId: tieRoom.id, requestId: randomUUID(), ready: true });
    const tiePlayers = (await db.select().from(duelPlayers).where(eq(duelPlayers.roomId, tieRoom.id))).sort((a, b) => a.seat - b.seat);
    const tiedState: BlackjackRoomState = {
      kind: "blackjack", deck: ["2S"], cursor: 0,
      hands: { [tiePlayers[0].seat]: ["10S", "QH"], [tiePlayers[1].seat]: ["10D", "QC"] }, actions: [],
    };
    await db.update(duelRooms).set({ status: "active", stateJson: JSON.stringify(tiedState), currentSeat: tiePlayers[0].seat, actionDeadlineAt: new Date(Date.now() + 60_000), finishedAt: null, seedReveal: null }).where(eq(duelRooms.id, tieRoom.id));
    for (const player of tiePlayers) await db.update(duelPlayers).set({ status: "active", score: 20, handJson: JSON.stringify(tiedState.hands[player.seat]) }).where(eq(duelPlayers.id, player.id));
    await member(4).duel.blackjackAction({ roomId: tieRoom.id, requestId: randomUUID(), action: "stand" });
    const tied = await member(5).duel.blackjackAction({ roomId: tieRoom.id, requestId: randomUUID(), action: "stand" });
    expect(tied.status).toBe("settled");
    expect(tied.players.every((player) => player.status === "winner" && player.payout === 1)).toBe(true);

    const fullFee = await admin.admin.updateDuelConfig({
      enabled: true, diceEnabled: true, blackjackEnabled: true, feeBasisPoints: 10_000, betOptions: [1], minPlayers: 2, maxPlayers: 6,
      roomTimeoutSeconds: 1800, actionTimeoutSeconds: 5, singleBetLimit: 1, dailyStakeLimit: 10, dailyNetLossLimit: 10,
    });
    expect(fullFee.version).toBe(3);
    const fullRoom = await member(6).duel.create({ requestId: randomUUID(), game: "dice", visibility: "private", bet: 1, maxPlayers: 2, expectedConfigVersion: fullFee.version });
    await member(7).duel.join({ requestId: randomUUID(), code: fullRoom.code });
    await member(6).duel.setReady({ roomId: fullRoom.id, requestId: randomUUID(), ready: true });
    let fullSettled = await member(7).duel.setReady({ roomId: fullRoom.id, requestId: randomUUID(), ready: true });
    for (let guard = 0; guard < 20 && fullSettled.status === "active"; guard += 1) fullSettled = await member(6).duel.rollDice({ roomId: fullRoom.id, requestId: randomUUID() });
    expect(fullSettled.fee).toBe(2);
    expect(fullSettled).toMatchObject({ grossPrizePool: 2, winnerTax: 2, netPrizePool: 0, winnerTaxPercent: 100 });
    expect(fullSettled.players.filter((player) => player.status === "winner")).toHaveLength(1);
    expect(fullSettled.players.reduce((sum, player) => sum + player.payoutUnits, 0)).toBe(0);

    const limited = await admin.admin.updateDuelConfig({
      enabled: true, diceEnabled: true, blackjackEnabled: true, feeBasisPoints: 300, betOptions: [1], minPlayers: 2, maxPlayers: 6,
      roomTimeoutSeconds: 1800, actionTimeoutSeconds: 60, singleBetLimit: 1, dailyStakeLimit: 1, dailyNetLossLimit: 1,
    });
    const limitedRoom = await member(0).duel.create({ requestId: randomUUID(), game: "dice", visibility: "private", bet: 1, maxPlayers: 2, expectedConfigVersion: limited.version });
    await member(1).duel.join({ requestId: randomUUID(), code: limitedRoom.code });
    await member(0).duel.setReady({ roomId: limitedRoom.id, requestId: randomUUID(), ready: true });
    await expect(member(1).duel.setReady({ roomId: limitedRoom.id, requestId: randomUUID(), ready: true })).rejects.toThrow("每日押注上限");

    const lossLimited = await admin.admin.updateDuelConfig({
      enabled: true, diceEnabled: true, blackjackEnabled: true, feeBasisPoints: 300, betOptions: [1], minPlayers: 2, maxPlayers: 6,
      roomTimeoutSeconds: 1800, actionTimeoutSeconds: 60, singleBetLimit: 1, dailyStakeLimit: 100, dailyNetLossLimit: 1,
    });
    const lossRoom = await member(6).duel.create({ requestId: randomUUID(), game: "dice", visibility: "private", bet: 1, maxPlayers: 2, expectedConfigVersion: lossLimited.version });
    await member(7).duel.join({ requestId: randomUUID(), code: lossRoom.code });
    await member(6).duel.setReady({ roomId: lossRoom.id, requestId: randomUUID(), ready: true });
    await expect(member(7).duel.setReady({ roomId: lossRoom.id, requestId: randomUUID(), ready: true })).rejects.toThrow("每日净亏损保护线");

    const initialTotalUnits = 8 * 100_000_000 + 500_000;
    const userUnits = Math.round((await db.select().from(users)).reduce((sum, user) => sum + user.balance, 0) * 1_000_000);
    const fundUnits = (await db.select().from(duelFund).where(eq(duelFund.id, 1)))[0].balanceUnits;
    const activePotUnits = (await db.select().from(duelRooms)).filter((room) => room.status === "active").reduce((sum, room) => sum + room.potUnits, 0);
    expect(userUnits + fundUnits + activePotUnits).toBe(initialTotalUnits);
    expect((await db.select().from(duelEvents)).length).toBeGreaterThan(10);
    expect((await db.select().from(duelLedger)).length).toBeGreaterThan(10);
    expect((await db.select().from(duelLedger)).some((row) => row.type === "winner_tax")).toBe(true);
    expect((await db.select().from(transactions).where(eq(transactions.kind, "duel"))).length).toBeGreaterThan(10);
    expect((await member(6).member.myTransactions({ page: 1, kind: "duel" })).rows.length).toBeGreaterThan(0);
    expect((await db.select().from(adminLogs)).filter((row) => row.action === "更新决斗场配置")).toHaveLength(4);
    expect((await admin.admin.getDuelRoom({ roomId: blackjack.id })).events.some((event) => event.type === "refunded")).toBe(true);
  });
});
