import { eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { settings } from "../db/schema";

/** 系统设置：优先读数据库（后台可改），回落到 .env */
export async function getSetting(key: string, envFallback?: string): Promise<string> {
  const rows = await getDb().select().from(settings).where(eq(settings.key, key)).limit(1);
  const v = rows[0]?.value;
  if (v !== null && v !== undefined && v !== "") return v;
  return envFallback ?? "";
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (rows.length) {
    await db.update(settings).set({ value }).where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, value });
  }
}

export const SETTING_KEYS = {
  linuxdoClientId: "linuxdo_client_id",
  linuxdoClientSecret: "linuxdo_client_secret",
  linuxdoPrimaryOrigin: "linuxdo_primary_origin",
  adminUsername: "admin_username",
  adminPassword: "admin_password",
  // 每日签到开关（"1" 开 / "0" 关）
  checkinEnabled: "checkin_enabled",
  slotDailyLimit: "slot_daily_limit",
  businessTimezoneOffsetMinutes: "business_timezone_offset_minutes",
  businessDayStartHour: "business_day_start_hour",
  dailySigninEnabled: "daily_signin_enabled",
  dailySigninMinUnits: "daily_signin_min_units",
  dailySigninMaxUnits: "daily_signin_max_units",
  dailySigninMode: "daily_signin_mode",
  dailySigninFixedUnits: "daily_signin_fixed_units",
  dailySigninTiersJson: "daily_signin_tiers_json",
  videoRewardEnabled: "video_reward_enabled",
  videoRewardMinWatchSeconds: "video_reward_min_watch_seconds",
  videoRewardMinUnits: "video_reward_min_units",
  videoRewardMaxUnits: "video_reward_max_units",
  videoRewardDailyBudgetUnits: "video_reward_daily_budget_units",
  videoRewardDailyLimit: "video_reward_daily_limit",
  videoRewardUseFund: "video_reward_use_fund",
  videoRewardVideoResource: "video_reward_video_resource",
  // 抽奖：中奖率（%）与金额范围
  drawWinRate: "draw_win_rate",
  drawMin: "draw_min",
  drawMax: "draw_max",
  drawEnabled: "draw_enabled",
  drawTotalLimit: "draw_total_limit",
  maintenanceMode: "control_maintenance",
  loginEnabled: "control_login",
  registrationEnabled: "control_registration",
  apiEnabled: "control_api",
  transferEnabled: "control_transfer",
  lendingEnabled: "control_lending",
  drawModuleEnabled: "control_draw",
  signinModuleEnabled: "control_signin",
  videoRewardModuleEnabled: "control_video_reward",
  slotModuleEnabled: "control_slot",
  duelModuleEnabled: "control_duel",
  transferFeeBasisPoints: "finance_transfer_fee_basis_points",
  transferMinUnits: "finance_transfer_min_units",
  transferMaxUnits: "finance_transfer_max_units",
  transferDailyLimitUnits: "finance_transfer_daily_limit_units",
  loanMinPrincipalUnits: "finance_loan_min_principal_units",
  loanMaxPrincipalUnits: "finance_loan_max_principal_units",
  loanMinRateBasisPoints: "finance_loan_min_rate_basis_points",
  loanMaxRateBasisPoints: "finance_loan_max_rate_basis_points",
  loanMinDurationDays: "finance_loan_min_duration_days",
  loanMaxDurationDays: "finance_loan_max_duration_days",
  loanOfferExpiryMinutes: "finance_loan_offer_expiry_minutes",
  loanInterestTaxBasisPoints: "finance_loan_interest_tax_basis_points",
  lendingDailyLimitUnits: "finance_lending_daily_limit_units",
  outstandingBorrowLimitUnits: "finance_outstanding_borrow_limit_units",
} as const;
