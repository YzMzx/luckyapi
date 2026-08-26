export const VIDEO_REWARD_MONEY_SCALE = 1_000_000;
export const VIDEO_REWARD_MIN_WATCH_SECONDS = 15;
export const VIDEO_REWARD_MIN_HEARTBEAT_MS = 750;
export const VIDEO_REWARD_MAX_HEARTBEAT_MS = 5_000;
export const VIDEO_REWARD_MAX_SESSION_MS = 30 * 60_000;
export const DEFAULT_VIDEO_REWARD_RESOURCE = "/media/lucky-video-red-envelope-15s.mp4";

export function videoRewardDollarsToUnits(amount: number): number {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("amount must be non-negative");
  const units = Math.round(amount * VIDEO_REWARD_MONEY_SCALE);
  if (!Number.isSafeInteger(units) || Math.abs(amount * VIDEO_REWARD_MONEY_SCALE - units) > 1e-6)
    throw new Error("amount must have at most six decimal places");
  return units;
}

export function videoRewardUnitsToDollars(units: number): number {
  if (!Number.isSafeInteger(units)) throw new Error("invalid video reward units");
  return units / VIDEO_REWARD_MONEY_SCALE;
}

/** 只允许 public 下的本地资源标识或相对路径，拒绝协议、查询串、目录穿越与反斜杠。 */
export function isSafeLocalVideoResource(value: string): boolean {
  const resource = value.trim();
  return resource.length >= 1
    && resource.length <= 256
    && !resource.includes("://")
    && !resource.includes("..")
    && !resource.includes("\\")
    && !resource.includes("?")
    && !resource.includes("#")
    && /^\/?[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(resource);
}

export type VideoRewardConfigSnapshot = {
  enabled: boolean;
  dailyLimit: number;
  minWatchSeconds: number;
  minRewardUnits: number;
  maxRewardUnits: number;
  dailyBudgetUnits: number;
  useFund: boolean;
  videoResource: string;
  timezoneOffsetMinutes: number;
  businessDayStartHour: number;
};
