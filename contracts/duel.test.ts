import { describe, expect, it } from "vitest";
import {
  blackjackScore,
  compareBlackjackHands,
  compareDice,
  createDeck,
  duelLeaderboardPeriodBounds,
  evaluateBlackjackHand,
  evaluateDice,
  splitDuelPot,
} from "./duel";
import { deterministicDiceRound, deterministicShuffle, duelSeedCommitment } from "../api/queries/duel-engine";

describe("duel game rules", () => {
  it("orders dice as triple > straight > pair > high with deterministic tie breaks", () => {
    const triple = evaluateDice([2, 2, 2]);
    const straight = evaluateDice([4, 2, 3]);
    const pair = evaluateDice([6, 6, 1]);
    const high = evaluateDice([6, 4, 2]);
    expect(compareDice(triple, straight)).toBeGreaterThan(0);
    expect(compareDice(straight, pair)).toBeGreaterThan(0);
    expect(compareDice(pair, high)).toBeGreaterThan(0);
    expect(compareDice(evaluateDice([5, 5, 6]), evaluateDice([5, 5, 4]))).toBeGreaterThan(0);
    expect(compareDice(evaluateDice([6, 5, 3]), evaluateDice([6, 4, 3]))).toBeGreaterThan(0);
  });

  it("scores blackjack aces as 1 or 11 and detects busts", () => {
    expect(blackjackScore(["AS", "KH"])).toEqual({ score: 21, soft: true, busted: false });
    expect(blackjackScore(["AS", "AH", "9D"])).toEqual({ score: 21, soft: true, busted: false });
    expect(blackjackScore(["AS", "9H", "8D"])).toEqual({ score: 18, soft: false, busted: false });
    expect(blackjackScore(["KS", "QH", "2D"])).toEqual({ score: 22, soft: false, busted: true });
  });

  it("orders the disclosed PVP blackjack specials without creating dealer-style odds", () => {
    const doubleAces = evaluateBlackjackHand(["AS", "AH"]);
    const fiveCard = evaluateBlackjackHand(["2S", "3H", "4D", "5C", "6S"]);
    const natural = evaluateBlackjackHand(["AS", "KH"]);
    const ordinary21 = evaluateBlackjackHand(["7S", "7H", "7D"]);
    const ordinary20 = evaluateBlackjackHand(["10S", "QH"]);
    const bust = evaluateBlackjackHand(["KS", "QH", "2D"]);
    expect([doubleAces.category, fiveCard.category, natural.category, ordinary21.category, bust.category]).toEqual([
      "double_aces", "five_card_charlie", "natural_blackjack", "points", "bust",
    ]);
    expect([doubleAces, fiveCard, natural].every((rank) => rank.automaticStand && rank.isSpecial)).toBe(true);
    expect(compareBlackjackHands(doubleAces, fiveCard)).toBeGreaterThan(0);
    expect(compareBlackjackHands(fiveCard, natural)).toBeGreaterThan(0);
    expect(compareBlackjackHands(natural, ordinary21)).toBeGreaterThan(0);
    expect(compareBlackjackHands(ordinary21, ordinary20)).toBeGreaterThan(0);
    expect(compareBlackjackHands(ordinary20, bust)).toBeGreaterThan(0);
    expect(compareBlackjackHands(evaluateBlackjackHand(["2S", "3H", "4D", "5C", "6S"]), evaluateBlackjackHand(["AS", "2H", "3D", "4C", "5S"]))).toBe(0);
  });

  it("splits integer-unit pots exactly at 0% and 100% fees with deterministic remainder", () => {
    const zero = splitDuelPot(10, 0, [3, 1, 2]);
    expect(zero.feeUnits).toBe(0);
    expect([...zero.payouts.entries()]).toEqual([[1, 4], [2, 3], [3, 3]]);
    expect([...zero.payouts.values()].reduce((sum, value) => sum + value, 0) + zero.feeUnits).toBe(10);
    const full = splitDuelPot(10, 10_000, [1, 2]);
    expect(full.feeUnits).toBe(10);
    expect([...full.payouts.values()]).toEqual([0, 0]);
  });

  it("produces reproducible unbiased-source dice and Fisher-Yates decks from a revealed seed", () => {
    const seed = "11".repeat(32);
    const roomId = "00000000-0000-4000-8000-000000000001";
    expect(duelSeedCommitment(seed, roomId, "dice", 1)).toHaveLength(64);
    expect(deterministicDiceRound(seed, roomId, 1, [1, 2, 3])).toEqual(deterministicDiceRound(seed, roomId, 1, [1, 2, 3]));
    const deck = deterministicShuffle(seed, roomId, 1);
    expect(deck).toEqual(deterministicShuffle(seed, roomId, 1));
    expect(deck).toHaveLength(52);
    expect(new Set(deck)).toEqual(new Set(createDeck()));
  });

  it("uses Asia/Shanghai half-open leaderboard periods with Monday week starts", () => {
    const now = Date.parse("2026-08-19T12:34:56+08:00");
    expect(duelLeaderboardPeriodBounds("today", now)).toEqual({
      startMs: Date.parse("2026-08-19T00:00:00+08:00"),
      endMs: Date.parse("2026-08-20T00:00:00+08:00"),
      timezone: "Asia/Shanghai",
    });
    expect(duelLeaderboardPeriodBounds("week", now)).toEqual({
      startMs: Date.parse("2026-08-17T00:00:00+08:00"),
      endMs: Date.parse("2026-08-24T00:00:00+08:00"),
      timezone: "Asia/Shanghai",
    });
    expect(duelLeaderboardPeriodBounds("month", Date.parse("2026-01-31T23:59:59+08:00"))).toEqual({
      startMs: Date.parse("2026-01-01T00:00:00+08:00"),
      endMs: Date.parse("2026-02-01T00:00:00+08:00"),
      timezone: "Asia/Shanghai",
    });
    expect(duelLeaderboardPeriodBounds("all", now)).toEqual({
      startMs: null,
      endMs: null,
      timezone: "Asia/Shanghai",
    });
  });
});
