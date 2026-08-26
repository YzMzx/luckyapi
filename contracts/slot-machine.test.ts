import { describe, expect, it } from "vitest";
import {
  allowedMaxBetUnits,
  DEFAULT_SLOT_RULES,
  LEGACY_SLOT_RULES,
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
    expect(metrics.winRatePpm).toBe(250_500);
    expect(metrics.rtpPpm).toBe(920_000);
    expect(metrics.houseEdgePpm).toBe(80_000);
    expect(metrics.maxGrossPayoutUnits).toBe(110_000);
    expect(metrics.maxNetLiabilityUnits).toBe(109_500);
    expect(slotMetrics(LEGACY_SLOT_RULES).winRatePpm).toBe(67_060);
    expect(slotMetrics(LEGACY_SLOT_RULES).rtpPpm).toBe(903_150);
  });

  it("uses integer money rounding and exact liability checks", () => {
    expect(multiplyMoneyUnits(10, 12_000)).toBe(12);
    expect(multiplyMoneyUnits(11, 12_000)).toBe(13);
    expect(maxNetLiabilityForBet(DEFAULT_SLOT_RULES, 500)).toBe(109_500);
    expect(allowedMaxBetUnits(DEFAULT_SLOT_RULES, 109_500)).toBe(500);
    expect(allowedMaxBetUnits(DEFAULT_SLOT_RULES, 21_900)).toBe(100);
    expect(allowedMaxBetUnits(DEFAULT_SLOT_RULES, 2_189)).toBe(0);
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
    const jackpot = spinSlot((max) => max === SLOT_PROBABILITY_SCALE ? 249_999 : 0, DEFAULT_SLOT_RULES, 100);
    expect(jackpot).toMatchObject({ prizeTierId: "jackpot", symbols: ["seven", "seven", "seven"], grossPayoutUnits: 22_000 });
    const loss = spinSlot((max) => max === SLOT_PROBABILITY_SCALE ? 999_999 : 0, DEFAULT_SLOT_RULES, 100);
    expect(loss.win).toBe(false);
    expect(new Set(loss.symbols).size).toBeGreaterThan(1);
  });

  it("matches the published distribution in a deterministic million-roll sample", () => {
    let cursor = 0;
    let wins = 0;
    let payoutUnits = 0;
    for (let i = 0; i < SLOT_PROBABILITY_SCALE; i += 1) {
      const result = spinSlot((max) => max === SLOT_PROBABILITY_SCALE ? cursor++ : 0, DEFAULT_SLOT_RULES, 100);
      if (result.win) wins += 1;
      payoutUnits += result.grossPayoutUnits;
    }
    expect(wins).toBe(250_500);
    expect(payoutUnits / (SLOT_PROBABILITY_SCALE * 100)).toBe(0.92);
  });
});
