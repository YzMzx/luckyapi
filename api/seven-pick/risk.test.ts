import { expect, it } from "vitest";
import {
  calculateSevenPickMaxExposure,
  SEVEN_PICK_DRAW_COUNT,
  sevenPickCountBits,
  sevenPickDrawMasks,
  sevenPickItemMask,
} from "./risk";

const ODDS = [0, 0, 0, 3, 12, 100, 1000, 50_000];
const A = [1, 2, 3, 4, 5, 6, 7];
const B = [1, 2, 3, 4, 5, 6, 32];
const riskBet = (items: number[], stakeUnits: number) => ({
  itemMask: sevenPickItemMask(items),
  stakeUnits,
});

it("enumerates exactly every unique 7 of 32 mask, including bit 32", () => {
  let last = 0;
  let count = 0;
  for (const draw of sevenPickDrawMasks()) {
    if (draw <= last || sevenPickCountBits(draw) !== 7)
      throw new Error("invalid mask sequence");
    last = draw;
    count++;
  }
  expect(count).toBe(SEVEN_PICK_DRAW_COUNT);
  expect(last).toBe(sevenPickItemMask([26, 27, 28, 29, 30, 31, 32]));
  expect(sevenPickItemMask(B)).toBeGreaterThanOrEqual(2 ** 31);
});

it("counts extreme 7-of-7 and other tickets at the same draw, not individual maxima", () => {
  expect(calculateSevenPickMaxExposure([], ODDS)).toBe(0n);
  expect(calculateSevenPickMaxExposure([riskBet(A, 100_000)], ODDS)).toBe(
    5_000_000_000n
  );
  expect(
    calculateSevenPickMaxExposure([riskBet(A, 100_000), riskBet(A, 1000)], ODDS)
  ).toBe(5_050_000_000n);
  expect(
    calculateSevenPickMaxExposure([riskBet(A, 100_000), riskBet(B, 1000)], ODDS)
  ).toBe(5_001_000_000n);
});

it("matches an independent exhaustive intersection oracle when nonmonotonic odds make a non-ticket draw optimal", () => {
  const C = [2, 3, 4, 7, 8, 9, 32];
  const bets = [
    { items: A, units: 1003 },
    { items: B, units: 1007 },
    { items: C, units: 1011 },
  ];
  const odds = [0, 0, 0, 3, 50_000, 1, 2, 5];
  const union = [...new Set(bets.flatMap(b => b.items))];
  // Any selected subset of the union can fill the remaining holes with items
  // outside the union; these fillers never alter an intersection count.
  const value = (items: readonly number[]) =>
    bets.reduce((total, bet) => {
      const hits = bet.items.filter(x => items.includes(x)).length;
      return total + BigInt(bet.units) * BigInt(odds[hits]);
    }, 0n);
  let oracle = 0n;
  function enumerate(index: number, selected: number[]) {
    if (selected.length > 7) return;
    if (index === union.length) {
      const sum = value(selected);
      if (sum > oracle) oracle = sum;
      return;
    }
    enumerate(index + 1, selected);
    enumerate(index + 1, [...selected, union[index]]);
  }
  enumerate(0, []);
  expect(bets.every(bet => value(bet.items) < oracle)).toBe(true);
  expect(
    calculateSevenPickMaxExposure(
      bets.map(b => riskBet(b.items, b.units)),
      odds
    )
  ).toBe(oracle);
});

it("keeps integer totals exact beyond JavaScript's safe Number range", () => {
  const largest = Number.MAX_SAFE_INTEGER;
  expect(
    calculateSevenPickMaxExposure(
      [riskBet(A, largest), riskBet(B, largest - 1)],
      ODDS
    )
  ).toBe(BigInt(largest) * 50_000n + BigInt(largest - 1) * 1000n);
  expect(() =>
    calculateSevenPickMaxExposure([{ itemMask: 1, stakeUnits: 1000 }], ODDS)
  ).toThrow(RangeError);
  expect(() =>
    calculateSevenPickMaxExposure([riskBet(A, Infinity)], ODDS)
  ).toThrow(RangeError);
});
