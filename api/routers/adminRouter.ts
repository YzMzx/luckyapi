import { z } from "zod";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { eq, desc, sql, and, or, isNotNull, isNull, inArray, lt, lte, gt, gte, like } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { getDb } from "../queries/connection";
import { getLevelProgress } from "@contracts/levels";
import { getLevelHall } from "../queries/levels";
import { recordTx } from "../queries/ledger";
import { creditDollarsToUnits, debitUserBalance, expireUserCreditGrants } from "../queries/credit-grants";
import {
  users, inviteCodes, codeRedemptions, creditGrants, draws, checkins, models, usageLogs, groups,
  apiKeys, upstreams, adminLogs, slotConfigs, slotFund, slotFundLedger, slotPromotions,
  duelConfigs, duelRooms, duelPlayers, duelEvents, duelLedger, duelFund,
  announcements, dailySignins, signinFund, drawFund, settings,
  videoRewardFund, videoRewardLedger, videoRewardSessions,
  peerLoans, peerLoanLedger, levelProfiles,
} from "../../db/schema";
import { createRouter, publicQuery } from "../middleware";
import {
  authSettingsAdminRouter, controlAdminRouter, disableUserApiKeysProcedure, financeSettingsAdminRouter,
  monitoringAdminRouter, revokeUserSessionsProcedure, updateUserPolicyProcedure, userDetailProcedure,
} from "./adminOperations";
import { adminQuery, createAdminSession, cookieHeader, ADMIN_COOKIE, clearCookieHeader, hashAdminPassword, randomToken, requestUsesHttps, verifyAdminPassword } from "../auth";
import { getSetting, setSetting, SETTING_KEYS } from "../settings";
import {
  dollarsStringToMoneyUnits,
  formatMultiplier,
  formatProbabilityPercent,
  maxNetLiabilityForBet,
  moneyUnitsToDollars,
  multiplierToBasisPoints,
  parseSlotRules,
  probabilityPercentToPpm,
  serializeSlotRules,
  SLOT_SYMBOL_DEFINITIONS,
  slotMetrics,
  validateSlotRules,
  type SlotRulesDefinition,
} from "@contracts/slot-machine";
import { publicSlotState, resolveSlotState } from "../queries/slot-control";
import { duelAmountHasPrecision, duelDollarsToUnits, duelUnitsToDollars } from "@contracts/duel";
import {
  centsToDollars,
  dollarsToCents,
  sanitizeAnnouncementText,
  validateWeightedRewards,
} from "@contracts/entertainment";
import {
  currentBusinessDay,
  readDailyLimits,
  readDrawConfig,
  readSigninConfig,
} from "../queries/entertainment-control";
import { paginatedResult, paginationInput, paginationParams, resolvePagination } from "../pagination";
import {
  isSafeLocalVideoResource,
  videoRewardDollarsToUnits,
  videoRewardUnitsToDollars,
} from "@contracts/video-reward";
import { readVideoRewardConfig } from "../queries/video-reward";
import { accruedInterestUnits, interestTaxUnits } from "@contracts/finance";

/** 后台操作留痕 */
async function logAdmin(action: string, detail: string) {
  await getDb().insert(adminLogs).values({ action, detail });
}

const splitGroups = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);
const registeredUser = and(isNotNull(users.groupName), sql`trim(${users.groupName}) != ''`);

function upsertSetting(tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0], key: string, value: string) {
  tx.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}
const modelListUrl = (baseUrl: string) => {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}${/\/v1(beta)?$/.test(base) ? "" : "/v1"}/models`;
};

const slotConfigInput = z.object({
  name: z.string().trim().min(1).max(96),
  mode: z.enum(["base", "promotion"]),
  minBet: z.string().max(16),
  maxBet: z.string().max(16),
  tiers: z.array(z.object({
    id: z.string().trim().min(1).max(32),
    symbol: z.enum(["cherry", "lemon", "bell", "diamond", "seven"]),
    name: z.string().trim().min(1).max(32),
    probabilityPercent: z.string().max(16),
    multiplier: z.string().max(16),
  })).min(1).max(5),
});

const duelConfigInput = z.object({
  enabled: z.boolean(),
  diceEnabled: z.boolean(),
  blackjackEnabled: z.boolean(),
  feeBasisPoints: z.number().int().min(0).max(10_000),
  betOptions: z.array(z.number().positive().max(1_000_000)).min(1).max(12),
  minPlayers: z.number().int().min(2).max(6),
  maxPlayers: z.number().int().min(2).max(6),
  roomTimeoutSeconds: z.number().int().min(60).max(86_400),
  actionTimeoutSeconds: z.number().int().min(5).max(600),
  minBet: z.number().positive().max(1_000_000).optional(),
  maxBet: z.number().positive().max(1_000_000).optional(),
  betPrecision: z.number().int().min(0).max(6).optional(),
  singleBetLimit: z.number().positive().max(1_000_000),
  dailyStakeLimit: z.number().positive().max(1_000_000),
  dailyNetLossLimit: z.number().positive().max(1_000_000),
});

const moneyInput = z.number().min(0).max(1_000_000)
  .refine((value) => Math.round(value * 100) === value * 100, "金额最多保留两位小数");

const entertainmentConfigInput = z.object({
  businessTimezoneOffsetMinutes: z.number().int().min(-720).max(840),
  businessDayStartHour: z.number().int().min(0).max(23),
  drawEnabled: z.boolean(),
  drawWinRatePercent: z.number().min(0).max(100),
  drawMinReward: moneyInput,
  drawMaxReward: moneyInput,
  drawTotalLimit: z.number().int().min(0).max(10_000_000),
  drawBudgetRemaining: moneyInput,
  slotEnabled: z.boolean(),
  slotDailyLimit: z.number().int().min(0).max(100),
  signinEnabled: z.boolean(),
  signinMinReward: moneyInput,
  signinMaxReward: moneyInput,
  signinMode: z.enum(["range", "fixed", "tiers"]),
  signinFixedReward: moneyInput,
  signinTiers: z.array(z.object({
    reward: moneyInput,
    probabilityPpm: z.number().int().min(0).max(1_000_000),
  })).min(1).max(20),
  signinBudgetRemaining: moneyInput,
});

const announcementInput = z.object({
  title: z.string().min(1).max(120),
  content: z.string().min(1).max(10_000),
  status: z.enum(["draft", "published", "withdrawn"]),
  severity: z.enum(["info", "important", "urgent"]),
  pinned: z.boolean(),
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000),
  publishedAt: z.date().nullable(),
  endsAt: z.date().nullable(),
});

const videoRewardMoneyInput = z.number().min(0).max(1_000_000)
  .refine((value) => {
    try {
      videoRewardDollarsToUnits(value);
      return true;
    } catch {
      return false;
    }
  }, "Amount must have at most six decimal places");

const videoRewardConfigInput = z.object({
  enabled: z.boolean(),
  dailyLimit: z.number().int().min(1).max(100),
  minWatchSeconds: z.number().int().min(15).max(600),
  minReward: videoRewardMoneyInput.refine((value) => value > 0, "Minimum reward must be positive"),
  maxReward: videoRewardMoneyInput.refine((value) => value > 0, "Maximum reward must be positive"),
  dailyBudget: videoRewardMoneyInput,
  useFund: z.boolean(),
  fundBalance: videoRewardMoneyInput,
  videoResource: z.string().trim().min(1).max(256),
}).strict();

function parseSlotConfig(input: z.infer<typeof slotConfigInput>, version: string): SlotRulesDefinition {
  const minBetUnits = dollarsStringToMoneyUnits(input.minBet);
  const maxBetUnits = dollarsStringToMoneyUnits(input.maxBet);
  if (minBetUnits === null || maxBetUnits === null) throw new TRPCError({ code: "BAD_REQUEST", message: "下注金额必须是非负数且最多两位小数" });
  const tiers = input.tiers.map((tier) => {
    const probabilityPpm = probabilityPercentToPpm(tier.probabilityPercent);
    const multiplierBasisPoints = multiplierToBasisPoints(tier.multiplier);
    if (probabilityPpm === null || multiplierBasisPoints === null)
      throw new TRPCError({ code: "BAD_REQUEST", message: `奖项「${tier.name}」概率或倍率格式无效` });
    return { ...tier, probabilityPpm, multiplierBasisPoints };
  });
  const rules: SlotRulesDefinition = { version, name: input.name, minBetUnits, maxBetUnits, tiers };
  try {
    validateSlotRules(rules);
  } catch (error) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "老虎机配置无效" });
  }
  return rules;
}

const signedMoneyUnits = (value: string) => {
  const match = value.trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const units = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(units) ? (match[1] ? -units : units) : null;
};

const supportedInviteTypes = inArray(inviteCodes.type, ["invite", "redeem"]);

export const adminRouter = createRouter({
  levels: createRouter({ hall: adminQuery.query(() => getLevelHall()) }),
  control: controlAdminRouter,
  authSettings: authSettingsAdminRouter,
  financeSettings: financeSettingsAdminRouter,
  monitoring: monitoringAdminRouter,
  userDetail: userDetailProcedure,
  userPolicy: createRouter({ update: updateUserPolicyProcedure }),
  userSessions: createRouter({ revokeAll: revokeUserSessionsProcedure }),
  userApiKeys: createRouter({ disableAll: disableUserApiKeysProcedure }),
  login: publicQuery
    .input(z.object({ username: z.string(), password: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const u = await getSetting(SETTING_KEYS.adminUsername, process.env.ADMIN_USERNAME ?? "admin");
      const p = await getSetting(SETTING_KEYS.adminPassword, process.env.ADMIN_PASSWORD ?? "admin888");
      if (input.username !== u || !verifyAdminPassword(input.password, p)) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "账号或密码错误" });
      }
      if (!p.startsWith("scrypt$")) await setSetting(SETTING_KEYS.adminPassword, hashAdminPassword(input.password));
      const token = await createAdminSession();
      ctx.resHeaders.append("set-cookie", cookieHeader(ADMIN_COOKIE, token, 12 * 3600, requestUsesHttps(ctx.req)));
      return { ok: true };
    }),

  // ---- 民间贷只读审计 ----
  listPeerLoansPage: adminQuery.input(paginationInput.extend({
    status: z.enum(["offer", "active", "overdue", "repaid", "rejected", "cancelled", "expired"]).optional(),
    party: z.string().trim().max(64).optional(),
    loanId: z.number().int().positive().optional(),
    dueFrom: z.date().optional(),
    dueTo: z.date().optional(),
  })).query(({ input }) => getDb().transaction((tx) => {
    const lender = alias(users, "loan_audit_lender");
    const borrower = alias(users, "loan_audit_borrower");
    const now = new Date();
    const conditions = [];
    if (input.loanId) conditions.push(eq(peerLoans.id, input.loanId));
    if (input.dueFrom) conditions.push(gte(peerLoans.dueAt, input.dueFrom));
    if (input.dueTo) conditions.push(lte(peerLoans.dueAt, input.dueTo));
    if (input.party) {
      const term = input.party.replace(/[%_\\]/g, "");
      const pattern = `%${term}%`;
      conditions.push(or(
        eq(lender.linuxdoId, input.party), eq(borrower.linuxdoId, input.party),
        like(lender.groupName, pattern), like(borrower.groupName, pattern),
      )!);
    }
    if (input.status === "offer") conditions.push(and(eq(peerLoans.status, "pending"), gt(peerLoans.offerExpiresAt, now))!);
    if (input.status === "active") conditions.push(and(eq(peerLoans.status, "active"), gt(peerLoans.dueAt, now))!);
    if (input.status === "overdue") conditions.push(or(inArray(peerLoans.status, ["collecting", "defaulted"]), and(eq(peerLoans.status, "active"), lte(peerLoans.dueAt, now)))!);
    if (input.status === "repaid") conditions.push(eq(peerLoans.status, "fulfilled"));
    if (input.status === "rejected") conditions.push(and(eq(peerLoans.status, "cancelled"), eq(peerLoans.terminalReason, "rejected"))!);
    if (input.status === "cancelled") conditions.push(and(eq(peerLoans.status, "cancelled"), or(eq(peerLoans.terminalReason, "cancelled"), isNull(peerLoans.terminalReason)))!);
    if (input.status === "expired") conditions.push(or(
      and(eq(peerLoans.status, "cancelled"), eq(peerLoans.terminalReason, "expired")),
      and(eq(peerLoans.status, "pending"), lte(peerLoans.offerExpiresAt, now)),
    )!);
    const where = conditions.length ? and(...conditions) : undefined;
    const base = tx.select({ loan: peerLoans, lenderAccountId: lender.linuxdoId, lenderGroupName: lender.groupName, lenderUsername: lender.username, borrowerAccountId: borrower.linuxdoId, borrowerGroupName: borrower.groupName, borrowerUsername: borrower.username })
      .from(peerLoans).innerJoin(lender, eq(peerLoans.lenderId, lender.id)).innerJoin(borrower, eq(peerLoans.borrowerId, borrower.id));
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(peerLoans)
      .innerJoin(lender, eq(peerLoans.lenderId, lender.id)).innerJoin(borrower, eq(peerLoans.borrowerId, borrower.id)).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const rows = base.where(where).orderBy(desc(peerLoans.id)).limit(pageSize).offset(offset).all();
    const items = rows.map(({ loan, ...people }) => {
      const auditStatus = loan.status === "pending" ? (loan.offerExpiresAt <= now ? "expired" : "offer")
        : loan.status === "active" ? (loan.dueAt <= now ? "overdue" : "active")
          : loan.status === "fulfilled" ? "repaid"
            : loan.status === "collecting" || loan.status === "defaulted" ? "overdue"
              : loan.terminalReason ?? "cancelled";
      const currentInterestUnits = loan.acceptedAt && (loan.status === "active")
        ? accruedInterestUnits({ principalUnits: loan.principalUnits, monthlyRateBasisPoints: loan.monthlyRateBasisPoints, acceptedAtMs: loan.acceptedAt.getTime(), settlementAtMs: now.getTime(), dueAtMs: loan.dueAt.getTime() })
        : loan.accruedInterestUnits;
      const accruedTotalUnits = loan.principalUnits + currentInterestUnits;
      return {
        ...loan, ...people, auditStatus, currentInterestUnits, accruedTotalUnits,
        currentInterestTaxUnits: interestTaxUnits(currentInterestUnits),
        outstandingUnits: loan.status === "active" ? accruedTotalUnits : loan.outstandingPrincipalUnits + loan.outstandingInterestUnits,
      };
    });
    return paginatedResult(items, total, page, pageSize);
  })),

  listPeerLoanLedgerPage: adminQuery.input(paginationInput.extend({ loanId: z.number().int().positive() })).query(({ input }) => {
    const db = getDb();
    const exists = db.select({ id: peerLoans.id }).from(peerLoans).where(eq(peerLoans.id, input.loanId)).get();
    if (!exists) throw new TRPCError({ code: "NOT_FOUND", message: "贷款记录不存在" });
    const total = Number(db.select({ n: sql<number>`COUNT(*)` }).from(peerLoanLedger).where(eq(peerLoanLedger.loanId, input.loanId)).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const items = db.select().from(peerLoanLedger).where(eq(peerLoanLedger.loanId, input.loanId)).orderBy(desc(peerLoanLedger.id)).limit(pageSize).offset(offset).all();
    return paginatedResult(items, total, page, pageSize);
  }),

  // ---- 娱乐中心统一配置、预算与业务日 ----
  getEntertainmentControl: adminQuery.query(() => getDb().transaction((tx) => {
    const day = currentBusinessDay(tx);
    const limits = readDailyLimits(tx);
    const drawConfig = readDrawConfig(tx);
    const signinConfig = readSigninConfig(tx);
    const drawPool = tx.select().from(drawFund).where(eq(drawFund.id, 1)).limit(1).get();
    const signinPool = tx.select().from(signinFund).where(eq(signinFund.id, 1)).limit(1).get();
    const [drawCount, signinToday, slotToday] = [
      Number(tx.select({ n: sql<number>`COUNT(*)` }).from(draws).where(sql`${draws.userId} IS NOT NULL`).get()?.n ?? 0),
      Number(tx.select({ n: sql<number>`COUNT(*)` }).from(dailySignins).where(eq(dailySignins.day, day.key)).get()?.n ?? 0),
      Number(tx.select({ n: sql<number>`COUNT(*)` }).from(checkins).where(and(gte(checkins.createdAt, day.startsAt), lt(checkins.createdAt, day.endsAt))).get()?.n ?? 0),
    ];
    return {
      businessDay: day,
      config: {
        businessTimezoneOffsetMinutes: day.timezoneOffsetMinutes,
        businessDayStartHour: day.startHour,
        drawEnabled: drawConfig.enabled,
        drawWinRatePercent: drawConfig.ratePercent,
        drawMinReward: centsToDollars(drawConfig.minUnits),
        drawMaxReward: centsToDollars(drawConfig.maxUnits),
        drawTotalLimit: drawConfig.totalLimit,
        drawBudgetRemaining: centsToDollars(Number(drawPool?.balanceUnits ?? 0)),
        slotEnabled: (tx.select({ value: settings.value }).from(settings)
          .where(eq(settings.key, SETTING_KEYS.checkinEnabled)).limit(1).get()?.value ?? "1") !== "0",
        slotDailyLimit: limits.slot,
        signinEnabled: signinConfig.enabled,
        signinMinReward: centsToDollars(signinConfig.minUnits),
        signinMaxReward: centsToDollars(signinConfig.maxUnits),
        signinMode: signinConfig.mode,
        signinFixedReward: centsToDollars(signinConfig.fixedUnits),
        signinTiers: signinConfig.tiers.map((tier) => ({
          reward: centsToDollars(tier.rewardUnits),
          probabilityPpm: tier.probabilityPpm,
        })),
        signinBudgetRemaining: centsToDollars(Number(signinPool?.balanceUnits ?? 0)),
      },
      stats: { drawCount, signinToday, slotToday },
      semantics: {
        zeroDailyLimit: "0 表示关闭对应功能，不表示无限次数",
        balanceThreshold: "兑换时用户当前余额必须严格低于门槛；等于门槛也会被拒绝",
      },
    };
  })),

  updateEntertainmentConfig: adminQuery.input(entertainmentConfigInput).mutation(({ input }) => {
    const drawMinUnits = dollarsToCents(input.drawMinReward);
    const drawMaxUnits = dollarsToCents(input.drawMaxReward);
    const drawBudgetUnits = dollarsToCents(input.drawBudgetRemaining);
    if (drawMinUnits > drawMaxUnits)
      throw new TRPCError({ code: "BAD_REQUEST", message: "一次性抽奖最小奖励不能大于最大奖励" });
    if (input.drawEnabled && input.drawWinRatePercent > 0 && drawBudgetUnits < drawMaxUnits)
      throw new TRPCError({ code: "BAD_REQUEST", message: "一次性抽奖剩余预算不能低于单次最大奖励" });

    const signinMinUnits = dollarsToCents(input.signinMinReward);
    const signinMaxUnits = dollarsToCents(input.signinMaxReward);
    const signinFixedUnits = dollarsToCents(input.signinFixedReward);
    const signinBudgetUnits = dollarsToCents(input.signinBudgetRemaining);
    if (signinMinUnits > signinMaxUnits)
      throw new TRPCError({ code: "BAD_REQUEST", message: "签到最小奖励不能大于最大奖励" });
    if (signinFixedUnits < signinMinUnits || signinFixedUnits > signinMaxUnits)
      throw new TRPCError({ code: "BAD_REQUEST", message: "固定签到奖励必须位于最小和最大奖励之间" });
    const tiers = input.signinMode === "tiers"
      ? input.signinTiers.map((tier) => ({
        rewardUnits: dollarsToCents(tier.reward),
        probabilityPpm: tier.probabilityPpm,
      }))
      : [{ rewardUnits: signinMinUnits, probabilityPpm: 1_000_000 }];
    try {
      validateWeightedRewards(tiers, signinMinUnits, signinMaxUnits);
    } catch (error) {
      throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "签到分档无效" });
    }
    const signinRiskUnits = input.signinMode === "fixed" ? signinFixedUnits : signinMaxUnits;
    if (input.signinEnabled && signinBudgetUnits < signinRiskUnits)
      throw new TRPCError({ code: "BAD_REQUEST", message: "签到剩余预算不能低于当前模式的单次最大风险" });

    return getDb().transaction((tx) => {
      const values: Array<[string, string]> = [
        [SETTING_KEYS.businessTimezoneOffsetMinutes, String(input.businessTimezoneOffsetMinutes)],
        [SETTING_KEYS.businessDayStartHour, String(input.businessDayStartHour)],
        [SETTING_KEYS.drawEnabled, input.drawEnabled ? "1" : "0"],
        [SETTING_KEYS.drawWinRate, String(input.drawWinRatePercent)],
        [SETTING_KEYS.drawMin, String(input.drawMinReward)],
        [SETTING_KEYS.drawMax, String(input.drawMaxReward)],
        [SETTING_KEYS.drawTotalLimit, String(input.drawTotalLimit)],
        [SETTING_KEYS.checkinEnabled, input.slotEnabled ? "1" : "0"],
        [SETTING_KEYS.slotDailyLimit, String(input.slotDailyLimit)],
        [SETTING_KEYS.dailySigninEnabled, input.signinEnabled ? "1" : "0"],
        [SETTING_KEYS.dailySigninMinUnits, String(signinMinUnits)],
        [SETTING_KEYS.dailySigninMaxUnits, String(signinMaxUnits)],
        [SETTING_KEYS.dailySigninMode, input.signinMode],
        [SETTING_KEYS.dailySigninFixedUnits, String(signinFixedUnits)],
        [SETTING_KEYS.dailySigninTiersJson, JSON.stringify(tiers)],
      ];
      for (const [key, value] of values) upsertSetting(tx, key, value);
      tx.update(drawFund).set({ balanceUnits: drawBudgetUnits, updatedAt: new Date() }).where(eq(drawFund.id, 1)).run();
      tx.update(signinFund).set({ balanceUnits: signinBudgetUnits, updatedAt: new Date() }).where(eq(signinFund.id, 1)).run();
      tx.insert(adminLogs).values({
        action: "更新娱乐中心配置",
        detail: `业务日 UTC${input.businessTimezoneOffsetMinutes >= 0 ? "+" : ""}${input.businessTimezoneOffsetMinutes / 60} ${input.businessDayStartHour}:00；一次抽奖 ${input.drawEnabled ? "开" : "关"}；老虎机每日 ${input.slotDailyLimit} 次（0=关闭）；签到 ${input.signinEnabled ? "开" : "关"}`,
      }).run();
      return { ok: true };
    });
  }),

  getVideoRewardControl: adminQuery.query(() => getDb().transaction((tx) => {
    const config = readVideoRewardConfig(tx);
    const day = currentBusinessDay(tx);
    const fundBalanceUnits = Number(tx.select({ balanceUnits: videoRewardFund.balanceUnits })
      .from(videoRewardFund).where(eq(videoRewardFund.id, 1)).limit(1).get()?.balanceUnits ?? 0);
    const dailySpentUnits = Number(tx.select({ n: sql<number>`COALESCE(SUM(${videoRewardLedger.amountUnits}), 0)` })
      .from(videoRewardLedger).where(eq(videoRewardLedger.businessDay, day.key)).get()?.n ?? 0);
    const [sessionsToday, claimedToday] = [
      Number(tx.select({ n: sql<number>`COUNT(*)` }).from(videoRewardSessions)
        .where(eq(videoRewardSessions.businessDay, day.key)).get()?.n ?? 0),
      Number(tx.select({ n: sql<number>`COUNT(*)` }).from(videoRewardSessions)
        .where(and(eq(videoRewardSessions.businessDay, day.key), eq(videoRewardSessions.status, "claimed"))).get()?.n ?? 0),
    ];
    return {
      businessDay: day,
      config: {
        ...config,
        minReward: videoRewardUnitsToDollars(config.minRewardUnits),
        maxReward: videoRewardUnitsToDollars(config.maxRewardUnits),
        dailyBudget: videoRewardUnitsToDollars(config.dailyBudgetUnits),
        fundBalance: videoRewardUnitsToDollars(fundBalanceUnits),
        fundBalanceUnits,
      },
      stats: {
        sessionsToday,
        claimedToday,
        dailySpentUnits,
        dailySpent: videoRewardUnitsToDollars(dailySpentUnits),
        dailyRemainingUnits: Math.max(0, config.dailyBudgetUnits - dailySpentUnits),
      },
      semantics: {
        zeroBudget: "0 means video rewards are unavailable; it never means unlimited",
        heartbeat: "Only monotonic server-timed heartbeats are credited; client playback time is ignored",
        resource: "Only local public resource paths are allowed; external URLs are rejected",
      },
    };
  })),

  updateVideoRewardConfig: adminQuery.input(videoRewardConfigInput).mutation(({ input }) => {
    if (!isSafeLocalVideoResource(input.videoResource))
      throw new TRPCError({ code: "BAD_REQUEST", message: "Video resource must be a safe local public path" });
    let minRewardUnits: number;
    let maxRewardUnits: number;
    let dailyBudgetUnits: number;
    let fundBalanceUnits: number;
    try {
      minRewardUnits = videoRewardDollarsToUnits(input.minReward);
      maxRewardUnits = videoRewardDollarsToUnits(input.maxReward);
      dailyBudgetUnits = videoRewardDollarsToUnits(input.dailyBudget);
      fundBalanceUnits = videoRewardDollarsToUnits(input.fundBalance);
    } catch (error) {
      throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "Invalid amount" });
    }
    if (minRewardUnits > maxRewardUnits)
      throw new TRPCError({ code: "BAD_REQUEST", message: "Minimum reward cannot exceed maximum reward" });
    if (input.enabled && dailyBudgetUnits < maxRewardUnits)
      throw new TRPCError({ code: "BAD_REQUEST", message: "Enabled daily budget must cover the maximum single reward" });
    if (input.enabled && input.useFund && fundBalanceUnits < maxRewardUnits)
      throw new TRPCError({ code: "BAD_REQUEST", message: "Enabled reward fund must cover the maximum single reward" });

    return getDb().transaction((tx) => {
      const values: Array<[string, string]> = [
        [SETTING_KEYS.videoRewardEnabled, input.enabled ? "1" : "0"],
        [SETTING_KEYS.videoRewardDailyLimit, String(input.dailyLimit)],
        [SETTING_KEYS.videoRewardMinWatchSeconds, String(input.minWatchSeconds)],
        [SETTING_KEYS.videoRewardMinUnits, String(minRewardUnits)],
        [SETTING_KEYS.videoRewardMaxUnits, String(maxRewardUnits)],
        [SETTING_KEYS.videoRewardDailyBudgetUnits, String(dailyBudgetUnits)],
        [SETTING_KEYS.videoRewardUseFund, input.useFund ? "1" : "0"],
        [SETTING_KEYS.videoRewardVideoResource, input.videoResource],
      ];
      for (const [key, value] of values) upsertSetting(tx, key, value);
      tx.insert(videoRewardFund).values({ id: 1, balanceUnits: fundBalanceUnits, updatedAt: new Date() })
        .onConflictDoUpdate({ target: videoRewardFund.id, set: { balanceUnits: fundBalanceUnits, updatedAt: new Date() } }).run();
      tx.insert(adminLogs).values({
        action: "Update daily video reward configuration",
        detail: `${input.enabled ? "enabled" : "disabled"}; ${input.dailyLimit} claims/user/day; watch ${input.minWatchSeconds}s; reward $${input.minReward}-$${input.maxReward}; daily budget $${input.dailyBudget}; fund ${input.useFund ? `$${input.fundBalance}` : "not enforced"}; resource ${input.videoResource}`,
      }).run();
      return { ok: true };
    });
  }),

  listVideoRewardSessionsPage: adminQuery.input(paginationInput.extend({
    businessDay: z.string().trim().max(32).optional(),
    userId: z.number().int().positive().optional(),
    status: z.enum(["active", "ready", "claimed", "expired"]).optional(),
  })).query(({ input }) => getDb().transaction((tx) => {
    const conditions = [];
    if (input.businessDay) conditions.push(eq(videoRewardSessions.businessDay, input.businessDay));
    if (input.userId) conditions.push(eq(videoRewardSessions.userId, input.userId));
    if (input.status) conditions.push(eq(videoRewardSessions.status, input.status));
    const where = conditions.length ? and(...conditions) : undefined;
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(videoRewardSessions).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const rows = tx.select({
      id: videoRewardSessions.id,
      tokenPrefix: sql<string>`substr(${videoRewardSessions.sessionToken}, 1, 10)`,
      startRequestId: videoRewardSessions.startRequestId,
      claimRequestId: videoRewardSessions.claimRequestId,
      userId: videoRewardSessions.userId,
      username: users.username,
      groupName: users.groupName,
      businessDay: videoRewardSessions.businessDay,
      videoResource: videoRewardSessions.videoResource,
      configSnapshot: videoRewardSessions.configSnapshot,
      status: videoRewardSessions.status,
      watchedMs: videoRewardSessions.watchedMs,
      lastSequence: videoRewardSessions.lastSequence,
      rewardUnits: videoRewardSessions.rewardUnits,
      dailySpentBeforeUnits: videoRewardSessions.dailySpentBeforeUnits,
      dailySpentAfterUnits: videoRewardSessions.dailySpentAfterUnits,
      fundBeforeUnits: videoRewardSessions.fundBeforeUnits,
      fundAfterUnits: videoRewardSessions.fundAfterUnits,
      startedAt: videoRewardSessions.startedAt,
      lastHeartbeatAt: videoRewardSessions.lastHeartbeatAt,
      claimedAt: videoRewardSessions.claimedAt,
      updatedAt: videoRewardSessions.updatedAt,
    }).from(videoRewardSessions).leftJoin(users, eq(videoRewardSessions.userId, users.id))
      .where(where).orderBy(desc(videoRewardSessions.id)).limit(pageSize).offset(offset).all();
    const items = rows.map((row) => ({
      ...row,
      reward: row.rewardUnits === null ? null : videoRewardUnitsToDollars(row.rewardUnits),
    }));
    return paginatedResult(items, total, page, pageSize);
  })),

  listDailySignins: adminQuery.query(() => getDb().select({
    id: dailySignins.id,
    requestId: dailySignins.requestId,
    day: dailySignins.day,
    rewardUnits: dailySignins.rewardUnits,
    fundBeforeUnits: dailySignins.fundBeforeUnits,
    fundAfterUnits: dailySignins.fundAfterUnits,
    createdAt: dailySignins.createdAt,
    userId: dailySignins.userId,
    groupName: users.groupName,
    username: users.username,
  }).from(dailySignins).leftJoin(users, eq(dailySignins.userId, users.id))
    .orderBy(desc(dailySignins.id)).limit(200)),

  listAnnouncements: adminQuery.query(() => getDb().select().from(announcements)
    .orderBy(desc(announcements.pinned), desc(announcements.sortOrder), desc(announcements.updatedAt)).limit(500)),

  listDailySigninsPage: adminQuery.input(paginationInput.extend({
    day: z.string().max(32).optional(),
    userId: z.number().int().positive().optional(),
  })).query(({ input }) => getDb().transaction((tx) => {
    const conditions = [];
    if (input.day) conditions.push(eq(dailySignins.day, input.day));
    if (input.userId) conditions.push(eq(dailySignins.userId, input.userId));
    const where = conditions.length ? and(...conditions) : undefined;
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(dailySignins).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const items = tx.select({
      id: dailySignins.id,
      requestId: dailySignins.requestId,
      day: dailySignins.day,
      rewardUnits: dailySignins.rewardUnits,
      fundBeforeUnits: dailySignins.fundBeforeUnits,
      fundAfterUnits: dailySignins.fundAfterUnits,
      createdAt: dailySignins.createdAt,
      userId: dailySignins.userId,
      groupName: users.groupName,
      username: users.username,
    }).from(dailySignins).leftJoin(users, eq(dailySignins.userId, users.id))
      .where(where).orderBy(desc(dailySignins.id)).limit(pageSize).offset(offset).all();
    return paginatedResult(items, total, page, pageSize);
  })),

  listAnnouncementsPage: adminQuery.input(paginationInput.extend({
    status: z.enum(["draft", "published", "withdrawn"]).optional(),
    severity: z.enum(["info", "important", "urgent"]).optional(),
    pinned: z.boolean().optional(),
  })).query(({ input }) => getDb().transaction((tx) => {
    const conditions = [];
    if (input.status) conditions.push(eq(announcements.status, input.status));
    if (input.severity) conditions.push(eq(announcements.severity, input.severity));
    if (input.pinned !== undefined) conditions.push(eq(announcements.pinned, input.pinned));
    const where = conditions.length ? and(...conditions) : undefined;
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(announcements).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const items = tx.select().from(announcements).where(where)
      .orderBy(desc(announcements.pinned), desc(announcements.sortOrder), desc(announcements.updatedAt), desc(announcements.id))
      .limit(pageSize).offset(offset).all();
    return paginatedResult(items, total, page, pageSize);
  })),

  createAnnouncement: adminQuery.input(announcementInput).mutation(({ input }) => getDb().transaction((tx) => {
    let title: string;
    let content: string;
    try {
      title = sanitizeAnnouncementText(input.title, 120);
      content = sanitizeAnnouncementText(input.content, 10_000);
    } catch (error) {
      throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "公告内容无效" });
    }
    const publishedAt = input.status === "published" ? (input.publishedAt ?? new Date()) : input.publishedAt;
    if (input.endsAt && (!publishedAt || input.endsAt <= publishedAt))
      throw new TRPCError({ code: "BAD_REQUEST", message: "公告下线时间必须晚于发布时间" });
    const created = tx.insert(announcements).values({ ...input, title, content, publishedAt }).returning().get();
    tx.insert(adminLogs).values({ action: "创建公告", detail: `#${created.id} ${title}；状态 ${input.status}` }).run();
    return created;
  })),

  updateAnnouncement: adminQuery.input(announcementInput.extend({ id: z.number().int().positive() }))
    .mutation(({ input }) => getDb().transaction((tx) => {
      const existing = tx.select().from(announcements).where(eq(announcements.id, input.id)).limit(1).get();
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "公告不存在" });
      let title: string;
      let content: string;
      try {
        title = sanitizeAnnouncementText(input.title, 120);
        content = sanitizeAnnouncementText(input.content, 10_000);
      } catch (error) {
        throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "公告内容无效" });
      }
      const publishedAt = input.status === "published" ? (input.publishedAt ?? existing.publishedAt ?? new Date()) : input.publishedAt;
      if (input.endsAt && (!publishedAt || input.endsAt <= publishedAt))
        throw new TRPCError({ code: "BAD_REQUEST", message: "公告下线时间必须晚于发布时间" });
      tx.update(announcements).set({ ...input, title, content, publishedAt, updatedAt: new Date() })
        .where(eq(announcements.id, input.id)).run();
      tx.insert(adminLogs).values({ action: "更新公告", detail: `#${input.id} ${title}；${existing.status} → ${input.status}` }).run();
      return tx.select().from(announcements).where(eq(announcements.id, input.id)).get()!;
    })),

  publishAnnouncement: adminQuery.input(z.object({ id: z.number().int().positive(), publishedAt: z.date().optional(), endsAt: z.date().nullable().optional() }))
    .mutation(({ input }) => getDb().transaction((tx) => {
      const row = tx.select().from(announcements).where(eq(announcements.id, input.id)).limit(1).get();
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "公告不存在" });
      const publishedAt = input.publishedAt ?? row.publishedAt ?? new Date();
      const endsAt = input.endsAt === undefined ? row.endsAt : input.endsAt;
      if (endsAt && endsAt <= publishedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "公告下线时间必须晚于发布时间" });
      tx.update(announcements).set({ status: "published", publishedAt, endsAt, updatedAt: new Date() })
        .where(eq(announcements.id, input.id)).run();
      tx.insert(adminLogs).values({ action: "发布公告", detail: `#${row.id} ${row.title}；发布时间 ${publishedAt.toISOString()}` }).run();
      return { ok: true };
    })),

  withdrawAnnouncement: adminQuery.input(z.object({ id: z.number().int().positive() })).mutation(({ input }) =>
    getDb().transaction((tx) => {
      const row = tx.select().from(announcements).where(eq(announcements.id, input.id)).limit(1).get();
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "公告不存在" });
      tx.update(announcements).set({ status: "withdrawn", updatedAt: new Date() }).where(eq(announcements.id, row.id)).run();
      tx.insert(adminLogs).values({ action: "撤回公告", detail: `#${row.id} ${row.title}` }).run();
      return { ok: true };
    })),

  deleteAnnouncement: adminQuery.input(z.object({ id: z.number().int().positive() })).mutation(({ input }) =>
    getDb().transaction((tx) => {
      const row = tx.select().from(announcements).where(eq(announcements.id, input.id)).limit(1).get();
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "公告不存在" });
      tx.delete(announcements).where(eq(announcements.id, row.id)).run();
      tx.insert(adminLogs).values({ action: "删除公告", detail: `#${row.id} ${row.title}；删除前状态 ${row.status}` }).run();
      return { ok: true };
    })),

  // ---- 老虎机：版本配置、奖金池、活动与每日次数限制 ----
  getSlotControl: adminQuery.input(z.object({
    configs: paginationInput.optional(),
    promotions: paginationInput.optional(),
    ledger: paginationInput.optional(),
  }).optional()).query(({ input }) => getDb().transaction((tx) => {
    const state = resolveSlotState(tx);
    const configTotal = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(slotConfigs).get()?.n ?? 0);
    const promotionTotal = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(slotPromotions).get()?.n ?? 0);
    const ledgerTotal = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(slotFundLedger).get()?.n ?? 0);
    const configRequest = paginationParams(input?.configs, 20);
    const promotionRequest = paginationParams(input?.promotions, 20);
    const ledgerRequest = paginationParams(input?.ledger, 50);
    const configPage = resolvePagination(configTotal, configRequest.requestedPage, configRequest.pageSize);
    const promotionPage = resolvePagination(promotionTotal, promotionRequest.requestedPage, promotionRequest.pageSize);
    const ledgerPage = resolvePagination(ledgerTotal, ledgerRequest.requestedPage, ledgerRequest.pageSize);
    const configs = tx.select().from(slotConfigs).orderBy(desc(slotConfigs.id))
      .limit(configPage.pageSize).offset(configPage.offset).all();
    const promotions = tx.select().from(slotPromotions).orderBy(desc(slotPromotions.id))
      .limit(promotionPage.pageSize).offset(promotionPage.offset).all();
    const ledger = tx.select().from(slotFundLedger).orderBy(desc(slotFundLedger.id))
      .limit(ledgerPage.pageSize).offset(ledgerPage.offset).all();
    const promotionConfigIds = [...new Set(promotions.map((promotion) => promotion.configId))];
    const visibleVersions = promotionConfigIds.length
      ? tx.select({ id: slotConfigs.id, version: slotConfigs.version }).from(slotConfigs).where(inArray(slotConfigs.id, promotionConfigIds)).all()
      : [];
    const configVersions = new Map(visibleVersions.map((config) => [config.id, config.version]));
    return {
      active: publicSlotState(state),
      fund: {
        balance: moneyUnitsToDollars(state.fund.balanceUnits),
        reserve: moneyUnitsToDollars(state.fund.reserveUnits),
        availableAboveReserve: moneyUnitsToDollars(Math.max(0, state.fund.balanceUnits - state.fund.reserveUnits)),
        dailyLossLimit: moneyUnitsToDollars(state.fund.dailyLossLimitUnits),
        dayNet: moneyUnitsToDollars(state.fund.dayNetUnits),
        dailyLossUsed: moneyUnitsToDollars(Math.max(0, -state.fund.dayNetUnits)),
        day: state.fund.day,
      },
      configs: configs.map((config) => {
        const rules = parseSlotRules(config.rulesJson);
        return {
          id: config.id,
          version: config.version,
          name: config.name,
          mode: config.mode,
          status: config.status,
          minBet: moneyUnitsToDollars(config.minBetUnits),
          maxBet: moneyUnitsToDollars(config.maxBetUnits),
          winRatePercent: formatProbabilityPercent(config.winRatePpm),
          rtpPercent: formatProbabilityPercent(config.rtpPpm),
          maxMultiplier: formatMultiplier(config.maxMultiplierBasisPoints),
          maxNetLiability: moneyUnitsToDollars(config.maxNetLiabilityUnits),
          tiers: rules.tiers.map((tier) => ({
            ...tier,
            probabilityPercent: formatProbabilityPercent(tier.probabilityPpm),
            multiplier: formatMultiplier(tier.multiplierBasisPoints),
          })),
          createdAt: config.createdAt,
          activatedAt: config.activatedAt,
        };
      }),
      promotions: promotions.map((promotion) => ({
        ...promotion,
        configVersion: configVersions.get(promotion.configId) ?? "未知配置",
        budget: moneyUnitsToDollars(promotion.budgetUnits),
        spent: moneyUnitsToDollars(promotion.spentUnits),
        remaining: moneyUnitsToDollars(Math.max(0, promotion.budgetUnits - promotion.spentUnits)),
      })),
      ledger: ledger.map((entry) => ({
        ...entry,
        amount: moneyUnitsToDollars(entry.amountUnits),
        balanceAfter: moneyUnitsToDollars(entry.balanceAfterUnits),
      })),
      pages: {
        configs: { page: configPage.page, pageSize: configPage.pageSize, total: configPage.total, totalPages: configPage.totalPages },
        promotions: { page: promotionPage.page, pageSize: promotionPage.pageSize, total: promotionPage.total, totalPages: promotionPage.totalPages },
        ledger: { page: ledgerPage.page, pageSize: ledgerPage.pageSize, total: ledgerPage.total, totalPages: ledgerPage.totalPages },
      },
      symbols: SLOT_SYMBOL_DEFINITIONS,
    };
  })),

  previewSlotConfig: adminQuery.input(slotConfigInput).mutation(({ input }) => {
    const rules = parseSlotConfig(input, `preview-${input.mode}`);
    const metrics = slotMetrics(rules);
    return {
      winRatePercent: formatProbabilityPercent(metrics.winRatePpm),
      lossRatePercent: formatProbabilityPercent(metrics.lossRatePpm),
      rtpPercent: formatProbabilityPercent(metrics.rtpPpm),
      houseEdgePercent: formatProbabilityPercent(metrics.houseEdgePpm),
      maxMultiplier: formatMultiplier(metrics.maxMultiplierBasisPoints),
      maxGrossPayout: moneyUnitsToDollars(metrics.maxGrossPayoutUnits),
      maxNetLiability: moneyUnitsToDollars(metrics.maxNetLiabilityUnits),
    };
  }),

  createSlotDraft: adminQuery.input(slotConfigInput).mutation(async ({ input }) => {
    const version = `slot-${input.mode}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const rules = parseSlotConfig(input, version);
    const metrics = slotMetrics(rules);
    const created = getDb().insert(slotConfigs).values({
      version,
      name: rules.name,
      mode: input.mode,
      status: "draft",
      rulesJson: serializeSlotRules(rules),
      minBetUnits: rules.minBetUnits,
      maxBetUnits: rules.maxBetUnits,
      winRatePpm: metrics.winRatePpm,
      rtpPpm: metrics.rtpPpm,
      maxMultiplierBasisPoints: metrics.maxMultiplierBasisPoints,
      maxNetLiabilityUnits: metrics.maxNetLiabilityUnits,
    }).returning().get();
    await logAdmin(
      "新建老虎机配置草稿",
      `${created.version}（${input.mode === "base" ? "基础" : "活动"}）：中奖率 ${formatProbabilityPercent(metrics.winRatePpm)}%，RTP ${formatProbabilityPercent(metrics.rtpPpm)}%，最大净负债 $${moneyUnitsToDollars(metrics.maxNetLiabilityUnits).toFixed(2)}`,
    );
    return { id: created.id, version: created.version };
  }),

  activateSlotConfig: adminQuery.input(z.object({ configId: z.number().int().positive() })).mutation(async ({ input }) => {
    const activated = getDb().transaction((tx) => {
      const config = tx.select().from(slotConfigs).where(eq(slotConfigs.id, input.configId)).limit(1).get();
      if (!config) throw new TRPCError({ code: "NOT_FOUND", message: "配置不存在" });
      if (config.mode !== "base") throw new TRPCError({ code: "BAD_REQUEST", message: "活动配置请通过活动计划启用" });
      parseSlotRules(config.rulesJson);
      tx.update(slotConfigs).set({ status: "retired" })
        .where(and(eq(slotConfigs.mode, "base"), eq(slotConfigs.status, "active"))).run();
      return tx.update(slotConfigs).set({ status: "active", activatedAt: new Date() })
        .where(eq(slotConfigs.id, config.id)).returning().get();
    });
    await logAdmin("启用老虎机基础配置", `${activated.version} / ${activated.name}`);
    return { ok: true, version: activated.version };
  }),

  updateSlotRisk: adminQuery.input(z.object({
    reserve: z.string().max(24),
    dailyLossLimit: z.string().max(24),
  })).mutation(async ({ input }) => {
    const reserveUnits = dollarsStringToMoneyUnits(input.reserve);
    const dailyLossLimitUnits = dollarsStringToMoneyUnits(input.dailyLossLimit);
    if (reserveUnits === null || dailyLossLimitUnits === null)
      throw new TRPCError({ code: "BAD_REQUEST", message: "准备金和每日亏损上限必须是非负数且最多两位小数" });
    getDb().update(slotFund).set({ reserveUnits, dailyLossLimitUnits, updatedAt: new Date() })
      .where(eq(slotFund.id, 1)).run();
    await logAdmin("修改老虎机风险控制", `准备金 $${moneyUnitsToDollars(reserveUnits).toFixed(2)}；每日实际亏损上限 $${moneyUnitsToDollars(dailyLossLimitUnits).toFixed(2)}`);
    return { ok: true };
  }),

  adjustSlotFund: adminQuery.input(z.object({
    amount: z.string().max(24),
    reason: z.string().trim().min(3).max(256),
  })).mutation(async ({ input }) => {
    const amountUnits = signedMoneyUnits(input.amount);
    if (amountUnits === null || amountUnits === 0)
      throw new TRPCError({ code: "BAD_REQUEST", message: "调整金额必须是非零数字且最多两位小数" });
    const result = getDb().transaction((tx) => {
      const fund = tx.select().from(slotFund).where(eq(slotFund.id, 1)).limit(1).get();
      if (!fund) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "奖金池尚未初始化" });
      const balanceAfterUnits = fund.balanceUnits + amountUnits;
      if (balanceAfterUnits < 0) throw new TRPCError({ code: "BAD_REQUEST", message: "调减后奖金池不能为负数" });
      tx.update(slotFund).set({ balanceUnits: balanceAfterUnits, updatedAt: new Date() }).where(eq(slotFund.id, 1)).run();
      tx.insert(slotFundLedger).values({
        type: "adjustment",
        amountUnits,
        balanceAfterUnits,
        note: input.reason,
      }).run();
      return balanceAfterUnits;
    });
    await logAdmin("调整老虎机奖金池", `${amountUnits > 0 ? "+" : ""}$${moneyUnitsToDollars(amountUnits).toFixed(2)}；${input.reason}`);
    return { ok: true, balance: moneyUnitsToDollars(result) };
  }),

  createSlotPromotion: adminQuery.input(z.object({
    configId: z.number().int().positive(),
    name: z.string().trim().min(1).max(96),
    startsAt: z.number().int().positive(),
    endsAt: z.number().int().positive(),
    budget: z.string().max(24),
  })).mutation(async ({ input }) => {
    if (input.endsAt <= input.startsAt) throw new TRPCError({ code: "BAD_REQUEST", message: "活动结束时间必须晚于开始时间" });
    if (input.endsAt <= Date.now()) throw new TRPCError({ code: "BAD_REQUEST", message: "活动结束时间必须在未来" });
    const budgetUnits = dollarsStringToMoneyUnits(input.budget);
    if (budgetUnits === null || budgetUnits <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "活动预算必须大于 0" });
    const promotion = getDb().transaction((tx) => {
      const config = tx.select().from(slotConfigs).where(eq(slotConfigs.id, input.configId)).limit(1).get();
      if (!config || config.mode !== "promotion") throw new TRPCError({ code: "BAD_REQUEST", message: "请选择活动模式配置" });
      const rules = parseSlotRules(config.rulesJson);
      const minimumLiability = maxNetLiabilityForBet(rules, rules.minBetUnits);
      if (budgetUnits < minimumLiability)
        throw new TRPCError({ code: "BAD_REQUEST", message: `活动预算至少需要覆盖最小下注的最坏净赔付 $${moneyUnitsToDollars(minimumLiability).toFixed(2)}` });
      const overlap = tx.select({ id: slotPromotions.id }).from(slotPromotions).where(and(
        inArray(slotPromotions.status, ["scheduled", "active"]),
        lt(slotPromotions.startsAt, new Date(input.endsAt)),
        gt(slotPromotions.endsAt, new Date(input.startsAt)),
      )).limit(1).get();
      if (overlap) throw new TRPCError({ code: "CONFLICT", message: "该时间段已有其他老虎机活动" });
      tx.update(slotConfigs).set({ status: "published" }).where(eq(slotConfigs.id, config.id)).run();
      return tx.insert(slotPromotions).values({
        configId: config.id,
        name: input.name,
        status: input.startsAt <= Date.now() ? "active" : "scheduled",
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        budgetUnits,
      }).returning().get();
    });
    await logAdmin("创建老虎机放水活动", `${promotion.name}：预算 $${moneyUnitsToDollars(promotion.budgetUnits).toFixed(2)}，${promotion.startsAt.toISOString()}–${promotion.endsAt.toISOString()}`);
    return { ok: true, id: promotion.id };
  }),

  stopSlotPromotion: adminQuery.input(z.object({ promotionId: z.number().int().positive() })).mutation(async ({ input }) => {
    const stopped = getDb().update(slotPromotions).set({ status: "stopped", stoppedAt: new Date() })
      .where(and(eq(slotPromotions.id, input.promotionId), inArray(slotPromotions.status, ["scheduled", "active"])))
      .returning().get();
    if (!stopped) throw new TRPCError({ code: "BAD_REQUEST", message: "活动不存在或已经结束" });
    await logAdmin("停止老虎机放水活动", `${stopped.name}（#${stopped.id}）`);
    return { ok: true };
  }),

  // ---- 幸运决斗场：版本化配置与全链路审计 ----
  getDuelControl: adminQuery.input(z.object({
    rooms: paginationInput.extend({
      game: z.enum(["dice", "blackjack"]).optional(),
      status: z.enum(["lobby", "active", "settled", "cancelled", "refunded"]).optional(),
    }).optional(),
    ledger: paginationInput.extend({
      roomId: z.string().uuid().optional(),
      userId: z.number().int().positive().optional(),
      type: z.string().max(64).optional(),
    }).optional(),
    versions: paginationInput.optional(),
  }).optional()).query(({ input }) => getDb().transaction((tx) => {
    const config = tx.select().from(duelConfigs).where(eq(duelConfigs.active, true)).orderBy(desc(duelConfigs.version)).limit(1).get();
    if (!config) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "决斗场配置尚未初始化" });
    const fund = tx.select().from(duelFund).where(eq(duelFund.id, 1)).limit(1).get();
    const roomConditions = [];
    if (input?.rooms?.game) roomConditions.push(eq(duelRooms.game, input.rooms.game));
    if (input?.rooms?.status) roomConditions.push(eq(duelRooms.status, input.rooms.status));
    const roomWhere = roomConditions.length ? and(...roomConditions) : undefined;
    const ledgerConditions = [];
    if (input?.ledger?.roomId) ledgerConditions.push(eq(duelLedger.roomId, input.ledger.roomId));
    if (input?.ledger?.userId) ledgerConditions.push(eq(duelLedger.userId, input.ledger.userId));
    if (input?.ledger?.type) ledgerConditions.push(eq(duelLedger.type, input.ledger.type));
    const ledgerWhere = ledgerConditions.length ? and(...ledgerConditions) : undefined;
    const roomTotal = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(duelRooms).where(roomWhere).get()?.n ?? 0);
    const ledgerTotal = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(duelLedger).where(ledgerWhere).get()?.n ?? 0);
    const versionTotal = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(duelConfigs).get()?.n ?? 0);
    const roomRequest = paginationParams(input?.rooms, 20);
    const ledgerRequest = paginationParams(input?.ledger, 50);
    const versionRequest = paginationParams(input?.versions, 20);
    const roomPage = resolvePagination(roomTotal, roomRequest.requestedPage, roomRequest.pageSize);
    const ledgerPage = resolvePagination(ledgerTotal, ledgerRequest.requestedPage, ledgerRequest.pageSize);
    const versionPage = resolvePagination(versionTotal, versionRequest.requestedPage, versionRequest.pageSize);
    const rooms = tx.select({
      id: duelRooms.id, code: duelRooms.code, game: duelRooms.game, visibility: duelRooms.visibility,
      status: duelRooms.status, ownerId: duelRooms.ownerId, configVersion: duelRooms.configVersion,
      betUnits: duelRooms.betUnits,
      winnerTaxBasisPoints: duelRooms.winnerTaxBasisPoints,
      grossPrizePoolUnits: duelRooms.grossPrizePoolUnits,
      winnerTaxUnits: duelRooms.winnerTaxUnits,
      netPrizePoolUnits: duelRooms.netPrizePoolUnits,
      potUnits: duelRooms.potUnits, feeUnits: duelRooms.feeUnits,
      playerCount: sql<number>`COUNT(${duelPlayers.id})`, seedHash: duelRooms.seedHash,
      seedReveal: duelRooms.seedReveal, createdAt: duelRooms.createdAt, startedAt: duelRooms.startedAt, finishedAt: duelRooms.finishedAt,
      voidedAt: duelRooms.voidedAt, voidReason: duelRooms.voidReason,
    }).from(duelRooms).leftJoin(duelPlayers, eq(duelRooms.id, duelPlayers.roomId))
      .where(roomWhere).groupBy(duelRooms.id).orderBy(desc(duelRooms.createdAt), desc(duelRooms.id))
      .limit(roomPage.pageSize).offset(roomPage.offset).all();
    const ledger = tx.select().from(duelLedger).where(ledgerWhere).orderBy(desc(duelLedger.id))
      .limit(ledgerPage.pageSize).offset(ledgerPage.offset).all();
    const versions = tx.select().from(duelConfigs).orderBy(desc(duelConfigs.version))
      .limit(versionPage.pageSize).offset(versionPage.offset).all();
    const publicConfig = (row: typeof config) => ({
      ...row,
      winnerTaxBasisPoints: row.winnerTaxBasisPoints,
      winnerTaxPercent: row.winnerTaxBasisPoints / 100,
      betOptions: (JSON.parse(row.betOptionsJson) as number[]).map(duelUnitsToDollars),
      quickBetOptions: (JSON.parse(row.betOptionsJson) as number[]).map(duelUnitsToDollars),
      minBet: duelUnitsToDollars(row.minBetUnits),
      maxBet: duelUnitsToDollars(row.maxBetUnits),
      betPrecision: row.betPrecision,
      blackjackActionWindowSeconds: 60,
      singleBetLimit: duelUnitsToDollars(row.singleBetLimitUnits),
      dailyStakeLimit: duelUnitsToDollars(row.dailyStakeLimitUnits),
      dailyNetLossLimit: duelUnitsToDollars(row.dailyNetLossLimitUnits),
    });
    return {
      config: publicConfig(config),
      versions: versions.map(publicConfig),
      fund: { balanceUnits: fund?.balanceUnits ?? 0, balance: duelUnitsToDollars(fund?.balanceUnits ?? 0) },
      rooms: rooms.map((room) => ({
        ...room,
        bet: duelUnitsToDollars(room.betUnits),
        pot: duelUnitsToDollars(room.potUnits),
        fee: duelUnitsToDollars(room.feeUnits),
        winnerTaxPercent: room.winnerTaxBasisPoints / 100,
        grossPrizePool: duelUnitsToDollars(room.grossPrizePoolUnits),
        winnerTax: duelUnitsToDollars(room.winnerTaxUnits),
        netPrizePool: duelUnitsToDollars(room.netPrizePoolUnits),
      })),
      ledger: ledger.map((entry) => ({ ...entry, amount: duelUnitsToDollars(entry.amountUnits) })),
      pages: {
        rooms: { page: roomPage.page, pageSize: roomPage.pageSize, total: roomPage.total, totalPages: roomPage.totalPages },
        ledger: { page: ledgerPage.page, pageSize: ledgerPage.pageSize, total: ledgerPage.total, totalPages: ledgerPage.totalPages },
        versions: { page: versionPage.page, pageSize: versionPage.pageSize, total: versionPage.total, totalPages: versionPage.totalPages },
      },
    };
  })),

  listDuelPlayersPage: adminQuery.input(paginationInput.extend({
    roomId: z.string().uuid().optional(),
    userId: z.number().int().positive().optional(),
    game: z.enum(["dice", "blackjack"]).optional(),
    status: z.string().max(32).optional(),
  })).query(({ input }) => getDb().transaction((tx) => {
    const conditions = [];
    if (input.roomId) conditions.push(eq(duelPlayers.roomId, input.roomId));
    if (input.userId) conditions.push(eq(duelPlayers.userId, input.userId));
    if (input.game) conditions.push(eq(duelPlayers.gameType, input.game));
    if (input.status) conditions.push(eq(duelPlayers.status, input.status));
    const where = conditions.length ? and(...conditions) : undefined;
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(duelPlayers).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const items = tx.select({
      id: duelPlayers.id,
      roomId: duelPlayers.roomId,
      roomCode: duelRooms.code,
      roomStatus: duelRooms.status,
      userId: duelPlayers.userId,
      groupName: users.groupName,
      username: users.username,
      gameType: duelPlayers.gameType,
      seat: duelPlayers.seat,
      ready: duelPlayers.ready,
      status: duelPlayers.status,
      balanceBeforeUnits: duelPlayers.balanceBeforeUnits,
      stakeUnits: duelPlayers.stakeUnits,
      payoutUnits: duelPlayers.payoutUnits,
      settledNetUnits: duelPlayers.settledNetUnits,
      result: duelPlayers.result,
      score: duelPlayers.score,
      joinedAt: duelPlayers.joinedAt,
      settledAt: duelPlayers.settledAt,
      voidedAt: duelPlayers.voidedAt,
    }).from(duelPlayers)
      .innerJoin(duelRooms, eq(duelPlayers.roomId, duelRooms.id))
      .innerJoin(users, eq(duelPlayers.userId, users.id))
      .where(where).orderBy(desc(duelPlayers.id)).limit(pageSize).offset(offset).all();
    return paginatedResult(items.map((item) => {
      const concealed = item.roomStatus === "active" && item.gameType === "blackjack";
      return {
        ...item,
        status: concealed ? (item.status === "active" ? "acting" : "completed") : item.status,
        score: concealed ? null : item.score,
        result: concealed ? "pending" : item.result,
        balanceBefore: item.balanceBeforeUnits == null ? null : duelUnitsToDollars(item.balanceBeforeUnits),
        stake: duelUnitsToDollars(item.stakeUnits),
        payout: duelUnitsToDollars(item.payoutUnits),
        settledNet: duelUnitsToDollars(item.settledNetUnits),
      };
    }), total, page, pageSize);
  })),

  updateDuelConfig: adminQuery.input(duelConfigInput).mutation(async ({ input }) => {
    if (input.minPlayers > input.maxPlayers) throw new TRPCError({ code: "BAD_REQUEST", message: "最少人数不能大于最多人数" });
    const betPrecision = input.betPrecision ?? 2;
    const minBet = input.minBet ?? Math.min(...input.betOptions);
    const maxBet = input.maxBet ?? input.singleBetLimit;
    if (minBet > maxBet || maxBet > input.singleBetLimit) throw new TRPCError({ code: "BAD_REQUEST", message: "自定义押注范围必须满足最小值 ≤ 最大值 ≤ 单局上限" });
    if (![minBet, maxBet, ...input.betOptions].every((amount) => duelAmountHasPrecision(amount, betPrecision))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `自定义押注范围和快捷金额最多保留 ${betPrecision} 位小数` });
    }
    const betOptionsUnits = [...new Set(input.betOptions.map(duelDollarsToUnits))].sort((a, b) => a - b);
    const minBetUnits = duelDollarsToUnits(minBet);
    const maxBetUnits = duelDollarsToUnits(maxBet);
    const singleBetLimitUnits = duelDollarsToUnits(input.singleBetLimit);
    const dailyStakeLimitUnits = duelDollarsToUnits(input.dailyStakeLimit);
    const dailyNetLossLimitUnits = duelDollarsToUnits(input.dailyNetLossLimit);
    if (betOptionsUnits.some((units) => units < minBetUnits || units > maxBetUnits)) throw new TRPCError({ code: "BAD_REQUEST", message: "快捷押注金额必须位于自定义押注范围内" });
    if (dailyStakeLimitUnits < singleBetLimitUnits || dailyNetLossLimitUnits < singleBetLimitUnits) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "每日押注与净亏损上限不能低于单局上限" });
    }
    const created = getDb().transaction((tx) => {
      const previous = tx.select().from(duelConfigs).where(eq(duelConfigs.active, true)).orderBy(desc(duelConfigs.version)).limit(1).get();
      const version = (previous?.version ?? 0) + 1;
      tx.update(duelConfigs).set({ active: false }).where(eq(duelConfigs.active, true)).run();
      return tx.insert(duelConfigs).values({
        version, active: true, enabled: input.enabled, diceEnabled: input.diceEnabled,
        blackjackEnabled: input.blackjackEnabled,
        winnerTaxBasisPoints: input.feeBasisPoints,
        feeBasisPoints: input.feeBasisPoints,
        betOptionsJson: JSON.stringify(betOptionsUnits), minPlayers: input.minPlayers, maxPlayers: input.maxPlayers,
        roomTimeoutSeconds: input.roomTimeoutSeconds, actionTimeoutSeconds: input.actionTimeoutSeconds,
        minBetUnits, maxBetUnits, betPrecision,
        singleBetLimitUnits, dailyStakeLimitUnits, dailyNetLossLimitUnits,
      }).returning().get();
    });
    await logAdmin(
      "更新决斗场配置",
      `v${created.version}；总开关 ${input.enabled ? "开" : "关"}；骰子 ${input.diceEnabled ? "开" : "关"}；二十一点 ${input.blackjackEnabled ? "开" : "关"}（暗牌并行 60 秒）；赢家税率 ${(input.feeBasisPoints / 100).toFixed(2)}%（从毛奖池一次扣除）；自定义押注 $${minBet}～$${maxBet}（最多 ${betPrecision} 位小数），快捷金额 ${input.betOptions.map((amount) => `$${amount}`).join(" / ")}`,
    );
    return { ok: true, version: created.version };
  }),

  getDuelRoom: adminQuery.input(z.object({ roomId: z.string().uuid() })).query(({ input }) => getDb().transaction((tx) => {
    const room = tx.select().from(duelRooms).where(eq(duelRooms.id, input.roomId)).limit(1).get();
    if (!room) throw new TRPCError({ code: "NOT_FOUND", message: "决斗房间不存在" });
    const players = tx.select({
      id: duelPlayers.id, userId: duelPlayers.userId, seat: duelPlayers.seat, ready: duelPlayers.ready,
      status: duelPlayers.status, balanceBeforeUnits: duelPlayers.balanceBeforeUnits, stakeUnits: duelPlayers.stakeUnits,
      payoutUnits: duelPlayers.payoutUnits, settledNetUnits: duelPlayers.settledNetUnits, result: duelPlayers.result,
      handJson: duelPlayers.handJson, score: duelPlayers.score, gameType: duelPlayers.gameType,
      settledAt: duelPlayers.settledAt, voidedAt: duelPlayers.voidedAt,
      groupName: users.groupName, username: users.username,
    }).from(duelPlayers).innerJoin(users, eq(duelPlayers.userId, users.id))
      .where(eq(duelPlayers.roomId, room.id)).orderBy(duelPlayers.seat).all();
    const events = tx.select().from(duelEvents).where(eq(duelEvents.roomId, room.id)).orderBy(duelEvents.seq).all();
    const ledger = tx.select().from(duelLedger).where(eq(duelLedger.roomId, room.id)).orderBy(duelLedger.id).all();
    const rawState = JSON.parse(room.stateJson) as { kind?: string; deck?: unknown[]; hands?: Record<string, unknown[]> };
    const state = room.status === "active" && rawState.kind === "blackjack"
      ? {
          kind: "blackjack",
          hands: Object.fromEntries(Object.entries(rawState.hands ?? {}).map(([seat, cards]) => [seat, cards.map(() => null)])),
          actions: ((rawState as { actions?: Array<{ seat: number; at: number; action?: string }> }).actions ?? [])
            .map((action) => ({ seat: action.seat, at: action.at, completed: action.action === "stand" || action.action === "auto_stand" })),
        }
      : rawState;
    return {
      room: { ...room, seedSecret: undefined, stateJson: undefined, state, configSnapshot: JSON.parse(room.configSnapshotJson) as unknown },
      players: players.map(({ handJson, ...player }) => {
        const concealed = room.status === "active" && room.game === "blackjack";
        return {
          ...player,
          status: concealed ? (player.status === "active" ? "acting" : "completed") : player.status,
          score: concealed ? null : player.score,
          result: concealed ? "pending" : player.result,
          balanceBefore: player.balanceBeforeUnits == null ? null : duelUnitsToDollars(player.balanceBeforeUnits),
          stake: duelUnitsToDollars(player.stakeUnits), payout: duelUnitsToDollars(player.payoutUnits),
          settledNet: duelUnitsToDollars(player.settledNetUnits),
          hand: concealed ? null : JSON.parse(handJson) as unknown,
        };
      }),
      events: events.map(({ payloadJson, ...event }) => {
        const payload = JSON.parse(payloadJson) as Record<string, unknown>;
        if (room.status === "active" && room.game === "blackjack" && event.type === "blackjack_action") {
          return { ...event, payload: { roundNo: payload.roundNo, seat: payload.seat, completed: payload.status !== "acting" } };
        }
        return { ...event, payload };
      }),
      ledger: ledger.map((entry) => ({ ...entry, amount: duelUnitsToDollars(entry.amountUnits) })),
    };
  })),

  voidDuelRoom: adminQuery.input(z.object({
    roomId: z.string().uuid(),
    reason: z.string().trim().min(4, "请填写至少 4 个字的作废原因").max(500),
  })).mutation(({ input }) => getDb().transaction((tx) => {
    const room = tx.select().from(duelRooms).where(eq(duelRooms.id, input.roomId)).limit(1).get();
    if (!room) throw new TRPCError({ code: "NOT_FOUND", message: "决斗房间不存在" });
    if (room.voidedAt) throw new TRPCError({ code: "CONFLICT", message: "该房间已经作废，不能重复操作" });
    if (room.status !== "settled") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "仅已结算房间可从排行榜统计中作废" });
    }

    const now = new Date();
    const updated = tx.update(duelRooms).set({ voidedAt: now, voidReason: input.reason })
      .where(and(eq(duelRooms.id, room.id), isNull(duelRooms.voidedAt), eq(duelRooms.status, "settled")))
      .returning().get();
    if (!updated) throw new TRPCError({ code: "CONFLICT", message: "房间状态已变化，请刷新后重试" });

    // 保留押注、派彩、净输赢及原始流水作为财务审计快照；只改变榜单统计状态。
    tx.update(duelPlayers).set({ result: "void", voidedAt: now, updatedAt: now })
      .where(eq(duelPlayers.roomId, room.id)).run();
    const nextSeq = Number(tx.select({ value: sql<number>`COALESCE(MAX(${duelEvents.seq}), 0) + 1` })
      .from(duelEvents).where(eq(duelEvents.roomId, room.id)).get()?.value ?? 1);
    tx.insert(duelEvents).values({
      roomId: room.id,
      seq: nextSeq,
      requestId: randomUUID(),
      type: "admin_voided",
      payloadJson: JSON.stringify({ reason: input.reason, statisticsOnly: true }),
    }).run();
    tx.insert(adminLogs).values({
      action: "作废决斗场排行榜统计",
      detail: `房间 ${room.code}（${room.id}）：${input.reason}；仅排除榜单统计，未反转余额或原始流水`,
    }).run();
    return { ok: true, roomId: room.id, voidedAt: now, statisticsOnly: true };
  })),

  logout: adminQuery.mutation(async ({ ctx }) => {
    ctx.resHeaders.append("set-cookie", clearCookieHeader(ADMIN_COOKIE, requestUsesHttps(ctx.req)));
    return { ok: true };
  }),

  check: adminQuery.query(() => ({ ok: true })),

  // ---- 操作日志 ----
  listAdminLogs: adminQuery.query(async () => {
    return getDb().select().from(adminLogs).orderBy(desc(adminLogs.id)).limit(200);
  }),

  listAdminLogsPage: adminQuery.input(paginationInput.extend({
    keyword: z.string().trim().max(64).optional(),
    from: z.date().optional(),
    to: z.date().optional(),
  })).query(({ input }) => getDb().transaction((tx) => {
    const conditions = [];
    if (input.keyword) {
      const pattern = `%${input.keyword.toLowerCase()}%`;
      conditions.push(or(
        sql`lower(${adminLogs.action}) LIKE ${pattern}`,
        sql`lower(${adminLogs.detail}) LIKE ${pattern}`,
      )!);
    }
    if (input.from) conditions.push(gte(adminLogs.createdAt, input.from));
    if (input.to) conditions.push(lt(adminLogs.createdAt, input.to));
    const where = conditions.length ? and(...conditions) : undefined;
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(adminLogs).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const items = tx.select().from(adminLogs).where(where).orderBy(desc(adminLogs.id))
      .limit(pageSize).offset(offset).all();
    return paginatedResult(items, total, page, pageSize);
  })),

  // ---- 总览 ----
  stats: adminQuery.query(async () => {
    const db = getDb();
    const [u] = await db.select({ n: sql<number>`COUNT(*)` }).from(users).where(registeredUser);
    const [w] = await db.select({ n: sql<number>`COUNT(*)` }).from(draws).where(eq(draws.won, true));
    const [d] = await db.select({ n: sql<number>`COUNT(*)` }).from(draws);
    const [c] = await db.select({ n: sql<number>`COUNT(*)` }).from(inviteCodes).where(and(
      eq(inviteCodes.type, "invite"),
      isNull(inviteCodes.usedBy),
      isNull(inviteCodes.archivedAt),
    ));
    const [cost] = await db.select({ total: sql<string>`COALESCE(SUM(cost),0)` }).from(usageLogs);
    const [given] = await db.select({ total: sql<string>`COALESCE(SUM(total_won),0)` }).from(users).where(registeredUser);
    return {
      users: u.n,
      winDraws: w.n,
      totalDraws: d.n,
      unusedInvites: c.n,
      totalConsumed: cost.total,
      totalGiven: given.total,
    };
  }),

  /** 近 14 天统计序列（按 UTC+8 自然日聚合）：调用量 / 消耗 / 新增用户 */
  statsSeries: adminQuery.query(async () => {
    const db = getDb();
    const startTs = Date.now() - 13 * 86400000 - 8 * 3600000; // 覆盖 14 个自然日（UTC+8）
    const dayExpr = (col: unknown) => sql<string>`strftime('%Y-%m-%d', ${col} / 1000, 'unixepoch', '+8 hours')`;

    const usageRows = await db
      .select({
        day: dayExpr(usageLogs.createdAt),
        calls: sql<number>`COUNT(*)`,
        cost: sql<number>`COALESCE(SUM(cost), 0)`,
      })
      .from(usageLogs)
      .where(sql`${usageLogs.createdAt} >= ${startTs}`)
      .groupBy(dayExpr(usageLogs.createdAt));
    const userRows = await db
      .select({ day: dayExpr(users.createdAt), n: sql<number>`COUNT(*)` })
      .from(users)
      .where(and(sql`${users.createdAt} >= ${startTs}`, registeredUser))
      .groupBy(dayExpr(users.createdAt));

    const usageMap = new Map(usageRows.map((r) => [r.day, r]));
    const userMap = new Map(userRows.map((r) => [r.day, r.n]));
    // 补齐没有数据的日期
    const out: { day: string; calls: number; cost: number; newUsers: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() + 8 * 3600000 - i * 86400000);
      const day = d.toISOString().slice(0, 10);
      out.push({
        day: day.slice(5), // MM-DD 展示
        calls: usageMap.get(day)?.calls ?? 0,
        cost: Number((usageMap.get(day)?.cost ?? 0).toFixed(4)),
        newUsers: userMap.get(day) ?? 0,
      });
    }
    return out;
  }),

  // ---- 分组管理 ----
  listGroups: adminQuery.query(async () => {
    const db = getDb();
    const list = await db.select().from(groups).orderBy(groups.id);
    // 每组的 Key 数量
    const counts = await db
      .select({ groupId: apiKeys.groupId, n: sql<number>`COUNT(*)` })
      .from(apiKeys)
      .groupBy(apiKeys.groupId);
    const map = new Map(counts.map((c) => [c.groupId, c.n]));
    const configuredModels = await db.select({ allowedGroups: models.allowedGroups }).from(models);
    return list.map((g) => ({
      ...g,
      keyCount: map.get(g.id) ?? 0,
      modelCount: configuredModels.filter((model) => splitGroups(model.allowedGroups).includes(g.name)).length,
    }));
  }),

  listGroupsPage: adminQuery.input(paginationInput.extend({
    keyword: z.string().trim().max(64).optional(),
  })).query(({ input }) => getDb().transaction((tx) => {
    const where = input.keyword
      ? sql`lower(${groups.name}) LIKE ${`%${input.keyword.toLowerCase()}%`}`
      : undefined;
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(groups).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const items = tx.select({
      id: groups.id,
      name: groups.name,
      multiplier: groups.multiplier,
      rpmLimit: groups.rpmLimit,
      description: groups.description,
      keyCount: sql<number>`(SELECT COUNT(*) FROM api_keys WHERE api_keys.group_id = ${groups.id})`,
      modelCount: sql<number>`(SELECT COUNT(*) FROM models WHERE instr(',' || replace(models.allowed_groups, ' ', '') || ',', ',' || replace(${groups.name}, ' ', '') || ',') > 0)`,
    }).from(groups).where(where).orderBy(groups.id).limit(pageSize).offset(offset).all();
    return paginatedResult(items, total, page, pageSize);
  })),

  upsertGroup: adminQuery
    .input(
      z.object({
        id: z.number().optional(),
        name: z.string().min(1).max(64),
        multiplier: z.number().min(0),
        rpmLimit: z.number().int().min(0).default(0),
        description: z.string().max(255).default(""),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      if (input.id) {
        const existing = (await db.select().from(groups).where(eq(groups.id, input.id)).limit(1))[0];
        if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "分组不存在" });
        if (existing.name === "default" && input.name !== "default")
          throw new TRPCError({ code: "BAD_REQUEST", message: "默认分组不能改名" });
        await db
          .update(groups)
          .set({ name: input.name, multiplier: input.multiplier, rpmLimit: input.rpmLimit, description: input.description })
          .where(eq(groups.id, input.id));
        // 模型权限仍使用名称存储；分组改名时同步更新，避免权限静默失效。
        if (existing.name !== input.name) {
          const configuredModels = await db.select({ id: models.id, allowedGroups: models.allowedGroups }).from(models);
          for (const model of configuredModels) {
            const names = splitGroups(model.allowedGroups);
            if (!names.includes(existing.name)) continue;
            await db.update(models).set({
              allowedGroups: names.map((name) => name === existing.name ? input.name : name).join(","),
            }).where(eq(models.id, model.id));
          }
        }
        await logAdmin("编辑分组", `${input.name}：倍率 ×${input.multiplier}，RPM ${input.rpmLimit}`);
      } else {
        const dup = (await db.select().from(groups).where(eq(groups.name, input.name)).limit(1))[0];
        if (dup) throw new TRPCError({ code: "BAD_REQUEST", message: "分组名已存在" });
        await db.insert(groups).values({
          name: input.name,
          multiplier: input.multiplier,
          rpmLimit: input.rpmLimit,
          description: input.description,
        });
        await logAdmin("新建分组", `${input.name}：倍率 ×${input.multiplier}，RPM ${input.rpmLimit}`);
      }
      return { ok: true };
    }),

  deleteGroup: adminQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const g = (await db.select().from(groups).where(eq(groups.id, input.id)).limit(1))[0];
    if (!g) throw new TRPCError({ code: "NOT_FOUND", message: "分组不存在" });
    if (g.name === "default") throw new TRPCError({ code: "BAD_REQUEST", message: "默认分组不能删除" });
    const [cnt] = await db.select({ n: sql<number>`COUNT(*)` }).from(apiKeys).where(eq(apiKeys.groupId, input.id));
    if (cnt.n > 0) throw new TRPCError({ code: "BAD_REQUEST", message: `该分组下还有 ${cnt.n} 个 Key，不能删除` });
    const configuredModels = await db.select({ id: models.id, allowedGroups: models.allowedGroups }).from(models);
    const modelCount = configuredModels.filter((model) => splitGroups(model.allowedGroups).includes(g.name)).length;
    if (modelCount > 0)
      throw new TRPCError({ code: "BAD_REQUEST", message: `该分组仍被 ${modelCount} 个模型权限引用，不能删除` });
    await db.delete(groups).where(eq(groups.id, input.id));
    await logAdmin("删除分组", g.name);
    return { ok: true };
  }),

  // ---- 邀请码 / 兑换码 ----
  generateInvites: adminQuery
    .input(
      z.object({
        count: z.number().min(1).max(100),
        type: z.enum(["invite", "redeem"]).default("invite"),
        amount: z.number().min(0.01).max(10_000).optional(),
        mode: z.enum(["single", "reusable"]).default("single"),
        maxUses: z.number().int().min(2).max(1_000_000).nullable().optional(),
        balanceBelow: moneyInput.nullable().optional(),
        creditExpiresAt: z.number().int().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.type === "redeem" && !input.amount)
        throw new TRPCError({ code: "BAD_REQUEST", message: "兑换码必须填写面额" });
      if (input.type === "redeem") {
        try { creditDollarsToUnits(input.amount!); }
        catch (error) { throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "兑换码金额无效" }); }
      }
      if (input.type === "invite" && input.mode !== "single")
        throw new TRPCError({ code: "BAD_REQUEST", message: "邀请码只能使用全局单次模式" });
      if (input.type === "invite" && input.balanceBelow !== null && input.balanceBelow !== undefined)
        throw new TRPCError({ code: "BAD_REQUEST", message: "余额门槛仅适用于兑换码" });
      if (input.type === "invite" && input.creditExpiresAt !== null && input.creditExpiresAt !== undefined)
        throw new TRPCError({ code: "BAD_REQUEST", message: "额度失效时间仅适用于兑换码" });
      const creditExpiresAt = input.type === "redeem" && input.creditExpiresAt ? new Date(input.creditExpiresAt) : null;
      if (creditExpiresAt && (!Number.isFinite(creditExpiresAt.getTime()) || creditExpiresAt.getTime() <= Date.now() + 60_000))
        throw new TRPCError({ code: "BAD_REQUEST", message: "额度失效时间必须至少晚于当前时间 1 分钟" });
      if (creditExpiresAt && creditExpiresAt.getTime() > Date.now() + 10 * 365 * 24 * 3600 * 1000)
        throw new TRPCError({ code: "BAD_REQUEST", message: "额度失效时间不能超过 10 年" });
      const db = getDb();
      const codes: string[] = [];
      for (let i = 0; i < input.count; i++) {
        const code = `LD-${randomToken(4).toUpperCase()}`;
        codes.push(code);
        await db.insert(inviteCodes).values({
          code,
          type: input.type,
          amount: input.type === "invite" ? null : input.amount!,
          mode: input.type === "invite" ? "single" : input.mode,
          maxUses: input.type !== "invite" && input.mode === "reusable" ? (input.maxUses ?? null) : null,
          balanceBelow: input.type === "redeem" ? (input.balanceBelow ?? null) : null,
          creditExpiresAt,
        });
      }
      const modeLabel = input.mode === "reusable"
        ? `多账号重复（${input.maxUses === null || input.maxUses === undefined ? "不限总次数" : `最多 ${input.maxUses} 次`}）`
        : "全局单次";
      const codeLabel = input.type === "redeem"
        ? `充值兑换码 $${input.amount}，${modeLabel}，余额门槛 ${input.balanceBelow === null || input.balanceBelow === undefined ? "无" : `< $${input.balanceBelow.toFixed(2)}`}，额度失效 ${creditExpiresAt ? creditExpiresAt.toISOString() : "永久"}`
        : "邀请码";
      await logAdmin("生成兑换码", `${codeLabel} × ${input.count}`);
      return { codes };
    }),

  listInvites: adminQuery
    .input(z.object({ status: z.enum(["active", "archived", "all"]).default("active") }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      const status = input?.status ?? "active";
      const condition = status === "active"
        ? isNull(inviteCodes.archivedAt)
        : status === "archived"
          ? isNotNull(inviteCodes.archivedAt)
          : undefined;
      const rows = await db.select().from(inviteCodes)
        .where(and(supportedInviteTypes, condition))
        .orderBy(desc(inviteCodes.createdAt)).limit(200);
      const auditCounts = await db.select({
        codeId: codeRedemptions.codeId,
        count: sql<number>`COUNT(*)`,
      }).from(codeRedemptions).groupBy(codeRedemptions.codeId);
      const counts = new Map(auditCounts.map((row) => [row.codeId, Number(row.count)]));
      return rows.map((code) => {
        const auditCount = counts.get(code.id) ?? 0;
        const used = auditCount > 0 || code.redemptionCount > 0 || code.usedBy !== null;
        return {
          ...code,
          auditCount,
          canDelete: code.archivedAt === null,
          deleteAction: code.archivedAt !== null ? null : used ? "archive" as const : "hard_delete" as const,
        };
      });
    }),

  listInvitesPage: adminQuery.input(paginationInput.extend({
    status: z.enum(["active", "archived", "all"]).default("active"),
    type: z.enum(["invite", "redeem"]).optional(),
  })).query(({ input }) => getDb().transaction((tx) => {
    const conditions = [supportedInviteTypes];
    if (input.status === "active") conditions.push(isNull(inviteCodes.archivedAt));
    if (input.status === "archived") conditions.push(isNotNull(inviteCodes.archivedAt));
    if (input.type) conditions.push(eq(inviteCodes.type, input.type));
    const where = conditions.length ? and(...conditions) : undefined;
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(inviteCodes).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const rows = tx.select({
      code: inviteCodes,
      auditCount: sql<number>`(SELECT COUNT(*) FROM code_redemptions WHERE code_redemptions.code_id = ${inviteCodes.id})`,
    }).from(inviteCodes).where(where).orderBy(desc(inviteCodes.createdAt), desc(inviteCodes.id))
      .limit(pageSize).offset(offset).all();
    const items = rows.map(({ code, auditCount: rawAuditCount }) => {
      const auditCount = Number(rawAuditCount);
      const used = auditCount > 0 || code.redemptionCount > 0 || code.usedBy !== null;
      return {
        ...code,
        auditCount,
        canDelete: code.archivedAt === null,
        deleteAction: code.archivedAt !== null ? null : used ? "archive" as const : "hard_delete" as const,
      };
    });
    return paginatedResult(items, total, page, pageSize);
  })),

  updateInviteBalanceThreshold: adminQuery.input(z.object({
    id: z.number().int().positive(),
    balanceBelow: moneyInput.nullable(),
  })).mutation(({ input }) => getDb().transaction((tx) => {
    const code = tx.select().from(inviteCodes).where(and(supportedInviteTypes, eq(inviteCodes.id, input.id))).limit(1).get();
    if (!code || code.archivedAt) throw new TRPCError({ code: "NOT_FOUND", message: "兑换码不存在或已归档" });
    if (code.type !== "redeem") throw new TRPCError({ code: "BAD_REQUEST", message: "余额门槛仅适用于兑换码" });
    tx.update(inviteCodes).set({ balanceBelow: input.balanceBelow }).where(eq(inviteCodes.id, code.id)).run();
    tx.insert(adminLogs).values({
      action: "修改兑换码余额门槛",
      detail: `${code.code}（#${code.id}）：${code.balanceBelow === null ? "无" : `< $${code.balanceBelow.toFixed(2)}`} → ${input.balanceBelow === null ? "无" : `< $${input.balanceBelow.toFixed(2)}`}`,
    }).run();
    return { ok: true, balanceBelow: input.balanceBelow };
  })),

  listCodeRedemptions: adminQuery
    .input(z.object({ codeId: z.number().optional() }).optional())
    .query(async ({ input }) => getDb().select({
      id: codeRedemptions.id,
      codeId: codeRedemptions.codeId,
      code: codeRedemptions.code,
      userId: codeRedemptions.userId,
      groupName: users.groupName,
      username: users.username,
      amount: codeRedemptions.amount,
      codeType: inviteCodes.type,
      balanceBefore: codeRedemptions.balanceBefore,
      balanceBelow: codeRedemptions.balanceBelow,
      creditExpiresAt: codeRedemptions.creditExpiresAt,
      grantOriginalUnits: creditGrants.originalUnits,
      grantConsumedUnits: creditGrants.consumedUnits,
      grantRemainingUnits: creditGrants.remainingUnits,
      grantExpiredUnits: creditGrants.expiredUnits,
      grantStatus: creditGrants.status,
      redeemedAt: codeRedemptions.redeemedAt,
    }).from(codeRedemptions)
      .leftJoin(users, eq(codeRedemptions.userId, users.id))
      .leftJoin(inviteCodes, eq(codeRedemptions.codeId, inviteCodes.id))
      .leftJoin(creditGrants, eq(creditGrants.redemptionId, codeRedemptions.id))
      .where(and(eq(inviteCodes.type, "redeem"), input?.codeId ? eq(codeRedemptions.codeId, input.codeId) : undefined))
      .orderBy(desc(codeRedemptions.redeemedAt))
      .limit(200)),

  listCodeRedemptionsPage: adminQuery.input(paginationInput.extend({
    codeId: z.number().int().positive().optional(),
    userId: z.number().int().positive().optional(),
  })).query(({ input }) => getDb().transaction((tx) => {
    const conditions = [eq(inviteCodes.type, "redeem")];
    if (input.codeId) conditions.push(eq(codeRedemptions.codeId, input.codeId));
    if (input.userId) conditions.push(eq(codeRedemptions.userId, input.userId));
    const where = conditions.length ? and(...conditions) : undefined;
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(codeRedemptions)
      .innerJoin(inviteCodes, eq(codeRedemptions.codeId, inviteCodes.id)).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const items = tx.select({
      id: codeRedemptions.id,
      codeId: codeRedemptions.codeId,
      code: codeRedemptions.code,
      userId: codeRedemptions.userId,
      groupName: users.groupName,
      username: users.username,
      amount: codeRedemptions.amount,
      codeType: inviteCodes.type,
      balanceBefore: codeRedemptions.balanceBefore,
      balanceBelow: codeRedemptions.balanceBelow,
      creditExpiresAt: codeRedemptions.creditExpiresAt,
      grantOriginalUnits: creditGrants.originalUnits,
      grantConsumedUnits: creditGrants.consumedUnits,
      grantRemainingUnits: creditGrants.remainingUnits,
      grantExpiredUnits: creditGrants.expiredUnits,
      grantStatus: creditGrants.status,
      redeemedAt: codeRedemptions.redeemedAt,
    }).from(codeRedemptions).leftJoin(users, eq(codeRedemptions.userId, users.id))
      .leftJoin(inviteCodes, eq(codeRedemptions.codeId, inviteCodes.id))
      .leftJoin(creditGrants, eq(creditGrants.redemptionId, codeRedemptions.id))
      .where(where).orderBy(desc(codeRedemptions.redeemedAt), desc(codeRedemptions.id))
      .limit(pageSize).offset(offset).all();
    return paginatedResult(items, total, page, pageSize);
  })),

  deleteInvite: adminQuery.input(z.object({ id: z.number().int().positive() })).mutation(({ input }) => getDb().transaction((tx) => {
    const code = tx.select().from(inviteCodes).where(and(supportedInviteTypes, eq(inviteCodes.id, input.id))).limit(1).get();
    if (!code) throw new TRPCError({ code: "NOT_FOUND", message: "码不存在或已被物理删除" });
    if (code.archivedAt) throw new TRPCError({ code: "CONFLICT", message: "该码已经归档，不能重复删除" });
    const auditCount = Number(tx.select({ count: sql<number>`COUNT(*)` }).from(codeRedemptions)
      .where(eq(codeRedemptions.codeId, code.id)).get()?.count ?? 0);
    const hasBeenUsed = auditCount > 0 || code.redemptionCount > 0 || code.usedBy !== null;
    if (!hasBeenUsed) {
      const deleted = tx.delete(inviteCodes).where(and(
        eq(inviteCodes.id, code.id),
        eq(inviteCodes.redemptionCount, 0),
        isNull(inviteCodes.usedBy),
        isNull(inviteCodes.archivedAt),
        sql`NOT EXISTS (SELECT 1 FROM code_redemptions WHERE code_id = ${code.id})`,
      )).run();
      if (deleted.changes !== 1) throw new TRPCError({ code: "CONFLICT", message: "码状态已变化，请刷新后重试" });
      tx.insert(adminLogs).values({
        action: "物理删除未使用码",
        detail: `${code.code}（#${code.id}）；无兑换记录`,
      }).run();
      return { ok: true, action: "hard_delete" as const, auditPreserved: false };
    }

    const archivedAt = new Date();
    const archived = tx.update(inviteCodes).set({ archivedAt }).where(and(
      eq(inviteCodes.id, code.id),
      isNull(inviteCodes.archivedAt),
    )).run();
    if (archived.changes !== 1) throw new TRPCError({ code: "CONFLICT", message: "码状态已变化，请刷新后重试" });
    tx.insert(adminLogs).values({
      action: "安全归档已使用码",
      detail: `${code.code}（#${code.id}，${code.mode === "reusable" ? "多账号可重复" : "全局单次"}）；兑换 ${auditCount} 次；立即停止后续兑换，历史审计保留`,
    }).run();
    return { ok: true, action: "archive" as const, archivedAt, auditPreserved: true };
  })),

  previewUsedCodeCleanup: adminQuery.query(async () => {
    const db = getDb();
    const [eligible] = await db.select({ n: sql<number>`COUNT(*)` }).from(inviteCodes).where(and(
      supportedInviteTypes,
      eq(inviteCodes.mode, "single"),
      isNotNull(inviteCodes.usedBy),
      isNull(inviteCodes.archivedAt),
    ));
    const [protectedReusable] = await db.select({ n: sql<number>`COUNT(*)` }).from(inviteCodes).where(and(
      supportedInviteTypes,
      eq(inviteCodes.mode, "reusable"),
      sql`${inviteCodes.redemptionCount} > 0`,
      isNull(inviteCodes.archivedAt),
    ));
    return {
      eligibleCount: eligible.n,
      protectedReusableCount: protectedReusable.n,
      action: "archive" as const,
      description: "仅归档已核销的全局单次码；可重复兑换码和全部兑换审计都会保留。",
    };
  }),

  archiveUsedCodes: adminQuery
    .input(z.object({
      expectedCount: z.number().int().min(0),
      confirmation: z.literal("ARCHIVE_USED_CODES"),
    }))
    .mutation(({ input }) => getDb().transaction((tx) => {
      const condition = and(
        supportedInviteTypes,
        eq(inviteCodes.mode, "single"),
        isNotNull(inviteCodes.usedBy),
        isNull(inviteCodes.archivedAt),
      );
      const current = tx.select({ n: sql<number>`COUNT(*)` }).from(inviteCodes).where(condition).get()?.n ?? 0;
      if (current !== input.expectedCount) {
        throw new TRPCError({ code: "CONFLICT", message: `可归档数量已从 ${input.expectedCount} 变为 ${current}，请重新预览确认` });
      }
      if (current === 0) return { ok: true, archivedCount: 0 };
      const result = tx.update(inviteCodes).set({ archivedAt: new Date() }).where(condition).run();
      tx.insert(adminLogs).values({
        action: "归档已使用单次码",
        detail: `归档 ${result.changes} 个已核销的全局单次码；兑换审计保留`,
      }).run();
      return { ok: true, archivedCount: result.changes };
    })),

  // ---- 抽奖管理 ----
  resetDraws: adminQuery.mutation(() => {
    throw new TRPCError({ code: "BAD_REQUEST", message: "一次性抽奖资格为正式账号全局一次，审计记录不可重置" });
  }),

  listDraws: adminQuery.query(async () => {
    const db = getDb();
    return db
      .select({
        id: draws.id,
        requestId: draws.requestId,
        ip: draws.ip,
        won: draws.won,
        amount: draws.amount,
        configSnapshot: draws.configSnapshot,
        fundBeforeUnits: draws.fundBeforeUnits,
        fundAfterUnits: draws.fundAfterUnits,
        createdAt: draws.createdAt,
        groupName: users.groupName,
      })
      .from(draws)
      .leftJoin(users, eq(draws.userId, users.id))
      .orderBy(desc(draws.createdAt))
      .limit(100);
  }),

  listDrawsPage: adminQuery.input(paginationInput.extend({
    won: z.boolean().optional(),
    userId: z.number().int().positive().optional(),
  })).query(({ input }) => getDb().transaction((tx) => {
    const conditions = [];
    if (input.won !== undefined) conditions.push(eq(draws.won, input.won));
    if (input.userId) conditions.push(eq(draws.userId, input.userId));
    const where = conditions.length ? and(...conditions) : undefined;
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(draws).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const items = tx.select({
      id: draws.id,
      requestId: draws.requestId,
      ip: draws.ip,
      won: draws.won,
      amount: draws.amount,
      configSnapshot: draws.configSnapshot,
      fundBeforeUnits: draws.fundBeforeUnits,
      fundAfterUnits: draws.fundAfterUnits,
      createdAt: draws.createdAt,
      userId: draws.userId,
      groupName: users.groupName,
      username: users.username,
    }).from(draws).leftJoin(users, eq(draws.userId, users.id)).where(where)
      .orderBy(desc(draws.createdAt), desc(draws.id)).limit(pageSize).offset(offset).all();
    return paginatedResult(items, total, page, pageSize);
  })),

  listSlotRounds: adminQuery.query(async () => getDb().select({
    id: checkins.id,
    requestId: checkins.requestId,
    day: checkins.day,
    groupName: users.groupName,
    username: users.username,
    bet: checkins.bet,
    symbols: checkins.symbols,
    payoutMultiplier: checkins.payoutMultiplier,
    grossPayout: checkins.grossPayout,
    netChange: checkins.delta,
    configVersion: checkins.configVersion,
    configId: checkins.configId,
    prizeTier: checkins.prizeTier,
    winRatePpm: checkins.winRatePpm,
    rtpPpm: checkins.rtpPpm,
    fundBeforeUnits: checkins.fundBeforeUnits,
    fundAfterUnits: checkins.fundAfterUnits,
    promotionId: checkins.promotionId,
    promotionBudgetBeforeUnits: checkins.promotionBudgetBeforeUnits,
    promotionBudgetAfterUnits: checkins.promotionBudgetAfterUnits,
    createdAt: checkins.createdAt,
  }).from(checkins)
    .leftJoin(users, eq(checkins.userId, users.id))
    .orderBy(desc(checkins.createdAt))
    .limit(200)),

  listSlotRoundsPage: adminQuery.input(paginationInput.extend({
    day: z.string().max(32).optional(),
    userId: z.number().int().positive().optional(),
    configVersion: z.string().max(64).optional(),
  })).query(({ input }) => getDb().transaction((tx) => {
    const conditions = [];
    if (input.day) conditions.push(eq(checkins.day, input.day));
    if (input.userId) conditions.push(eq(checkins.userId, input.userId));
    if (input.configVersion) conditions.push(eq(checkins.configVersion, input.configVersion));
    const where = conditions.length ? and(...conditions) : undefined;
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(checkins).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const items = tx.select({
      id: checkins.id,
      requestId: checkins.requestId,
      day: checkins.day,
      userId: checkins.userId,
      groupName: users.groupName,
      username: users.username,
      bet: checkins.bet,
      symbols: checkins.symbols,
      payoutMultiplier: checkins.payoutMultiplier,
      grossPayout: checkins.grossPayout,
      netChange: checkins.delta,
      configVersion: checkins.configVersion,
      configId: checkins.configId,
      prizeTier: checkins.prizeTier,
      winRatePpm: checkins.winRatePpm,
      rtpPpm: checkins.rtpPpm,
      fundBeforeUnits: checkins.fundBeforeUnits,
      fundAfterUnits: checkins.fundAfterUnits,
      promotionId: checkins.promotionId,
      promotionBudgetBeforeUnits: checkins.promotionBudgetBeforeUnits,
      promotionBudgetAfterUnits: checkins.promotionBudgetAfterUnits,
      createdAt: checkins.createdAt,
    }).from(checkins).leftJoin(users, eq(checkins.userId, users.id)).where(where)
      .orderBy(desc(checkins.createdAt), desc(checkins.id)).limit(pageSize).offset(offset).all();
    return paginatedResult(items, total, page, pageSize);
  })),

  // ---- 用户管理 ----
  listUsers: adminQuery.query(async () => {
    const db = getDb();
    const list = await db.select().from(users).where(registeredUser).orderBy(desc(users.createdAt)).limit(200);
    // 每用户累计消耗
    const sums = await db
      .select({ userId: usageLogs.userId, total: sql<number>`COALESCE(SUM(${usageLogs.cost}), 0)` })
      .from(usageLogs)
      .groupBy(usageLogs.userId);
    const map = new Map(sums.map((s) => [s.userId, s.total]));
    return list.map((u) => ({ ...u, totalConsumed: Number(map.get(u.id) ?? 0) }));
  }),

  listUsersPage: adminQuery.input(paginationInput.extend({
    keyword: z.string().trim().max(64).optional(),
    banned: z.boolean().optional(),
  })).query(({ input }) => getDb().transaction((tx) => {
    const conditions = [registeredUser!];
    if (input.keyword) {
      const pattern = `%${input.keyword.toLowerCase()}%`;
      conditions.push(or(
        sql`lower(COALESCE(${users.groupName}, '')) LIKE ${pattern}`,
        sql`lower(${users.username}) LIKE ${pattern}`,
      )!);
    }
    if (input.banned !== undefined) conditions.push(eq(users.banned, input.banned));
    const where = and(...conditions);
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(users).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const pageUsers = tx.select({ user: users, totalExp: sql<number>`COALESCE(${levelProfiles.totalExp}, 0)` })
      .from(users).leftJoin(levelProfiles, eq(levelProfiles.userId, users.id)).where(where)
      .orderBy(desc(users.createdAt), desc(users.id)).limit(pageSize).offset(offset).all();
    const pageUserIds = pageUsers.map(({ user }) => user.id);
    const sums = pageUserIds.length === 0 ? [] : tx.select({
      userId: usageLogs.userId,
      total: sql<number>`COALESCE(SUM(${usageLogs.cost}), 0)`,
    }).from(usageLogs).where(inArray(usageLogs.userId, pageUserIds)).groupBy(usageLogs.userId).all();
    const consumedByUser = new Map(sums.map((row) => [row.userId, Number(row.total)]));
    const items = pageUsers.map(({ user, totalExp }) => ({
      ...user, totalConsumed: consumedByUser.get(user.id) ?? 0, totalExp, siteLevel: getLevelProgress(totalExp).level,
    }));
    return paginatedResult(items, total, page, pageSize);
  })),

  setBanned: adminQuery
    .input(z.object({ userId: z.number(), banned: z.boolean() }))
    .mutation(async ({ input }) => {
      await getDb().update(users).set({ banned: input.banned }).where(eq(users.id, input.userId));
      await logAdmin(input.banned ? "封禁用户" : "解封用户", `用户 #${input.userId}`);
      return { ok: true };
    }),

  adjustBalance: adminQuery
    .input(z.object({ userId: z.number(), delta: z.number() }))
    .mutation(({ input }) => getDb().transaction((tx) => {
      expireUserCreditGrants(tx, input.userId);
      const user = tx.select({ balance: users.balance }).from(users).where(eq(users.id, input.userId)).limit(1).get();
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "用户不存在" });
      const balanceBefore = Number(user.balance);
      const balanceAfter = Math.max(0, balanceBefore + input.delta);
      const actualDelta = Math.round((balanceAfter - balanceBefore) * 1_000_000) / 1_000_000;
      if (actualDelta < 0) debitUserBalance(tx, { userId: input.userId, amount: -actualDelta, sourceKind: "adjust", note: "管理员负向调整" });
      else if (actualDelta > 0) tx.update(users).set({ balance: balanceAfter }).where(eq(users.id, input.userId)).run();
      // The zero floor can also forgive old debt. Only the requested credit earns EXP.
      const grantUsd = Math.max(0, Math.min(actualDelta, Math.round(input.delta * 1_000_000) / 1_000_000));
      recordTx(tx, input.userId, "adjust", actualDelta, actualDelta === input.delta
        ? "管理员调整"
        : `管理员调整（请求 ${input.delta}，余额下限 0，实际 ${actualDelta}）`, grantUsd);
      tx.insert(adminLogs).values({
        action: "调整余额",
        detail: `用户 #${input.userId} 请求 ${input.delta >= 0 ? "+" : ""}${input.delta}；实际 ${actualDelta >= 0 ? "+" : ""}${actualDelta}；余额 $${balanceBefore.toFixed(2)} → $${balanceAfter.toFixed(2)}`,
      }).run();
      return { ok: true, balanceBefore, balanceAfter, actualDelta };
    })),

  // ---- 上游渠道管理（New API 风格：地址+密钥一次配好，多模型共用） ----
  listUpstreams: adminQuery.query(async () => {
    const ups = await getDb().select({
      id: upstreams.id,
      name: upstreams.name,
      baseUrl: upstreams.baseUrl,
      enabled: upstreams.enabled,
      timeoutMs: upstreams.timeoutMs,
      lastTestedAt: upstreams.lastTestedAt,
      lastTestOk: upstreams.lastTestOk,
      lastTestLatencyMs: upstreams.lastTestLatencyMs,
      lastTestMessage: upstreams.lastTestMessage,
      createdAt: upstreams.createdAt,
      apiKeyMasked: sql<string>`CASE WHEN length(${upstreams.apiKey}) <= 8 THEN '****' ELSE substr(${upstreams.apiKey}, 1, 4) || '…' || substr(${upstreams.apiKey}, -4) END`,
    }).from(upstreams).orderBy(desc(upstreams.createdAt));
    const counts = await getDb()
      .select({ upstreamId: models.upstreamId, cnt: sql<number>`COUNT(*)` })
      .from(models)
      .groupBy(models.upstreamId);
    const cntMap = new Map(counts.map((c) => [c.upstreamId, c.cnt]));
    return ups.map((u) => ({
      ...u,
      modelCount: cntMap.get(u.id) ?? 0,
    }));
  }),

  listUpstreamsPage: adminQuery.input(paginationInput.extend({
    keyword: z.string().trim().max(64).optional(),
    enabled: z.boolean().optional(),
  })).query(({ input }) => getDb().transaction((tx) => {
    const conditions = [];
    if (input.keyword) conditions.push(sql`lower(${upstreams.name}) LIKE ${`%${input.keyword.toLowerCase()}%`}`);
    if (input.enabled !== undefined) conditions.push(eq(upstreams.enabled, input.enabled));
    const where = conditions.length ? and(...conditions) : undefined;
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(upstreams).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const items = tx.select({
      id: upstreams.id,
      name: upstreams.name,
      baseUrl: upstreams.baseUrl,
      enabled: upstreams.enabled,
      timeoutMs: upstreams.timeoutMs,
      lastTestedAt: upstreams.lastTestedAt,
      lastTestOk: upstreams.lastTestOk,
      lastTestLatencyMs: upstreams.lastTestLatencyMs,
      lastTestMessage: upstreams.lastTestMessage,
      createdAt: upstreams.createdAt,
      apiKeyMasked: sql<string>`CASE WHEN length(${upstreams.apiKey}) <= 8 THEN '****' ELSE substr(${upstreams.apiKey}, 1, 4) || '…' || substr(${upstreams.apiKey}, -4) END`,
      modelCount: sql<number>`(SELECT COUNT(*) FROM models WHERE models.upstream_id = ${upstreams.id})`,
    }).from(upstreams).where(where).orderBy(desc(upstreams.createdAt), desc(upstreams.id))
      .limit(pageSize).offset(offset).all();
    return paginatedResult(items, total, page, pageSize);
  })),

  upsertUpstream: adminQuery
    .input(
      z.object({
        id: z.number().optional(),
        name: z.string().min(1).max(64),
        baseUrl: z.string().url().max(512),
        // 编辑时留空表示保留原密钥，接口不再向浏览器返回明文密钥。
        apiKey: z.string().max(512).default(""),
        enabled: z.boolean(),
        timeoutMs: z.number().int().min(1000).max(300000).default(60000),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const existing = input.id
        ? (await db.select().from(upstreams).where(eq(upstreams.id, input.id)).limit(1))[0]
        : null;
      if (input.id && !existing) throw new TRPCError({ code: "NOT_FOUND", message: "上游不存在" });
      if (!input.id && !input.apiKey.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "新建上游必须填写 API Key" });
      const values = {
        name: input.name,
        baseUrl: input.baseUrl.replace(/\/+$/, ""),
        apiKey: input.apiKey.trim() || existing?.apiKey || "",
        enabled: input.enabled,
        timeoutMs: input.timeoutMs,
      };
      if (input.id) {
        await db.update(upstreams).set(values).where(eq(upstreams.id, input.id));
        await logAdmin("编辑上游", `${input.name}（${values.baseUrl}）${input.enabled ? "" : "，已停用"}`);
      } else {
        await db.insert(upstreams).values(values);
        await logAdmin("新建上游", `${input.name}（${values.baseUrl}）`);
      }
      return { ok: true };
    }),

  deleteUpstream: adminQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const linked = await getDb().select({ id: models.id }).from(models).where(eq(models.upstreamId, input.id)).limit(1);
    if (linked.length) throw new TRPCError({ code: "BAD_REQUEST", message: "该上游下还有模型，请先删除或转移这些模型" });
    const up = (await getDb().select().from(upstreams).where(eq(upstreams.id, input.id)).limit(1))[0];
    await getDb().delete(upstreams).where(eq(upstreams.id, input.id));
    await logAdmin("删除上游", up?.name ?? `#${input.id}`);
    return { ok: true };
  }),

  /** 拉取上游可用模型列表：GET {base}/v1/models */
  fetchUpstreamModels: adminQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const up = (await getDb().select().from(upstreams).where(eq(upstreams.id, input.id)).limit(1))[0];
    if (!up) throw new TRPCError({ code: "NOT_FOUND", message: "上游不存在" });
    const url = modelListUrl(up.baseUrl);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${up.apiKey}`, "x-api-key": up.apiKey },
        signal: AbortSignal.timeout(Math.min(up.timeoutMs, 30000)),
      });
      if (!res.ok) return { ok: false as const, message: `上游返回 HTTP ${res.status}`, models: [] as string[] };
      const data = (await res.json()) as { data?: { id?: unknown }[] };
      const list = Array.isArray(data.data)
        ? data.data.map((m) => String(m?.id ?? "").trim()).filter(Boolean).sort()
        : [];
      if (!list.length) return { ok: false as const, message: "上游未返回任何模型", models: [] as string[] };
      return { ok: true as const, message: "", models: [...new Set(list)] };
    } catch {
      return { ok: false as const, message: `连接失败：网络不通或超时（${Math.min(up.timeoutMs, 30000)}ms）`, models: [] as string[] };
    }
  }),

  /** 测试上游连通性：请求 {base}/v1/models */
  testUpstream: adminQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const up = (await db.select().from(upstreams).where(eq(upstreams.id, input.id)).limit(1))[0];
    if (!up) throw new TRPCError({ code: "NOT_FOUND", message: "上游不存在" });
    const url = modelListUrl(up.baseUrl);
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${up.apiKey}`, "x-api-key": up.apiKey },
        signal: AbortSignal.timeout(Math.min(up.timeoutMs, 30000)),
      });
      const latencyMs = Date.now() - startedAt;
      if (!res.ok) {
        const message = `上游返回 HTTP ${res.status}`;
        await db.update(upstreams).set({ lastTestedAt: new Date(), lastTestOk: false, lastTestLatencyMs: latencyMs, lastTestMessage: message }).where(eq(upstreams.id, up.id));
        return { ok: false, message, latencyMs };
      }
      const data = (await res.json()) as { data?: unknown[] };
      const message = `连接成功，上游共 ${Array.isArray(data.data) ? data.data.length : "?"} 个模型`;
      await db.update(upstreams).set({ lastTestedAt: new Date(), lastTestOk: true, lastTestLatencyMs: latencyMs, lastTestMessage: message }).where(eq(upstreams.id, up.id));
      return { ok: true, message, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = error instanceof Error ? `连接失败：${error.message}` : "连接失败：网络不通或超时";
      await db.update(upstreams).set({ lastTestedAt: new Date(), lastTestOk: false, lastTestLatencyMs: latencyMs, lastTestMessage: message }).where(eq(upstreams.id, up.id));
      return { ok: false, message, latencyMs };
    }
  }),

  // ---- 模型管理 ----
  listModels: adminQuery.query(async () => {
    const rows = await getDb()
      .select({ m: models, upstreamName: upstreams.name })
      .from(models)
      .leftJoin(upstreams, eq(models.upstreamId, upstreams.id))
      .orderBy(desc(models.createdAt));
    return rows.map((r) => ({ ...r.m, upstreamName: r.upstreamName }));
  }),

  listModelsPage: adminQuery.input(paginationInput.extend({
    keyword: z.string().trim().max(64).optional(),
    upstreamId: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
  })).query(({ input }) => getDb().transaction((tx) => {
    const conditions = [];
    if (input.keyword) conditions.push(sql`lower(${models.name}) LIKE ${`%${input.keyword.toLowerCase()}%`}`);
    if (input.upstreamId) conditions.push(eq(models.upstreamId, input.upstreamId));
    if (input.enabled !== undefined) conditions.push(eq(models.enabled, input.enabled));
    const where = conditions.length ? and(...conditions) : undefined;
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(models).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const items = tx.select({ m: models, upstreamName: upstreams.name }).from(models)
      .leftJoin(upstreams, eq(models.upstreamId, upstreams.id)).where(where)
      .orderBy(desc(models.createdAt), desc(models.id)).limit(pageSize).offset(offset).all()
      .map((row) => ({ ...row.m, upstreamName: row.upstreamName }));
    return paginatedResult(items, total, page, pageSize);
  })),

  upsertModel: adminQuery
    .input(
      z.object({
        id: z.number().optional(),
        // 支持逗号/换行分隔批量创建（编辑时只取第一个）
        name: z.string().min(1).max(2048),
        upstreamId: z.number(),
        upstreamModel: z.string().max(128).default(""),
        apiType: z.enum(["chat", "responses", "claude", "gemini"]),
        priceInput: z.number().min(0).nullable(),
        priceOutput: z.number().min(0).nullable(),
        priceCacheWrite: z.number().min(0).nullable(),
        priceCacheRead: z.number().min(0).nullable(),
        allowedGroups: z.string().max(512).default(""),
        enabled: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const up = (await db.select().from(upstreams).where(eq(upstreams.id, input.upstreamId)).limit(1))[0];
      if (!up) throw new TRPCError({ code: "BAD_REQUEST", message: "请先选择上游渠道" });

      const names = [...new Set(input.name.split(/[\n,，]+/).map((s) => s.trim()).filter(Boolean))];
      if (!names.length) throw new TRPCError({ code: "BAD_REQUEST", message: "模型名不能为空" });

      const base = {
        upstreamId: input.upstreamId,
        // 内联字段留空，运行时走上游渠道；保留列仅为兼容旧数据
        upstreamBaseUrl: "",
        upstreamKey: "",
        apiType: input.apiType,
        priceInput: input.priceInput,
        priceOutput: input.priceOutput,
        priceCacheWrite: input.priceCacheWrite,
        priceCacheRead: input.priceCacheRead,
        allowedGroups: input.allowedGroups,
        enabled: input.enabled,
      };

      if (input.id) {
        const name = names[0];
        await db
          .update(models)
          .set({ ...base, name, upstreamModel: input.upstreamModel || name })
          .where(eq(models.id, input.id));
        await logAdmin("编辑模型", `${name}：输入 $${input.priceInput ?? "—"} / 输出 $${input.priceOutput ?? "—"}${input.enabled ? "" : "，已停用"}`);
        return { ok: true, created: 0, skipped: 0 };
      }

      // 批量创建：重名跳过；上游模型名默认同对外名
      const existing = new Set(
        (await db.select({ name: models.name }).from(models)).map((m) => m.name),
      );
      let created = 0;
      let skipped = 0;
      for (const name of names) {
        if (existing.has(name)) {
          skipped++;
          continue;
        }
        await db.insert(models).values({ ...base, name, upstreamModel: input.upstreamModel || name });
        created++;
      }
      await logAdmin("批量添加模型", `上游 #${input.upstreamId}：新建 ${created} 个${skipped ? `，重名跳过 ${skipped} 个` : ""}（${names.slice(0, 5).join("、")}${names.length > 5 ? "…" : ""}）`);
      return { ok: true, created, skipped };
    }),

  deleteModel: adminQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const m = (await getDb().select().from(models).where(eq(models.id, input.id)).limit(1))[0];
    await getDb().delete(models).where(eq(models.id, input.id));
    await logAdmin("删除模型", m?.name ?? `#${input.id}`);
    return { ok: true };
  }),

  // ---- 用量日志（支持按模型 / 用户筛选） ----
  listUsage: adminQuery
    .input(z.object({
      model: z.string().max(128).optional(),
      keyword: z.string().max(64).optional(),
      cacheStatus: z.enum(["hit", "write", "hit_write", "miss", "unknown"]).optional(),
      status: z.enum(["ok", "error"]).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      const conditions = [];
      if (input?.model) conditions.push(eq(usageLogs.model, input.model));
      if (input?.cacheStatus) conditions.push(eq(usageLogs.cacheStatus, input.cacheStatus));
      if (input?.status) conditions.push(eq(usageLogs.status, input.status));
      if (input?.keyword?.trim()) {
        const pattern = `%${input.keyword.trim().toLowerCase()}%`;
        conditions.push(or(
          sql`lower(COALESCE(${users.groupName}, '')) LIKE ${pattern}`,
          sql`lower(COALESCE(${users.username}, '')) LIKE ${pattern}`,
        )!);
      }
      const rows = await db
        .select({
          id: usageLogs.id,
          requestId: usageLogs.requestId,
          model: usageLogs.model,
          protocol: usageLogs.protocol,
          endpoint: usageLogs.endpoint,
          requestBody: usageLogs.requestBody,
          responseBody: usageLogs.responseBody,
          httpStatus: usageLogs.httpStatus,
          upstreamRequestId: usageLogs.upstreamRequestId,
          errorMessage: usageLogs.errorMessage,
          promptTokens: usageLogs.promptTokens,
          completionTokens: usageLogs.completionTokens,
          cacheWriteTokens: usageLogs.cacheWriteTokens,
          cacheReadTokens: usageLogs.cacheReadTokens,
          usageSource: usageLogs.usageSource,
          cacheStatus: usageLogs.cacheStatus,
          inputCost: usageLogs.inputCost,
          outputCost: usageLogs.outputCost,
          cacheWriteCost: usageLogs.cacheWriteCost,
          cacheReadCost: usageLogs.cacheReadCost,
          groupMultiplier: usageLogs.groupMultiplier,
          cost: usageLogs.cost,
          durationMs: usageLogs.durationMs,
          ttftMs: usageLogs.ttftMs,
          stream: usageLogs.stream,
          status: usageLogs.status,
          createdAt: usageLogs.createdAt,
          groupName: users.groupName,
          username: users.username,
          keyName: sql<string>`COALESCE(${apiKeys.name}, ${usageLogs.apiKeyName})`,
          keyPrefix: sql<string>`COALESCE(${apiKeys.prefix}, ${usageLogs.apiKeyPrefix})`,
          upstreamName: upstreams.name,
        })
        .from(usageLogs)
        .leftJoin(users, eq(usageLogs.userId, users.id))
        .leftJoin(apiKeys, eq(usageLogs.apiKeyId, apiKeys.id))
        .leftJoin(upstreams, eq(usageLogs.upstreamId, upstreams.id))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(usageLogs.createdAt))
        .limit(200);
      return rows;
    }),

  listUsagePage: adminQuery.input(paginationInput.extend({
    model: z.string().max(128).optional(),
    keyword: z.string().trim().max(64).optional(),
    cacheStatus: z.enum(["hit", "write", "hit_write", "miss", "unknown"]).optional(),
    status: z.enum(["ok", "error"]).optional(),
    userId: z.number().int().positive().optional(),
    from: z.date().optional(),
    to: z.date().optional(),
  })).query(({ input }) => getDb().transaction((tx) => {
    const conditions = [];
    if (input.model) conditions.push(eq(usageLogs.model, input.model));
    if (input.cacheStatus) conditions.push(eq(usageLogs.cacheStatus, input.cacheStatus));
    if (input.status) conditions.push(eq(usageLogs.status, input.status));
    if (input.userId) conditions.push(eq(usageLogs.userId, input.userId));
    if (input.from) conditions.push(gte(usageLogs.createdAt, input.from));
    if (input.to) conditions.push(lt(usageLogs.createdAt, input.to));
    if (input.keyword) {
      const pattern = `%${input.keyword.toLowerCase()}%`;
      conditions.push(or(
        sql`lower(COALESCE(${users.groupName}, '')) LIKE ${pattern}`,
        sql`lower(COALESCE(${users.username}, '')) LIKE ${pattern}`,
      )!);
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(usageLogs)
      .leftJoin(users, eq(usageLogs.userId, users.id)).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const items = tx.select({
      id: usageLogs.id,
      requestId: usageLogs.requestId,
      model: usageLogs.model,
      protocol: usageLogs.protocol,
      endpoint: usageLogs.endpoint,
      requestBody: usageLogs.requestBody,
      responseBody: usageLogs.responseBody,
      httpStatus: usageLogs.httpStatus,
      upstreamRequestId: usageLogs.upstreamRequestId,
      errorMessage: usageLogs.errorMessage,
      promptTokens: usageLogs.promptTokens,
      completionTokens: usageLogs.completionTokens,
      cacheWriteTokens: usageLogs.cacheWriteTokens,
      cacheReadTokens: usageLogs.cacheReadTokens,
      usageSource: usageLogs.usageSource,
      cacheStatus: usageLogs.cacheStatus,
      inputCost: usageLogs.inputCost,
      outputCost: usageLogs.outputCost,
      cacheWriteCost: usageLogs.cacheWriteCost,
      cacheReadCost: usageLogs.cacheReadCost,
      groupMultiplier: usageLogs.groupMultiplier,
      cost: usageLogs.cost,
      durationMs: usageLogs.durationMs,
      ttftMs: usageLogs.ttftMs,
      stream: usageLogs.stream,
      status: usageLogs.status,
      createdAt: usageLogs.createdAt,
      groupName: users.groupName,
      username: users.username,
      keyName: sql<string>`COALESCE(${apiKeys.name}, ${usageLogs.apiKeyName})`,
      keyPrefix: sql<string>`COALESCE(${apiKeys.prefix}, ${usageLogs.apiKeyPrefix})`,
      upstreamName: upstreams.name,
    }).from(usageLogs)
      .leftJoin(users, eq(usageLogs.userId, users.id))
      .leftJoin(apiKeys, eq(usageLogs.apiKeyId, apiKeys.id))
      .leftJoin(upstreams, eq(usageLogs.upstreamId, upstreams.id))
      .where(where).orderBy(desc(usageLogs.createdAt), desc(usageLogs.id))
      .limit(pageSize).offset(offset).all();
    return paginatedResult(items, total, page, pageSize);
  })),
});
