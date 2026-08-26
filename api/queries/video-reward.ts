import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "@db/schema";
import { SETTING_KEYS } from "../settings";
import { currentBusinessDay, readSetting } from "./entertainment-control";
import {
  VIDEO_REWARD_MIN_WATCH_SECONDS,
  DEFAULT_VIDEO_REWARD_RESOURCE,
  isSafeLocalVideoResource,
  type VideoRewardConfigSnapshot,
} from "@contracts/video-reward";

type ReadDb = Pick<BetterSQLite3Database<typeof schema>, "select">;

function safeInteger(raw: string, fallback: number, min: number, max: number) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

export function readVideoRewardConfig(db: ReadDb) {
  const minRewardUnits = safeInteger(readSetting(db, SETTING_KEYS.videoRewardMinUnits, "100000"), 100_000, 1, 1_000_000_000_000);
  const configuredMax = safeInteger(readSetting(db, SETTING_KEYS.videoRewardMaxUnits, "500000"), 500_000, 1, 1_000_000_000_000);
  const maxRewardUnits = configuredMax >= minRewardUnits ? configuredMax : minRewardUnits;
  const resource = readSetting(db, SETTING_KEYS.videoRewardVideoResource, DEFAULT_VIDEO_REWARD_RESOURCE).trim();
  return {
    enabled: readSetting(db, SETTING_KEYS.videoRewardEnabled, "0") === "1",
    dailyLimit: safeInteger(readSetting(db, SETTING_KEYS.videoRewardDailyLimit, "1"), 1, 1, 100),
    minWatchSeconds: safeInteger(
      readSetting(db, SETTING_KEYS.videoRewardMinWatchSeconds, String(VIDEO_REWARD_MIN_WATCH_SECONDS)),
      VIDEO_REWARD_MIN_WATCH_SECONDS,
      VIDEO_REWARD_MIN_WATCH_SECONDS,
      600,
    ),
    minRewardUnits,
    maxRewardUnits,
    dailyBudgetUnits: safeInteger(readSetting(db, SETTING_KEYS.videoRewardDailyBudgetUnits, "50000000"), 50_000_000, 0, 10_000_000_000_000),
    useFund: readSetting(db, SETTING_KEYS.videoRewardUseFund, "1") !== "0",
    videoResource: isSafeLocalVideoResource(resource) ? resource : DEFAULT_VIDEO_REWARD_RESOURCE,
  };
}

export function videoRewardSnapshot(db: ReadDb): VideoRewardConfigSnapshot {
  const config = readVideoRewardConfig(db);
  const day = currentBusinessDay(db);
  return {
    ...config,
    timezoneOffsetMinutes: day.timezoneOffsetMinutes,
    businessDayStartHour: day.startHour,
  };
}

export function parseVideoRewardSnapshot(raw: string): VideoRewardConfigSnapshot {
  const parsed = JSON.parse(raw) as VideoRewardConfigSnapshot;
  // Sessions created before daily limits were configurable remain readable.
  if (!Number.isInteger(parsed.dailyLimit)) parsed.dailyLimit = 1;
  if (parsed.dailyLimit < 1 || parsed.dailyLimit > 100)
    throw new Error("invalid video reward daily limit snapshot");
  if (!Number.isInteger(parsed.minWatchSeconds) || parsed.minWatchSeconds < VIDEO_REWARD_MIN_WATCH_SECONDS)
    throw new Error("invalid video reward watch duration snapshot");
  if (!Number.isSafeInteger(parsed.minRewardUnits) || !Number.isSafeInteger(parsed.maxRewardUnits)
    || parsed.minRewardUnits <= 0 || parsed.maxRewardUnits < parsed.minRewardUnits)
    throw new Error("invalid video reward amount snapshot");
  if (!Number.isSafeInteger(parsed.dailyBudgetUnits) || parsed.dailyBudgetUnits < 0)
    throw new Error("invalid video reward budget snapshot");
  if (!isSafeLocalVideoResource(parsed.videoResource)) throw new Error("invalid video resource snapshot");
  return parsed;
}
