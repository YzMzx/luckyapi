import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "@db/schema";
import { settings, userPolicies } from "@db/schema";
import { MONEY_SCALE } from "@contracts/finance";
import { SETTING_KEYS } from "../settings";
import { readSetting } from "./entertainment-control";

type ReadDb = Pick<BetterSQLite3Database<typeof schema>, "select">;
type WriteDb = Pick<BetterSQLite3Database<typeof schema>, "select" | "insert" | "update">;

export const CONTROL_MODULES = [
  "login", "registration", "api", "transfer", "lending", "reporting",
  "draw", "signin", "videoReward", "slot", "duel", "teamBattle",
] as const;
export type ControlModule = typeof CONTROL_MODULES[number];

const controlKeys: Record<ControlModule, string> = {
  login: SETTING_KEYS.loginEnabled,
  registration: SETTING_KEYS.registrationEnabled,
  api: SETTING_KEYS.apiEnabled,
  transfer: SETTING_KEYS.transferEnabled,
  lending: SETTING_KEYS.lendingEnabled,
  reporting: SETTING_KEYS.reportingEnabled,
  draw: SETTING_KEYS.drawModuleEnabled,
  signin: SETTING_KEYS.signinModuleEnabled,
  videoReward: SETTING_KEYS.videoRewardModuleEnabled,
  slot: SETTING_KEYS.slotModuleEnabled,
  duel: SETTING_KEYS.duelModuleEnabled,
  teamBattle: SETTING_KEYS.teamBattleModuleEnabled,
};

export function readControlState(db: ReadDb) {
  return {
    maintenance: readSetting(db, SETTING_KEYS.maintenanceMode, "0") === "1",
    modules: Object.fromEntries(CONTROL_MODULES.map((module) => [
      module,
      readSetting(db, controlKeys[module], "1") !== "0",
    ])) as Record<ControlModule, boolean>,
  };
}

export function readUserPolicy(db: ReadDb, userId: number) {
  return db.select().from(userPolicies).where(eq(userPolicies.userId, userId)).limit(1).get() ?? {
    userId,
    frozenApiGroupIds: "[]",
    allFrozen: false,
    apiFrozen: false,
    financeFrozen: false,
    entertainmentFrozen: false,
    apiDailySpendLimitUnits: null,
    apiKeyLimit: null,
    apiConcurrencyLimit: null,
    transferDailyLimitUnits: null,
    lendingDailyLimitUnits: null,
    outstandingBorrowLimitUnits: null,
    updatedAt: new Date(0),
  };
}

const policyArea: Partial<Record<ControlModule, "api" | "finance" | "entertainment">> = {
  api: "api", transfer: "finance", lending: "finance",
  reporting: "entertainment", draw: "entertainment", signin: "entertainment",
  videoReward: "entertainment", slot: "entertainment", duel: "entertainment", teamBattle: "entertainment",
};

const moduleLabels: Record<ControlModule, string> = {
  login: "登录", registration: "注册", api: "API 调用", transfer: "转账", lending: "借贷",
  reporting: "举报", draw: "抽奖", signin: "签到", videoReward: "视频红包",
  slot: "老虎机", duel: "决斗", teamBattle: "战队对抗",
};

export function frozenApiGroupIds(policy: { frozenApiGroupIds?: string | null }) {
  try {
    const parsed = JSON.parse(policy.frozenApiGroupIds || "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isInteger(id) && id > 0) : [];
  } catch { return []; }
}

export function isApiGroupFrozen(policy: { allFrozen: boolean; apiFrozen: boolean; frozenApiGroupIds?: string | null }, groupId: number | null) {
  if (policy.allFrozen || policy.apiFrozen) return true;
  return groupId !== null && frozenApiGroupIds(policy).includes(groupId);
}

export function assertModuleAvailable(db: ReadDb, module: ControlModule, userId?: number) {
  const controls = readControlState(db);
  if (controls.maintenance)
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "系统正在维护，暂时无法开始新的业务操作", cause: "MODULE_DISABLED" });
  if (!controls.modules[module])
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${moduleLabels[module]}功能当前已由管理员关闭`, cause: "MODULE_DISABLED" });
  if (!userId) return;
  const policy = readUserPolicy(db, userId);
  const area = policyArea[module];
  if (policy.allFrozen || (area === "api" && policy.apiFrozen) || (area === "finance" && policy.financeFrozen) || (area === "entertainment" && policy.entertainmentFrozen))
    throw new TRPCError({ code: "FORBIDDEN", message: `你的${area === "api" ? " API" : area === "finance" ? "金融" : "娱乐"}权限已被冻结`, cause: "USER_POLICY_BLOCKED" });
}

export type FinanceRules = ReturnType<typeof readFinanceRules>;
function intSetting(db: ReadDb, key: string, fallback: number, min: number, max: number) {
  const value = Number(readSetting(db, key, String(fallback)));
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

export function readFinanceRules(db: ReadDb) {
  return {
    transferFeeBasisPoints: intSetting(db, SETTING_KEYS.transferFeeBasisPoints, 300, 0, 10_000),
    transferMinUnits: intSetting(db, SETTING_KEYS.transferMinUnits, 1, 1, 1_000_000 * MONEY_SCALE),
    transferMaxUnits: intSetting(db, SETTING_KEYS.transferMaxUnits, 1_000_000 * MONEY_SCALE, 1, 1_000_000 * MONEY_SCALE),
    transferDailyLimitUnits: intSetting(db, SETTING_KEYS.transferDailyLimitUnits, 1_000_000 * MONEY_SCALE, 1, 1_000_000 * MONEY_SCALE),
    loanMinPrincipalUnits: intSetting(db, SETTING_KEYS.loanMinPrincipalUnits, 10_000, 1, 1_000_000 * MONEY_SCALE),
    loanMaxPrincipalUnits: intSetting(db, SETTING_KEYS.loanMaxPrincipalUnits, 1_000_000 * MONEY_SCALE, 1, 1_000_000 * MONEY_SCALE),
    loanMinRateBasisPoints: intSetting(db, SETTING_KEYS.loanMinRateBasisPoints, 0, 0, 10_000),
    loanMaxRateBasisPoints: intSetting(db, SETTING_KEYS.loanMaxRateBasisPoints, 10_000, 0, 10_000),
    loanMinDurationDays: intSetting(db, SETTING_KEYS.loanMinDurationDays, 1, 1, 3660),
    loanMaxDurationDays: intSetting(db, SETTING_KEYS.loanMaxDurationDays, 366, 1, 3660),
    loanOfferExpiryMinutes: intSetting(db, SETTING_KEYS.loanOfferExpiryMinutes, 5, 1, 1440),
    loanInterestTaxBasisPoints: intSetting(db, SETTING_KEYS.loanInterestTaxBasisPoints, 1_000, 0, 10_000),
    lendingDailyLimitUnits: intSetting(db, SETTING_KEYS.lendingDailyLimitUnits, 1_000_000 * MONEY_SCALE, 1, 1_000_000 * MONEY_SCALE),
    outstandingBorrowLimitUnits: intSetting(db, SETTING_KEYS.outstandingBorrowLimitUnits, 1_000_000 * MONEY_SCALE, 1, 1_000_000 * MONEY_SCALE),
  };
}

export function stricterLimit(globalLimit: number, userLimit: number | null) {
  return userLimit === null ? globalLimit : Math.min(globalLimit, userLimit);
}

export function upsertSetting(db: WriteDb, key: string, value: string) {
  db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

