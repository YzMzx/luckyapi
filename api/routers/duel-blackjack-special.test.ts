import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  BLACKJACK_PVP_RULES,
  BLACKJACK_RULE_VERSION,
  duelDollarsToUnits,
  evaluateBlackjackHand,
  type DuelCard,
} from "@contracts/duel";
import { duelSeedCommitment, initialBlackjackState, type BlackjackRoomState } from "../queries/duel-engine";

process.env.SQLITE_PATH = join(tmpdir(), `lucky-duel-special-${process.pid}-${Date.now()}.db`);

describe("PVP blackjack special hands", () => {
  it("keeps special-hand comparison private until reveal and settles only from the shared pot", async () => {
    const [{ getDb }, schema, { appRouter }] = await Promise.all([
      import("../queries/connection"),
      import("../../db/schema"),
      import("../router"),
    ]);
    const { users, sessions, duelRooms, duelPlayers, duelRoundResults, duelEvents, duelFund } = schema;
    const db = getDb();
    const created = await db.insert(users).values([
      { linuxdoId: "special-one", username: "special-one", groupName: "特殊牌一", balance: 10 },
      { linuxdoId: "special-two", username: "special-two", groupName: "特殊牌二", balance: 10 },
    ]).returning();
    await db.insert(sessions).values(created.map((user, index) => ({
      token: `duel-special-${index + 1}`,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    })));
    const member = (index: number) => appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: `ld_session=duel-special-${index + 1}` } }),
      resHeaders: new Headers(),
    });
    const config = await member(0).duel.config();
    expect(config.rules.blackjackDetails).toEqual(BLACKJACK_PVP_RULES);

    const room = await member(0).duel.create({
      requestId: randomUUID(), game: "blackjack", visibility: "private", bet: 1, maxPlayers: 2, expectedConfigVersion: config.version,
    });
    await member(1).duel.join({ requestId: randomUUID(), code: room.code });
    await member(0).duel.setReady({ roomId: room.id, requestId: randomUUID(), ready: true });
    const testSeed = Array.from({ length: 100 }, (_, index) => index.toString(16).padStart(64, "0")).find((seed) => {
      const state = initialBlackjackState(seed, room.id, 1, [1, 2]);
      return [1, 2].some((seat) => !evaluateBlackjackHand(state.hands[seat]).automaticStand);
    })!;
    await db.update(duelRooms).set({ seedSecret: testSeed, seedHash: duelSeedCommitment(testSeed, room.id, "blackjack", 1) }).where(eq(duelRooms.id, room.id));
    await member(1).duel.setReady({ roomId: room.id, requestId: randomUUID(), ready: true });
    const seats = (await db.select().from(duelPlayers).where(eq(duelPlayers.roomId, room.id))).sort((a, b) => a.seat - b.seat);

    const doubleAces = ["AS", "AH"] satisfies DuelCard[];
    const natural = ["AC", "KH"] satisfies DuelCard[];
    const firstState: BlackjackRoomState = {
      kind: "blackjack",
      ruleVersion: BLACKJACK_RULE_VERSION,
      deck: ["2S"],
      cursor: 0,
      hands: { [seats[0].seat]: doubleAces, [seats[1].seat]: natural },
      evaluations: {
        [seats[0].seat]: evaluateBlackjackHand(doubleAces),
        [seats[1].seat]: evaluateBlackjackHand(natural),
      },
      actions: [],
    };
    await db.update(duelRooms).set({ status: "active", stateJson: JSON.stringify(firstState), actionDeadlineAt: new Date(Date.now() + 60_000) }).where(eq(duelRooms.id, room.id));
    await db.update(duelPlayers).set({
      status: "active", score: 12, handJson: JSON.stringify(doubleAces), handRankJson: JSON.stringify(evaluateBlackjackHand(doubleAces)),
    }).where(eq(duelPlayers.id, seats[0].id));
    await db.update(duelPlayers).set({
      status: "stood", score: 21, handJson: JSON.stringify(natural), handRankJson: JSON.stringify(evaluateBlackjackHand(natural)),
    }).where(eq(duelPlayers.id, seats[1].id));

    const concealed = await member(1).duel.room({ roomId: room.id });
    expect(concealed.players.find((player) => player.seat === seats[0].seat)).toMatchObject({ hand: null, handRank: null, score: null });
    const settled = await member(0).duel.blackjackAction({ roomId: room.id, requestId: randomUUID(), action: "stand" });
    expect(settled).toMatchObject({ status: "settled", fairness: { blackjackRule: BLACKJACK_PVP_RULES } });
    expect(settled.players.find((player) => player.seat === seats[0].seat)).toMatchObject({
      status: "winner", handRank: { category: "double_aces", ruleVersion: BLACKJACK_RULE_VERSION },
    });
    expect(settled.players.find((player) => player.seat === seats[1].seat)).toMatchObject({
      status: "lost", handRank: { category: "natural_blackjack", ruleVersion: BLACKJACK_RULE_VERSION },
    });
    expect(settled.players.reduce((sum, player) => sum + player.payoutUnits, 0) + settled.feeUnits).toBe(settled.potUnits);

    const settlementEvent = (await db.select().from(duelEvents).where(eq(duelEvents.roomId, room.id)))
      .find((event) => event.type === "settled")!;
    const settlementPayload = JSON.parse(settlementEvent.payloadJson) as {
      blackjackRule: typeof BLACKJACK_PVP_RULES;
      handRanks: Array<{ seat: number; evaluation: { category: string } }>;
      winningHandRank: { category: string };
    };
    expect(settlementPayload.blackjackRule).toEqual(BLACKJACK_PVP_RULES);
    expect(settlementPayload.winningHandRank.category).toBe("double_aces");
    expect(settlementPayload.handRanks.map((row) => row.evaluation.category)).toEqual(["double_aces", "natural_blackjack"]);

    // 下一局验证第五张命中五小时立即完成，且揭牌前仍不泄露判型。
    await member(0).duel.setReady({ roomId: room.id, requestId: randomUUID(), ready: true });
    await member(1).duel.setReady({ roomId: room.id, requestId: randomUUID(), ready: true });
    const fourCards = ["2S", "3H", "2D", "3C"] satisfies DuelCard[];
    const twenty = ["10D", "QH"] satisfies DuelCard[];
    const secondState: BlackjackRoomState = {
      kind: "blackjack", ruleVersion: BLACKJACK_RULE_VERSION, deck: ["6S"], cursor: 0,
      hands: { [seats[0].seat]: fourCards, [seats[1].seat]: twenty },
      evaluations: {
        [seats[0].seat]: evaluateBlackjackHand(fourCards),
        [seats[1].seat]: evaluateBlackjackHand(twenty),
      },
      actions: [],
    };
    await db.update(duelRooms).set({ status: "active", stateJson: JSON.stringify(secondState), actionDeadlineAt: new Date(Date.now() + 60_000) }).where(eq(duelRooms.id, room.id));
    await db.update(duelPlayers).set({ status: "active", score: 10, handJson: JSON.stringify(fourCards), handRankJson: JSON.stringify(evaluateBlackjackHand(fourCards)) }).where(eq(duelPlayers.id, seats[0].id));
    await db.update(duelPlayers).set({ status: "active", score: 20, handJson: JSON.stringify(twenty), handRankJson: JSON.stringify(evaluateBlackjackHand(twenty)) }).where(eq(duelPlayers.id, seats[1].id));
    const afterFifth = await member(0).duel.blackjackAction({ roomId: room.id, requestId: randomUUID(), action: "hit" });
    expect(afterFifth.players.find((player) => player.seat === seats[0].seat)).toMatchObject({
      status: "stood", handRank: { category: "five_card_charlie", cardCount: 5, automaticStand: true },
    });
    const stillConcealed = await member(1).duel.room({ roomId: room.id });
    expect(stillConcealed.players.find((player) => player.seat === seats[0].seat)).toMatchObject({ handRank: null, score: null });
    const fiveCardWins = await member(1).duel.blackjackAction({ roomId: room.id, requestId: randomUUID(), action: "stand" });
    expect(fiveCardWins.players.find((player) => player.seat === seats[0].seat)).toMatchObject({ status: "winner", handRank: { category: "five_card_charlie" } });
    expect(fiveCardWins.players.reduce((sum, player) => sum + player.payoutUnits, 0) + fiveCardWins.feeUnits).toBe(fiveCardWins.potUnits);

    // 同级特殊牌型只平分已有税后奖池，不套用庄家赔率。
    await member(0).duel.setReady({ roomId: room.id, requestId: randomUUID(), ready: true });
    await member(1).duel.setReady({ roomId: room.id, requestId: randomUUID(), ready: true });
    const naturalOne = ["AS", "KH"] satisfies DuelCard[];
    const naturalTwo = ["AC", "QD"] satisfies DuelCard[];
    const tiedSpecialState: BlackjackRoomState = {
      kind: "blackjack", ruleVersion: BLACKJACK_RULE_VERSION, deck: ["2S"], cursor: 0,
      hands: { [seats[0].seat]: naturalOne, [seats[1].seat]: naturalTwo },
      evaluations: {
        [seats[0].seat]: evaluateBlackjackHand(naturalOne),
        [seats[1].seat]: evaluateBlackjackHand(naturalTwo),
      },
      actions: [],
    };
    await db.update(duelRooms).set({ status: "active", stateJson: JSON.stringify(tiedSpecialState), actionDeadlineAt: new Date(Date.now() + 60_000) }).where(eq(duelRooms.id, room.id));
    for (const [index, cards] of [naturalOne, naturalTwo].entries()) {
      await db.update(duelPlayers).set({
        status: "active", score: 21, handJson: JSON.stringify(cards), handRankJson: JSON.stringify(evaluateBlackjackHand(cards)),
      }).where(eq(duelPlayers.id, seats[index].id));
    }
    await member(0).duel.blackjackAction({ roomId: room.id, requestId: randomUUID(), action: "stand" });
    const tiedSpecials = await member(1).duel.blackjackAction({ roomId: room.id, requestId: randomUUID(), action: "stand" });
    expect(tiedSpecials.players.every((player) => player.status === "winner" && player.handRank?.category === "natural_blackjack")).toBe(true);
    expect(tiedSpecials.players.reduce((sum, player) => sum + player.payoutUnits, 0) + tiedSpecials.feeUnits).toBe(tiedSpecials.potUnits);

    const snapshots = await db.select().from(duelRoundResults).where(eq(duelRoundResults.roomId, room.id));
    expect(snapshots).toHaveLength(6);
    expect(snapshots.every((row) => JSON.parse(row.handRankJson).ruleVersion === BLACKJACK_RULE_VERSION)).toBe(true);

    // 所有玩家的初始牌和并行 hit 都消费同一副 52 张牌的唯一全局 cursor。
    const uniqueRoom = await member(0).duel.create({
      requestId: randomUUID(), game: "blackjack", visibility: "private", bet: 1, maxPlayers: 2, expectedConfigVersion: config.version,
    });
    await member(1).duel.join({ requestId: randomUUID(), code: uniqueRoom.code });
    await member(0).duel.setReady({ roomId: uniqueRoom.id, requestId: randomUUID(), ready: true });
    const uniqueSeed = Array.from({ length: 1_000 }, (_, index) => (index + 1_000).toString(16).padStart(64, "0")).find((seed) => {
      const state = initialBlackjackState(seed, uniqueRoom.id, 1, [1, 2]);
      return [1, 2].every((seat) => !evaluateBlackjackHand(state.hands[seat]).automaticStand);
    })!;
    await db.update(duelRooms).set({ seedSecret: uniqueSeed, seedHash: duelSeedCommitment(uniqueSeed, uniqueRoom.id, "blackjack", 1) }).where(eq(duelRooms.id, uniqueRoom.id));
    await member(1).duel.setReady({ roomId: uniqueRoom.id, requestId: randomUUID(), ready: true });
    await Promise.all([
      member(0).duel.blackjackAction({ roomId: uniqueRoom.id, requestId: randomUUID(), action: "hit" }),
      member(1).duel.blackjackAction({ roomId: uniqueRoom.id, requestId: randomUUID(), action: "hit" }),
    ]);
    const persistedState = JSON.parse((await db.select().from(duelRooms).where(eq(duelRooms.id, uniqueRoom.id)))[0].stateJson) as BlackjackRoomState;
    const dealtCards = Object.values(persistedState.hands).flat();
    expect(persistedState.cursor).toBe(6);
    expect(new Set(persistedState.deck).size).toBe(52);
    expect(new Set(dealtCards).size).toBe(dealtCards.length);
    expect([...dealtCards].sort()).toEqual([...persistedState.deck.slice(0, persistedState.cursor)].sort());
    await db.update(duelRooms).set({ actionDeadlineAt: new Date(Date.now() - 1) }).where(eq(duelRooms.id, uniqueRoom.id));
    const uniqueSettled = await member(0).duel.room({ roomId: uniqueRoom.id });
    expect(["settled", "refunded"]).toContain(uniqueSettled.status);

    // 若所有玩家起手即为自动完成牌型，开局事务内立即统一揭牌结算，不残留无人可操作的 active 房。
    const autoRoom = await member(0).duel.create({
      requestId: randomUUID(), game: "blackjack", visibility: "private", bet: 1, maxPlayers: 2, expectedConfigVersion: config.version,
    });
    await member(1).duel.join({ requestId: randomUUID(), code: autoRoom.code });
    await member(0).duel.setReady({ roomId: autoRoom.id, requestId: randomUUID(), ready: true });
    const allAutoSeed = Array.from({ length: 10_000 }, (_, index) => (index + 10_000).toString(16).padStart(64, "0")).find((seed) => {
      const state = initialBlackjackState(seed, autoRoom.id, 1, [1, 2]);
      return [1, 2].every((seat) => evaluateBlackjackHand(state.hands[seat]).automaticStand);
    })!;
    expect(allAutoSeed).toBeTruthy();
    await db.update(duelRooms).set({ seedSecret: allAutoSeed, seedHash: duelSeedCommitment(allAutoSeed, autoRoom.id, "blackjack", 1) }).where(eq(duelRooms.id, autoRoom.id));
    const autoSettled = await member(1).duel.setReady({ roomId: autoRoom.id, requestId: randomUUID(), ready: true });
    expect(["settled", "refunded"]).toContain(autoSettled.status);
    expect(autoSettled.actionDeadlineAt).toBeNull();
    expect(autoSettled.players.every((player) => player.handRank && player.hand)).toBe(true);

    const userUnits = (await db.select().from(users)).reduce((sum, user) => sum + duelDollarsToUnits(user.balance), 0);
    const fundUnits = (await db.select().from(duelFund).where(eq(duelFund.id, 1)))[0].balanceUnits;
    expect(userUnits + fundUnits).toBe(20_000_000);
  });
});
