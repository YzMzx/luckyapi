import { TRPCError } from "@trpc/server";
import { desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { adminLogs, apiKeys, moneyTransfers, peerLoans, sessions, transactions, upstreams, usageLogs, userPolicies, users } from "@db/schema";
import { moneyFromUnits, unitsFromMoney } from "@contracts/finance";
import { adminQuery, hashAdminPassword } from "../auth";
import { createRouter } from "../middleware";
import { getDb } from "../queries/connection";
import { CONTROL_MODULES, readControlState, readFinanceRules, readUserPolicy, upsertSetting } from "../queries/policies";
import { SETTING_KEYS } from "../settings";
import { normalizeConfiguredOrigin } from "../routes/oauth";

const controlSchema = z.object({
  maintenance: z.boolean(),
  modules: z.object(Object.fromEntries(CONTROL_MODULES.map((key) => [key, z.boolean()])) as Record<typeof CONTROL_MODULES[number], z.ZodBoolean>),
  reason: z.string().trim().min(2).max(300),
});
const controlKeys: Record<typeof CONTROL_MODULES[number], string> = {
  login: SETTING_KEYS.loginEnabled, registration: SETTING_KEYS.registrationEnabled, api: SETTING_KEYS.apiEnabled,
  transfer: SETTING_KEYS.transferEnabled, lending: SETTING_KEYS.lendingEnabled,
  draw: SETTING_KEYS.drawModuleEnabled, signin: SETTING_KEYS.signinModuleEnabled, videoReward: SETTING_KEYS.videoRewardModuleEnabled,
  slot: SETTING_KEYS.slotModuleEnabled, duel: SETTING_KEYS.duelModuleEnabled,
};

export const controlAdminRouter = createRouter({
  get: adminQuery.query(() => readControlState(getDb())),
  update: adminQuery.input(controlSchema).mutation(({ input }) => getDb().transaction((tx) => {
    const previous = readControlState(tx);
    upsertSetting(tx, SETTING_KEYS.maintenanceMode, input.maintenance ? "1" : "0");
    for (const module of CONTROL_MODULES) upsertSetting(tx, controlKeys[module], input.modules[module] ? "1" : "0");
    const changes = [previous.maintenance !== input.maintenance ? `维护模式 ${previous.maintenance ? "开" : "关"}→${input.maintenance ? "开" : "关"}` : "",
      ...CONTROL_MODULES.filter((key) => previous.modules[key] !== input.modules[key]).map((key) => `${key} ${previous.modules[key] ? "开" : "关"}→${input.modules[key] ? "开" : "关"}`),
    ].filter(Boolean);
    tx.insert(adminLogs).values({ action: "更新运营控制", detail: `${changes.join("；") || "无状态变化"}；原因：${input.reason}` }).run();
    return readControlState(tx);
  })),
});

function stored(key: string) {
  return getDb().$client.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value?: string } | undefined;
}
const hasSecret = (key: string) => !!stored(key)?.value?.trim();
const authInput = z.object({
  primaryOrigin: z.string().trim().url(), primaryClientId: z.string().trim().min(1).max(500), primaryClientSecret: z.string().max(1000).optional(),
  adminUsername: z.string().trim().min(3).max(100), adminPassword: z.string().min(8).max(500).optional(),
});

export const authSettingsAdminRouter = createRouter({
  get: adminQuery.query(() => {
    const value = (key: string, fallback = "") => stored(key)?.value || fallback || "";
    return {
      primaryOrigin: value(SETTING_KEYS.linuxdoPrimaryOrigin, process.env.LINUXDO_PRIMARY_ORIGIN), primaryClientId: value(SETTING_KEYS.linuxdoClientId, process.env.LINUXDO_CLIENT_ID), primarySecretConfigured: hasSecret(SETTING_KEYS.linuxdoClientSecret) || !!process.env.LINUXDO_CLIENT_SECRET,
      adminUsername: value(SETTING_KEYS.adminUsername, process.env.ADMIN_USERNAME || "admin"), adminPasswordConfigured: hasSecret(SETTING_KEYS.adminPassword) || !!process.env.ADMIN_PASSWORD, callbackPath: "/api/oauth/callback",
    };
  }),
  update: adminQuery.input(authInput).mutation(({ input }) => getDb().transaction((tx) => {
    const primaryOrigin = normalizeConfiguredOrigin(input.primaryOrigin);
    if (!primaryOrigin) throw new TRPCError({ code: "BAD_REQUEST", message: "OAuth 域名必须是有效的 http/https Origin" });
    const submitted = new URL(input.primaryOrigin);
    if (submitted.username || submitted.password || submitted.pathname !== "/" || submitted.search || submitted.hash) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "OAuth 域名只能填写协议和域名，例如 https://example.com" });
    }
    const values: Array<[string, string]> = [[SETTING_KEYS.linuxdoPrimaryOrigin, primaryOrigin], [SETTING_KEYS.linuxdoClientId, input.primaryClientId], [SETTING_KEYS.adminUsername, input.adminUsername]];
    for (const [key, value] of values) upsertSetting(tx, key, value);
    if (input.primaryClientSecret?.trim()) upsertSetting(tx, SETTING_KEYS.linuxdoClientSecret, input.primaryClientSecret.trim());
    if (input.adminPassword?.trim()) upsertSetting(tx, SETTING_KEYS.adminPassword, hashAdminPassword(input.adminPassword.trim()));
    tx.insert(adminLogs).values({ action: "更新 OAuth 与管理员安全", detail: `唯一入口 ${primaryOrigin}；敏感密钥仅覆盖更新` }).run();
    return { ok: true };
  })),
});

const financeInput = z.object({
  transferFeePercent: z.number().min(0).max(100), transferMin: z.number().positive(), transferMax: z.number().positive(), transferDailyLimit: z.number().positive(),
  loanMinPrincipal: z.number().positive(), loanMaxPrincipal: z.number().positive(), loanMinRatePercent: z.number().min(0).max(100), loanMaxRatePercent: z.number().min(0).max(100),
  loanMinDurationDays: z.number().int().min(1).max(3660), loanMaxDurationDays: z.number().int().min(1).max(3660), loanOfferExpiryMinutes: z.number().int().min(1).max(1440),
  loanInterestTaxPercent: z.number().min(0).max(100), lendingDailyLimit: z.number().positive(), outstandingBorrowLimit: z.number().positive(),
});
function publicFinanceRules() {
  const r = readFinanceRules(getDb());
  return { transferFeePercent: r.transferFeeBasisPoints / 100, transferMin: moneyFromUnits(r.transferMinUnits), transferMax: moneyFromUnits(r.transferMaxUnits), transferDailyLimit: moneyFromUnits(r.transferDailyLimitUnits), loanMinPrincipal: moneyFromUnits(r.loanMinPrincipalUnits), loanMaxPrincipal: moneyFromUnits(r.loanMaxPrincipalUnits), loanMinRatePercent: r.loanMinRateBasisPoints / 100, loanMaxRatePercent: r.loanMaxRateBasisPoints / 100, loanMinDurationDays: r.loanMinDurationDays, loanMaxDurationDays: r.loanMaxDurationDays, loanOfferExpiryMinutes: r.loanOfferExpiryMinutes, loanInterestTaxPercent: r.loanInterestTaxBasisPoints / 100, lendingDailyLimit: moneyFromUnits(r.lendingDailyLimitUnits), outstandingBorrowLimit: moneyFromUnits(r.outstandingBorrowLimitUnits) };
}
export const financeSettingsAdminRouter = createRouter({
  get: adminQuery.query(publicFinanceRules),
  update: adminQuery.input(financeInput).mutation(({ input }) => getDb().transaction((tx) => {
    if (input.transferMin > input.transferMax || input.loanMinPrincipal > input.loanMaxPrincipal || input.loanMinRatePercent > input.loanMaxRatePercent || input.loanMinDurationDays > input.loanMaxDurationDays) throw new TRPCError({ code: "BAD_REQUEST", message: "所有最小值都必须小于或等于对应最大值" });
    const values: Array<[string, number]> = [[SETTING_KEYS.transferFeeBasisPoints, Math.round(input.transferFeePercent * 100)], [SETTING_KEYS.transferMinUnits, unitsFromMoney(input.transferMin)], [SETTING_KEYS.transferMaxUnits, unitsFromMoney(input.transferMax)], [SETTING_KEYS.transferDailyLimitUnits, unitsFromMoney(input.transferDailyLimit)], [SETTING_KEYS.loanMinPrincipalUnits, unitsFromMoney(input.loanMinPrincipal)], [SETTING_KEYS.loanMaxPrincipalUnits, unitsFromMoney(input.loanMaxPrincipal)], [SETTING_KEYS.loanMinRateBasisPoints, Math.round(input.loanMinRatePercent * 100)], [SETTING_KEYS.loanMaxRateBasisPoints, Math.round(input.loanMaxRatePercent * 100)], [SETTING_KEYS.loanMinDurationDays, input.loanMinDurationDays], [SETTING_KEYS.loanMaxDurationDays, input.loanMaxDurationDays], [SETTING_KEYS.loanOfferExpiryMinutes, input.loanOfferExpiryMinutes], [SETTING_KEYS.loanInterestTaxBasisPoints, Math.round(input.loanInterestTaxPercent * 100)], [SETTING_KEYS.lendingDailyLimitUnits, unitsFromMoney(input.lendingDailyLimit)], [SETTING_KEYS.outstandingBorrowLimitUnits, unitsFromMoney(input.outstandingBorrowLimit)]];
    for (const [key, value] of values) upsertSetting(tx, key, String(value));
    tx.insert(adminLogs).values({ action: "更新金融规则", detail: `转账费 ${input.transferFeePercent}%；新合同保存规则快照，旧合同保持不变` }).run();
    return { ok: true };
  })),
});

const windowSchema = z.enum(["1h", "24h", "7d", "30d"]);
const windowMs = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 } as const;
function percentile(values: number[], p: number) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]; }
export const monitoringAdminRouter = createRouter({
  summary: adminQuery.input(z.object({ window: windowSchema.default("24h") })).query(({ input }) => {
    const db = getDb(); const since = new Date(Date.now() - windowMs[input.window]);
    const rows = db.select({ status: usageLogs.status, cost: usageLogs.cost, prompt: usageLogs.promptTokens, completion: usageLogs.completionTokens, cacheRead: usageLogs.cacheReadTokens, cacheWrite: usageLogs.cacheWriteTokens, duration: usageLogs.durationMs, ttft: usageLogs.ttftMs, userId: usageLogs.userId }).from(usageLogs).where(gte(usageLogs.createdAt, since)).all();
    const ok = rows.filter((r) => r.status === "ok"); const durations = ok.map((r) => r.duration); const ttfts = ok.filter((r) => r.ttft > 0).map((r) => r.ttft);
    const upstream = db.select().from(upstreams).orderBy(desc(upstreams.id)).limit(1).get();
    return { window: input.window, calls: rows.length, success: ok.length, errors: rows.length - ok.length, successRate: rows.length ? ok.length / rows.length : 0, customerCharges: ok.reduce((s, r) => s + Number(r.cost), 0), tokens: ok.reduce((s, r) => s + r.prompt + r.completion + r.cacheRead + r.cacheWrite, 0), activeUsers: new Set(rows.map((r) => r.userId)).size, latency: { mean: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0, p50: percentile(durations, .5), p95: percentile(durations, .95) }, ttft: { mean: ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : 0, p50: percentile(ttfts, .5), p95: percentile(ttfts, .95) }, upstream: upstream ? { name: upstream.name, enabled: upstream.enabled, testedAt: upstream.lastTestedAt, ok: upstream.lastTestOk, latencyMs: upstream.lastTestLatencyMs, message: upstream.lastTestMessage } : null };
  }),
  breakdown: adminQuery.input(z.object({ window: windowSchema.default("24h"), dimension: z.enum(["model", "protocol", "status", "httpStatus", "error"]) })).query(({ input }) => {
    const column = { model: "model", protocol: "protocol", status: "status", httpStatus: "CAST(http_status AS TEXT)", error: "CASE WHEN error_message = '' THEN 'none' ELSE substr(error_message, 1, 120) END" }[input.dimension];
    return getDb().$client.prepare(`SELECT ${column} label, COUNT(*) calls, SUM(CASE WHEN status = 'ok' THEN cost ELSE 0 END) charges FROM usage_logs WHERE created_at >= ? GROUP BY ${column} ORDER BY calls DESC LIMIT 30`).all(Date.now() - windowMs[input.window]);
  }),
});

export const userDetailProcedure = adminQuery.input(z.object({ userId: z.number().int().positive() })).query(({ input }) => getDb().transaction((tx) => {
  const user = tx.select().from(users).where(eq(users.id, input.userId)).get(); if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "用户不存在" });
  const keys = tx.select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, active: apiKeys.active, quota: apiKeys.quota, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt }).from(apiKeys).where(eq(apiKeys.userId, input.userId)).orderBy(desc(apiKeys.id)).limit(100).all();
  const usage = tx.select({ calls: sql<number>`COUNT(*)`, cost: sql<number>`COALESCE(SUM(${usageLogs.cost}),0)`, tokens: sql<number>`COALESCE(SUM(${usageLogs.promptTokens}+${usageLogs.completionTokens}+${usageLogs.cacheReadTokens}+${usageLogs.cacheWriteTokens}),0)` }).from(usageLogs).where(eq(usageLogs.userId, input.userId)).get();
  const ledger = tx.select().from(transactions).where(eq(transactions.userId, input.userId)).orderBy(desc(transactions.id)).limit(100).all();
  const transfers = tx.select().from(moneyTransfers).where(sql`${moneyTransfers.senderId} = ${input.userId} OR ${moneyTransfers.recipientId} = ${input.userId}`).orderBy(desc(moneyTransfers.id)).limit(100).all();
  const loans = tx.select().from(peerLoans).where(sql`${peerLoans.lenderId} = ${input.userId} OR ${peerLoans.borrowerId} = ${input.userId}`).orderBy(desc(peerLoans.id)).limit(100).all();
  return { user, policy: readUserPolicy(tx, input.userId), keys, usage: usage ?? { calls: 0, cost: 0, tokens: 0 }, ledger, transfers, loans };
}));
const optionalMoney = z.number().positive().nullable();
export const updateUserPolicyProcedure = adminQuery.input(z.object({ userId: z.number().int().positive(), frozenApiGroupIds: z.array(z.number().int().positive()).max(200).default([]), allFrozen: z.boolean().optional().default(false), apiFrozen: z.boolean(), financeFrozen: z.boolean(), entertainmentFrozen: z.boolean(), apiDailySpendLimit: optionalMoney, apiKeyLimit: z.number().int().min(1).max(100).nullable(), apiConcurrencyLimit: z.number().int().min(1).max(1000).nullable(), transferDailyLimit: optionalMoney, lendingDailyLimit: optionalMoney, outstandingBorrowLimit: optionalMoney })).mutation(({ input }) => getDb().transaction((tx) => {
  const values = { userId: input.userId, frozenApiGroupIds: JSON.stringify(input.frozenApiGroupIds), allFrozen: input.allFrozen, apiFrozen: input.apiFrozen, financeFrozen: input.financeFrozen, entertainmentFrozen: input.entertainmentFrozen, apiDailySpendLimitUnits: input.apiDailySpendLimit === null ? null : unitsFromMoney(input.apiDailySpendLimit), apiKeyLimit: input.apiKeyLimit, apiConcurrencyLimit: input.apiConcurrencyLimit, transferDailyLimitUnits: input.transferDailyLimit === null ? null : unitsFromMoney(input.transferDailyLimit), lendingDailyLimitUnits: input.lendingDailyLimit === null ? null : unitsFromMoney(input.lendingDailyLimit), outstandingBorrowLimitUnits: input.outstandingBorrowLimit === null ? null : unitsFromMoney(input.outstandingBorrowLimit), updatedAt: new Date() };
  tx.insert(userPolicies).values(values).onConflictDoUpdate({ target: userPolicies.userId, set: values }).run();
  tx.insert(adminLogs).values({ action: "更新用户策略", detail: `用户 #${input.userId}；全部权限 ${input.allFrozen ? "冻结" : "正常"}；API ${input.apiFrozen ? "冻结" : "正常"}；金融 ${input.financeFrozen ? "冻结" : "正常"}；娱乐 ${input.entertainmentFrozen ? "冻结" : "正常"}` }).run(); return { ok: true };
}));
export const revokeUserSessionsProcedure = adminQuery.input(z.object({ userId: z.number().int().positive() })).mutation(({ input }) => getDb().transaction((tx) => { const result = tx.delete(sessions).where(eq(sessions.userId, input.userId)).run(); tx.insert(adminLogs).values({ action: "强制用户退出", detail: `用户 #${input.userId}；清除 ${result.changes} 个会话` }).run(); return { ok: true, count: result.changes }; }));
export const disableUserApiKeysProcedure = adminQuery.input(z.object({ userId: z.number().int().positive() })).mutation(({ input }) => getDb().transaction((tx) => { const result = tx.update(apiKeys).set({ active: false }).where(eq(apiKeys.userId, input.userId)).run(); tx.insert(adminLogs).values({ action: "停用用户全部 API Key", detail: `用户 #${input.userId}；停用 ${result.changes} 个 Key` }).run(); return { ok: true, count: result.changes }; }));
