import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "@db/schema";
import { settings } from "@db/schema";
import { SETTING_KEYS } from "../settings";
import {
  businessDayInfo,
  dollarsToCents,
  validateWeightedRewards,
  type WeightedReward,
} from "@contracts/entertainment";

type ReadDb = Pick<BetterSQLite3Database<typeof schema>, "select">;

export function readSetting(db: ReadDb, key: string, fallback: string): string {
  const value = db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1).get()?.value;
  return value === null || value === undefined || value === "" ? fallback : value;
}

function integerSetting(db: ReadDb, key: string, fallback: number, min: number, max: number) {
  const value = Number(readSetting(db, key, String(fallback)));
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function currentBusinessDay(db: ReadDb, now = new Date()) {
  const timezoneOffsetMinutes = integerSetting(db, SETTING_KEYS.businessTimezoneOffsetMinutes, 480, -720, 840);
  const startHour = integerSetting(db, SETTING_KEYS.businessDayStartHour, 0, 0, 23);
  return {
    ...businessDayInfo(now, timezoneOffsetMinutes, startHour),
    timezoneOffsetMinutes,
    startHour,
  };
}

export function readDailyLimits(db: ReadDb) {
  return {
    slot: integerSetting(db, SETTING_KEYS.slotDailyLimit, 1, 0, 100),
  };
}

export function readDrawConfig(db: ReadDb) {
  const rawRate = Number(readSetting(db, SETTING_KEYS.drawWinRate, "10"));
  const ratePercent = Number.isFinite(rawRate) && rawRate >= 0 && rawRate <= 100 ? rawRate : 10;
  const rawMin = Number(readSetting(db, SETTING_KEYS.drawMin, "5"));
  const rawMax = Number(readSetting(db, SETTING_KEYS.drawMax, "10"));
  let minUnits = 500;
  let maxUnits = 1000;
  try {
    minUnits = dollarsToCents(rawMin);
    maxUnits = dollarsToCents(rawMax);
  } catch { /* safe defaults */ }
  if (minUnits > maxUnits) [minUnits, maxUnits] = [500, 1000];
  return {
    enabled: readSetting(db, SETTING_KEYS.drawEnabled, "1") !== "0",
    ratePpm: Math.round(ratePercent * 10_000),
    ratePercent,
    minUnits,
    maxUnits,
    totalLimit: integerSetting(db, SETTING_KEYS.drawTotalLimit, 0, 0, 10_000_000),
  };
}

export type SigninRewardMode = "range" | "fixed" | "tiers";

export function readSigninConfig(db: ReadDb) {
  const minUnits = integerSetting(db, SETTING_KEYS.dailySigninMinUnits, 100, 0, 100_000_000);
  const configuredMax = integerSetting(db, SETTING_KEYS.dailySigninMaxUnits, 500, 0, 100_000_000);
  const maxUnits = configuredMax >= minUnits ? configuredMax : Math.max(minUnits, 500);
  const rawMode = readSetting(db, SETTING_KEYS.dailySigninMode, "range");
  const mode: SigninRewardMode = rawMode === "fixed" || rawMode === "tiers" ? rawMode : "range";
  const fixedUnits = integerSetting(db, SETTING_KEYS.dailySigninFixedUnits, minUnits, minUnits, maxUnits);
  let tiers: WeightedReward[] = [{ rewardUnits: minUnits, probabilityPpm: 1_000_000 }];
  try {
    const parsed = JSON.parse(readSetting(db, SETTING_KEYS.dailySigninTiersJson, "[]")) as WeightedReward[];
    validateWeightedRewards(parsed, minUnits, maxUnits);
    tiers = parsed;
  } catch { /* guaranteed fallback tier */ }
  return {
    enabled: readSetting(db, SETTING_KEYS.dailySigninEnabled, "1") !== "0",
    minUnits,
    maxUnits,
    mode,
    fixedUnits,
    tiers,
  };
}
