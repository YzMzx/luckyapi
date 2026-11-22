import { describe, expect, it } from "vitest";
import {
  allowedMaxBetUnits,
  DEFAULT_SLOT_RULES,
  LEGACY_SLOT_RULES,
  V2_SLOT_RULES,
  parseSlotRules,
  settlementRtpForBet,
  maxNetLiabilityForBet,
  multiplyMoneyUnits,
  SLOT_PROBABILITY_SCALE,
  slotMetrics,
  spinSlot,
  validateSlotRules,
} from "./slot-machine";

describe("slot machine exact prize tiers", () => {
  it("publishes the exact default hit rate, RTP and maximum liability", () => {
    const metrics = validateSlotRules(DEFAULT_SLOT_RULES);
    expect(metrics.winRatePpm).toBe(300_000);
    expect(metrics.rtpPpm).toBe(920_000);
    expect(metrics.houseEdgePpm).toBe(80_000);
    expect(metrics.maxGrossPayoutUnits).toBe(50_000);
    expect(metrics.maxNetLiabilityUnits).toBe(49_500);
    expect(slotMetrics(LEGACY_SLOT_RULES).winRatePpm).toBe(67_060);
    expect(slotMetrics(LEGACY_SLOT_RULES).rtpPpm).toBe(903_150);
  });

  it("uses integer money rounding and exact liability checks", () => {
    expect(multiplyMoneyUnits(10, 12_000)).toBe(12);
    expect(multiplyMoneyUnits(11, 12_000)).toBe(13);
    expect(maxNetLiabilityForBet(DEFAULT_SLOT_RULES, 500)).toBe(49_500);
    expect(allowedMaxBetUnits(DEFAULT_SLOT_RULES, 49_500)).toBe(500);
    expect(allowedMaxBetUnits(DEFAULT_SLOT_RULES, 9_900)).toBe(100);
    expect(allowedMaxBetUnits(DEFAULT_SLOT_RULES, 989)).toBe(0);
  });

  it("returns exactly 92% after settlement for every supported v3 stake", () => {
    // Independent oracle for the first roll and total-return multiplier of each bracket.
    const brackets = [[0, 2], [220_000, 3], [270_000, 6], [295_000, 20], [299_000, 100], [300_000, 0]];
    for (let bet = DEFAULT_SLOT_RULES.minBetUnits; bet <= DEFAULT_SLOT_RULES.maxBetUnits; bet++) {
      for (const [roll, multiplier] of brackets) {
        const result = spinSlot((max) => max === SLOT_PROBABILITY_SCALE ? roll : 0, DEFAULT_SLOT_RULES, bet);
        expect(result.grossPayoutUnits).toBe(bet * multiplier);
        expect(result.settlementRtpPpm).toBe(920_000);
      }
      expect(settlementRtpForBet(DEFAULT_SLOT_RULES, bet)).toEqual({
        numerator: 920_000 * bet, denominator: SLOT_PROBABILITY_SCALE * bet, rtpPpm: 920_000,
      });
    }
    for (const invalid of [0, 9, 10.5, 501, NaN]) {
      expect(() => settlementRtpForBet(DEFAULT_SLOT_RULES, invalid)).toThrow("下注金额");
    }
  });

  it("reads historical snapshots without substituting v3 payouts or hiding v2 rounding", () => {
    const v2 = parseSlotRules(JSON.stringify(V2_SLOT_RULES));
    expect(slotMetrics(v2)).toMatchObject({ winRatePpm: 250_500, rtpPpm: 920_000 });
    expect(settlementRtpForBet(v2, 12)).toMatchObject({ rtpPpm: 915_000 });
    expect(settlementRtpForBet(v2, 13)).toEqual({ numerator: 12_020_000, denominator: 13_000_000, rtpPpm: 924_615 });
    const calls: number[] = [];
    const rng = (max: number) => { calls.push(max); return max === SLOT_PROBABILITY_SCALE ? 249_999 : 0; };
    expect(spinSlot(rng, v2, 13)).toMatchObject({ prizeTierId: "jackpot", grossPayoutUnits: 2_860, settlementRtpPpm: 924_615 });
    expect(calls).toEqual([SLOT_PROBABILITY_SCALE]);
    calls.length = 0;
    expect(spinSlot((max) => { calls.push(max); return max === SLOT_PROBABILITY_SCALE ? 250_500 : 0; }, v2, 13)).toMatchObject({
      prizeTierId: "loss", grossPayoutUnits: 0, settlementRtpPpm: 924_615,
    });
    expect(calls).toEqual([SLOT_PROBABILITY_SCALE, 5, 5, 5, 4]);
    expect(settlementRtpForBet(parseSlotRules(JSON.stringify(LEGACY_SLOT_RULES)), 13).rtpPpm).toBe(903_150);
  });

  it("rejects unreachable, zero, 100% and above-100% configurations", () => {
    expect(() => validateSlotRules({ ...DEFAULT_SLOT_RULES, tiers: [] })).toThrow();
    expect(() => validateSlotRules({
      ...DEFAULT_SLOT_RULES,
      tiers: DEFAULT_SLOT_RULES.tiers.map((tier, index) => ({ ...tier, probabilityPpm: index === 0 ? SLOT_PROBABILITY_SCALE : 1 })),
    })).toThrow();
    expect(() => validateSlotRules({
      ...DEFAULT_SLOT_RULES,
      tiers: DEFAULT_SLOT_RULES.tiers.map((tier) => ({ ...tier, multiplierBasisPoints: 10_000_000 })),
    })).toThrow("RTP");
  });

  it("selects exact tiers and never emits a losing triple", () => {
    const jackpot = spinSlot((max) => max === SLOT_PROBABILITY_SCALE ? 299_999 : 0, DEFAULT_SLOT_RULES, 100);
    expect(jackpot).toMatchObject({ prizeTierId: "jackpot", symbols: ["seven", "seven", "seven"], grossPayoutUnits: 10_000 });
    const loss = spinSlot((max) => max === SLOT_PROBABILITY_SCALE ? 999_999 : 0, DEFAULT_SLOT_RULES, 100);
    expect(loss.win).toBe(false);
    expect(new Set(loss.symbols).size).toBeGreaterThan(1);
  });

  it("matches the published distribution in a deterministic million-roll sample", () => {
    let cursor = 0;
    const counts: Record<string, number> = {};
    let payoutUnits = 0;
    for (let i = 0; i < SLOT_PROBABILITY_SCALE; i += 1) {
      const result = spinSlot((max) => max === SLOT_PROBABILITY_SCALE ? cursor++ : 0, DEFAULT_SLOT_RULES, 100);
      counts[result.prizeTierId] = (counts[result.prizeTierId] ?? 0) + 1;
      payoutUnits += result.grossPayoutUnits;
    }
    expect(counts).toEqual({ "small-1": 220_000, "small-2": 50_000, medium: 25_000, large: 4_000, jackpot: 1_000, loss: 700_000 });
    expect(payoutUnits / (SLOT_PROBABILITY_SCALE * 100)).toBe(0.92);
  });
});
