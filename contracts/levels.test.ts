import { describe, expect, it } from "vitest";
import { getLevelProgress, getLevelThreshold } from "./levels";

describe("level progression", () => {
  it.each([
    [1, 0],
    [7, 2380],
    [10, 7980],
    [20, 120980],
    [30, 300980],
    [40, 480980],
    [50, 660980],
    [51, 678980],
  ])("reaches Lv.%i at %i EXP", (level, exp) => {
    expect(getLevelThreshold(level)).toBe(exp);
    expect(getLevelProgress(exp)).toMatchObject({ level, currentExp: 0 });
    if (exp > 0) expect(getLevelProgress(exp - 1).level).toBe(level - 1);
  });

  it("keeps all EXP after the last level", () => {
    expect(getLevelProgress(700000)).toMatchObject({
      level: 51,
      totalExp: 700000,
      requiredExp: null,
    });
  });
});
