export const DAILY_CHECKIN_EXP = 200;
export const EXP_PER_USD = { income: 100, api_usage: 10 } as const;

/** Public badge shown beside a member’s name. Rank is the limited-edition seat. */
export type DisplayLevelBadge = { level: number; rank: 1 | 2 | 3 | null };

export const MAX_LEVEL = 51;
export const LEVEL_STAGES = [
  { level: 10, name: "初星" },
  { level: 20, name: "星轨" },
  { level: 30, name: "星图" },
  { level: 40, name: "星冕" },
  { level: 50, name: "星耀" },
] as const;

// 第一个数对应 Lv.1 → Lv.2，Lv.16 起固定为 18,000。
const earlyCosts = [
  80, 200, 200, 300, 600, 1000, 1400, 1800, 2400, 3000, 3600, 4200, 5200, 10000,
  15000,
];
const thresholds = [0];
for (let level = 1; level < MAX_LEVEL; level++) {
  thresholds.push(thresholds[level - 1] + (earlyCosts[level - 1] ?? 18000));
}

export function getLevelThreshold(level: number): number {
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL)
    throw new RangeError("无效等级");
  return thresholds[level - 1];
}

export function getLevelProgress(totalExp: number) {
  if (!Number.isSafeInteger(totalExp) || totalExp < 0)
    throw new RangeError("无效累计经验");
  const nextIndex = thresholds.findIndex(threshold => threshold > totalExp);
  const level = nextIndex === -1 ? MAX_LEVEL : nextIndex;
  return {
    level,
    totalExp,
    currentExp: totalExp - getLevelThreshold(level),
    requiredExp:
      level === MAX_LEVEL
        ? null
        : getLevelThreshold(level + 1) - getLevelThreshold(level),
  };
}
