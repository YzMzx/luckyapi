import { z } from "zod";
import { randomInt as secureRandomInt } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { eq, and, or, asc, desc, gt, lt, sql, gte, isNull, isNotNull, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { getDb } from "../queries/connection";
import { recordTx } from "../queries/ledger";
import { CREDIT_GRANT_SCALE, createTimedCreditGrant, creditDollarsToUnits, debitPermanentBalance, debitUserBalance } from "../queries/credit-grants";
import {
  apiKeys, usageLogs, users, reports, models, groups, upstreams, inviteCodes,
  codeRedemptions, checkins, transactions, slotFund, slotFundLedger, slotPromotions, creditGrants,
  reportCardBalances, reportCardLedger,
} from "../../db/schema";
import { createRouter } from "../middleware";
import { assertModuleAvailable, readControlState, readUserPolicy } from "../queries/policies";
import { memberQuery, randomToken, sha256 } from "../auth";
import { getSetting, SETTING_KEYS } from "../settings";
import { groupNameSchema } from "@contracts/group-name";
import {
  SLOT_MAX_BET,
  SLOT_MIN_BET,
  dollarsToMoneyUnits,
  moneyUnitsToDollars,
  serializeSlotRules,
  spinSlot,
  SLOT_SYMBOL_DEFINITIONS,
  type SlotSymbols,
} from "@contracts/slot-machine";
import { publicSlotState, resolveSlotState } from "../queries/slot-control";
import { currentBusinessDay, readDailyLimits, readReportRules } from "../queries/entertainment-control";
import {
  calculateReportGross,
  calculateReportSettlement,
  DEFAULT_REPORT_TAX_BASIS_POINTS,
  formatReportTaxPercent,
  MAX_REPORT_TAX_BASIS_POINTS,
} from "@contracts/report-tax";
import { paginatedResult, paginationInput, paginationParams, resolvePagination } from "../pagination";

function unsettledGrantUnitsSql() {
  return sql<number>`COALESCE((SELECT SUM(${creditGrants.remainingUnits}) FROM ${creditGrants} WHERE ${creditGrants.userId} = ${users.id} AND ${creditGrants.remainingUnits} > 0), 0)`;
}

function permanentAvailableSql() {
  return sql<number>`${users.balance} - (${unsettledGrantUnitsSql()} * 1.0 / ${CREDIT_GRANT_SCALE})`;
}

type MemberQueryDb = Pick<ReturnType<typeof getDb>, "select">;

function readPermanentAvailable(tx: MemberQueryDb, userId: number, balance: number) {
  const row = tx.select({ units: sql<number>`COALESCE(SUM(${creditGrants.remainingUnits}), 0)` })
    .from(creditGrants)
    .where(and(
      eq(creditGrants.userId, userId),
      gt(creditGrants.remainingUnits, 0),
    ))
    .get();
  return balance - Number(row?.units ?? 0) / CREDIT_GRANT_SCALE;
}

function slotRecord(row: typeof checkins.$inferSelect) {
  const parsed = row.symbols ? row.symbols.split(",") : [];
  const valid = parsed.length === 3 && parsed.every((id) => SLOT_SYMBOL_DEFINITIONS.some((symbol) => symbol.id === id));
  return {
    requestId: row.requestId,
    symbols: valid ? parsed as SlotSymbols : null,
    bet: row.bet,
    payoutMultiplier: row.payoutMultiplier,
    grossPayout: row.grossPayout,
    netChange: row.delta,
    win: row.payoutMultiplier > 0,
    configVersion: row.configVersion,
    configId: row.configId,
    prizeTier: row.prizeTier,
    winRatePpm: row.winRatePpm,
    rtpPpm: row.rtpPpm,
    promotionId: row.promotionId,
    createdAt: row.createdAt,
  };
}

export const memberRouter = createRouter({
  // ---- 公开身份（榜单 / 举报记录使用） ----
  updateGroupName: memberQuery
    .input(z.object({ groupName: groupNameSchema }))
    .mutation(({ ctx, input }) => {
      const db = getDb();
      return db.transaction((tx) => {
        const duplicate = tx.select({ id: users.id }).from(users)
          .where(and(
            sql`lower(${users.groupName}) = lower(${input.groupName})`,
            ne(users.id, ctx.user.id),
          ))
          .limit(1)
          .get();
        if (duplicate) throw new TRPCError({ code: "BAD_REQUEST", message: "该群内名称已被占用，换一个吧" });
        tx.update(users).set({ groupName: input.groupName }).where(eq(users.id, ctx.user.id)).run();
        return { ok: true, groupName: input.groupName };
      });
    }),

  // ---- 分组（创建 Key 时可选） ----
  listGroups: memberQuery.query(async () => {
    return getDb()
      .select({ id: groups.id, name: groups.name, multiplier: groups.multiplier, rpmLimit: groups.rpmLimit, description: groups.description })
      .from(groups)
      .orderBy(groups.id);
  }),

  // ---- API Key 管理 ----
  listKeys: memberQuery.query(async ({ ctx }) => {
    const db = getDb();
    const list = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        active: apiKeys.active,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
        groupId: apiKeys.groupId,
        groupName: groups.name,
        groupMultiplier: groups.multiplier,
        quota: apiKeys.quota,
        expiresAt: apiKeys.expiresAt,
        lastUsedIp: apiKeys.lastUsedIp,
      })
      .from(apiKeys)
      .leftJoin(groups, eq(apiKeys.groupId, groups.id))
      .where(eq(apiKeys.userId, ctx.user.id))
      .orderBy(desc(apiKeys.createdAt));
    const totals = await db
      .select({
        apiKeyId: usageLogs.apiKeyId,
        calls: sql<number>`COUNT(*)`,
        cost: sql<number>`COALESCE(SUM(${usageLogs.cost}), 0)`,
      })
      .from(usageLogs)
      .where(eq(usageLogs.userId, ctx.user.id))
      .groupBy(usageLogs.apiKeyId);
    const totalMap = new Map(totals.map((row) => [row.apiKeyId, row]));
    return list.map((key) => ({
      ...key,
      usageCalls: totalMap.get(key.id)?.calls ?? 0,
      usageCost: totalMap.get(key.id)?.cost ?? 0,
    }));
  }),

  listKeysPage: memberQuery.input(paginationInput.extend({
    active: z.boolean().optional(),
  })).query(({ ctx, input }) => getDb().transaction((tx) => {
    const where = input.active === undefined
      ? eq(apiKeys.userId, ctx.user.id)
      : and(eq(apiKeys.userId, ctx.user.id), eq(apiKeys.active, input.active));
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(apiKeys).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const items = tx.select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      active: apiKeys.active,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
      groupId: apiKeys.groupId,
      groupName: groups.name,
      groupMultiplier: groups.multiplier,
      quota: apiKeys.quota,
      expiresAt: apiKeys.expiresAt,
      lastUsedIp: apiKeys.lastUsedIp,
      usageCalls: sql<number>`(SELECT COUNT(*) FROM usage_logs WHERE usage_logs.api_key_id = ${apiKeys.id} AND usage_logs.user_id = ${ctx.user.id})`,
      usageCost: sql<number>`COALESCE((SELECT SUM(usage_logs.cost) FROM usage_logs WHERE usage_logs.api_key_id = ${apiKeys.id} AND usage_logs.user_id = ${ctx.user.id}), 0)`,
    }).from(apiKeys).leftJoin(groups, eq(apiKeys.groupId, groups.id)).where(where)
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id)).limit(pageSize).offset(offset).all();
    return paginatedResult(items, total, page, pageSize);
  })),

  createKey: memberQuery
    .input(z.object({
      name: z.string().min(1).max(64).default("默认 Key"),
      groupId: z.number().nullable(),
      // 密钥独立额度（美元），null = 不限
      quota: z.number().min(0).nullable().default(null),
      expiresAt: z.date().nullable().default(null),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      assertModuleAvailable(db, "api", ctx.user.id);
      const policy = readUserPolicy(db, ctx.user.id);
      const [{ count }] = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(apiKeys)
        .where(eq(apiKeys.userId, ctx.user.id));
      const keyLimit = policy.apiKeyLimit ?? 20;
      if (count >= keyLimit) throw new TRPCError({ code: "BAD_REQUEST", message: `每个账号最多创建 ${keyLimit} 个 API Key` });
      if (input.expiresAt && input.expiresAt.getTime() <= Date.now())
        throw new TRPCError({ code: "BAD_REQUEST", message: "过期时间必须晚于当前时间" });
      if (input.groupId !== null) {
        const g = (await db.select().from(groups).where(eq(groups.id, input.groupId)).limit(1))[0];
        if (!g) throw new TRPCError({ code: "BAD_REQUEST", message: "分组不存在" });
      }
      const plain = `sk-ld-${randomToken(24)}`;
      await db.insert(apiKeys).values({
        userId: ctx.user.id,
        name: input.name,
        prefix: plain.slice(0, 16),
        keyHash: sha256(plain),
        groupId: input.groupId,
        quota: input.quota,
        expiresAt: input.expiresAt,
      });
      // 明文只返回这一次
      return { key: plain };
    }),

  updateKey: memberQuery
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).max(64),
      groupId: z.number().nullable(),
      quota: z.number().min(0).nullable(),
      expiresAt: z.date().nullable(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const key = (await db.select().from(apiKeys)
        .where(and(eq(apiKeys.id, input.id), eq(apiKeys.userId, ctx.user.id))).limit(1))[0];
      if (!key) throw new TRPCError({ code: "NOT_FOUND", message: "Key 不存在" });
      if (input.groupId !== null) {
        const group = (await db.select({ id: groups.id }).from(groups).where(eq(groups.id, input.groupId)).limit(1))[0];
        if (!group) throw new TRPCError({ code: "BAD_REQUEST", message: "分组不存在" });
      }
      if (input.expiresAt && input.expiresAt.getTime() <= Date.now())
        throw new TRPCError({ code: "BAD_REQUEST", message: "过期时间必须晚于当前时间" });
      await db.update(apiKeys).set({
        name: input.name.trim(), groupId: input.groupId, quota: input.quota, expiresAt: input.expiresAt,
      }).where(eq(apiKeys.id, key.id));
      return { ok: true };
    }),

  deleteKey: memberQuery.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = getDb();
    const key = (await db.select({ id: apiKeys.id }).from(apiKeys)
      .where(and(eq(apiKeys.id, input.id), eq(apiKeys.userId, ctx.user.id))).limit(1))[0];
    if (!key) throw new TRPCError({ code: "NOT_FOUND", message: "Key 不存在" });
    // 用量日志保留审计记录，仅断开 Key 外键引用。
    await db.update(usageLogs).set({ apiKeyId: null }).where(eq(usageLogs.apiKeyId, key.id));
    await db.delete(apiKeys).where(eq(apiKeys.id, key.id));
    return { ok: true };
  }),

  /** 设置密钥独立额度（null = 不限） */
  setKeyQuota: memberQuery
    .input(z.object({ id: z.number(), quota: z.number().min(0).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const key = (
        await db.select().from(apiKeys).where(and(eq(apiKeys.id, input.id), eq(apiKeys.userId, ctx.user.id))).limit(1)
      )[0];
      if (!key) throw new TRPCError({ code: "NOT_FOUND", message: "Key 不存在" });
      await db.update(apiKeys).set({ quota: input.quota }).where(eq(apiKeys.id, key.id));
      return { ok: true };
    }),

  revokeKey: memberQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const key = (
        await db
          .select()
          .from(apiKeys)
          .where(and(eq(apiKeys.id, input.id), eq(apiKeys.userId, ctx.user.id)))
          .limit(1)
      )[0];
      if (!key) throw new TRPCError({ code: "NOT_FOUND", message: "Key 不存在" });
      await db.update(apiKeys).set({ active: !key.active }).where(eq(apiKeys.id, key.id));
      return { ok: true, active: !key.active };
    }),

  // ---- 用量 ----
  myUsage: memberQuery.input(paginationInput.optional()).query(async ({ ctx, input }) => {
    const db = getDb();
    const total = Number((await db.select({ n: sql<number>`COUNT(*)` }).from(usageLogs)
      .where(eq(usageLogs.userId, ctx.user.id)))[0]?.n ?? 0);
    const request = paginationParams(input, 20);
    const pageData = resolvePagination(total, request.requestedPage, request.pageSize);
    const logs = await db
      .select({
        id: usageLogs.id,
        model: usageLogs.model,
        requestId: usageLogs.requestId,
        protocol: usageLogs.protocol,
        upstreamId: usageLogs.upstreamId,
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
        keyName: sql<string>`COALESCE(${apiKeys.name}, ${usageLogs.apiKeyName})`,
        keyPrefix: sql<string>`COALESCE(${apiKeys.prefix}, ${usageLogs.apiKeyPrefix})`,
      })
      .from(usageLogs)
      .leftJoin(apiKeys, eq(usageLogs.apiKeyId, apiKeys.id))
      .where(eq(usageLogs.userId, ctx.user.id))
      .orderBy(desc(usageLogs.createdAt), desc(usageLogs.id))
      .limit(pageData.pageSize)
      .offset(pageData.offset);
    const sum = (
      await db
        .select({
          totalCost: sql<string>`COALESCE(SUM(cost), 0)`,
          totalPrompt: sql<number>`COALESCE(SUM(prompt_tokens), 0)`,
          totalCompletion: sql<number>`COALESCE(SUM(completion_tokens), 0)`,
          totalCacheRead: sql<number>`COALESCE(SUM(cache_read_tokens), 0)`,
          totalCacheWrite: sql<number>`COALESCE(SUM(cache_write_tokens), 0)`,
          cacheHitCalls: sql<number>`COALESCE(SUM(CASE WHEN cache_status IN ('hit','hit_write') THEN 1 ELSE 0 END), 0)`,
          cacheKnownCalls: sql<number>`COALESCE(SUM(CASE WHEN cache_status != 'unknown' THEN 1 ELSE 0 END), 0)`,
          averageDurationMs: sql<number>`COALESCE(AVG(duration_ms), 0)`,
          totalCalls: sql<number>`COUNT(*)`,
        })
        .from(usageLogs)
        .where(eq(usageLogs.userId, ctx.user.id))
    )[0];
    // 今日 / 本月（UTC+8 自然日）
    const period = (
      await db
        .select({
          todayCalls: sql<number>`COALESCE(SUM(CASE WHEN strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', '+8 hours') = strftime('%Y-%m-%d', 'now', '+8 hours') THEN 1 ELSE 0 END), 0)`,
          todayCost: sql<number>`COALESCE(SUM(CASE WHEN strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', '+8 hours') = strftime('%Y-%m-%d', 'now', '+8 hours') THEN cost ELSE 0 END), 0)`,
          monthCalls: sql<number>`COALESCE(SUM(CASE WHEN strftime('%Y-%m', created_at / 1000, 'unixepoch', '+8 hours') = strftime('%Y-%m', 'now', '+8 hours') THEN 1 ELSE 0 END), 0)`,
          monthCost: sql<number>`COALESCE(SUM(CASE WHEN strftime('%Y-%m', created_at / 1000, 'unixepoch', '+8 hours') = strftime('%Y-%m', 'now', '+8 hours') THEN cost ELSE 0 END), 0)`,
        })
        .from(usageLogs)
        .where(eq(usageLogs.userId, ctx.user.id))
    )[0];
    return {
      logs,
      summary: { ...sum, ...period },
      page: pageData.page,
      pageSize: pageData.pageSize,
      total: pageData.total,
      totalPages: pageData.totalPages,
    };
  }),

  // ---- 可用模型 ----
  listModels: memberQuery.query(async () => {
    const list = await getDb()
      .select({
        id: models.id,
        name: models.name,
        apiType: models.apiType,
        priceInput: models.priceInput,
        priceOutput: models.priceOutput,
        priceCacheWrite: models.priceCacheWrite,
        priceCacheRead: models.priceCacheRead,
        allowedGroups: models.allowedGroups,
        upstreamName: upstreams.name,
      })
      .from(models)
      .leftJoin(upstreams, eq(models.upstreamId, upstreams.id))
      .where(and(eq(models.enabled, true), or(isNull(upstreams.id), eq(upstreams.enabled, true))));
    return list;
  }),

  // ---- 当前可用额度榜 ----
  leaderboard: memberQuery
    .input(paginationInput.optional())
    .query(async ({ ctx, input }) => {
      const request = paginationParams(input, 20);
      const db = getDb();
      const permanentAvailable = permanentAvailableSql();
      // 正式且未封禁用户全部进入榜单；榜值扣除仍有效的临时额度，允许为零或负数。
      const eligible = and(eq(users.banned, false), isNotNull(users.groupName));
      const total = (await db.select({ n: sql<number>`COUNT(*)` }).from(users).where(eligible))[0].n;
      const { page, pageSize, totalPages, offset } = resolvePagination(total, request.requestedPage, request.pageSize);
      const rows = await db
        .select({
          id: users.id,
          groupName: users.groupName,
          avatarUrl: users.avatarUrl,
          balance: permanentAvailable,
          createdAt: users.createdAt,
          reportCount: sql<number>`(SELECT COUNT(*) FROM reports WHERE reports.reporter_id = ${users.id})`,
          reportWins: sql<number>`COALESCE((SELECT SUM(success) FROM reports WHERE reports.reporter_id = ${users.id}), 0)`,
        })
        .from(users)
        .where(eligible)
        // 同额时按账号加入顺序（id）稳定排序，保证翻页与“我的排名”一致。
        .orderBy(desc(permanentAvailable), asc(users.id))
        .limit(pageSize)
        .offset(offset);
      const rankedRows = rows.map((u, index) => ({
        ...u,
        rank: (page - 1) * pageSize + index + 1,
      }));

      const mineBalance = readPermanentAvailable(db, ctx.user.id, Number(ctx.user.balance));
      const mineRank = (await db
        .select({ n: sql<number>`COUNT(*)` })
        .from(users)
        .where(and(
          eligible,
          or(
            gt(permanentAvailable, mineBalance),
            and(eq(permanentAvailable, mineBalance), lt(users.id, ctx.user.id)),
          ),
        )))[0].n + 1;
      return {
        rows: rankedRows,
        mine: {
          id: ctx.user.id,
          groupName: ctx.user.groupName,
          avatarUrl: ctx.user.avatarUrl,
          balance: mineBalance,
          rank: mineRank,
          isRanked: true,
          isOnPage: rankedRows.some((row) => row.id === ctx.user.id),
          unrankedReason: null,
        },
        ranking: {
          metric: "permanent_available_balance" as const,
          label: "永久可用额度",
          description: "按账户永久可用额度从高到低排名；未结清且未到期的临时额度不计入，同额按加入顺序排列。", 
        },
        total,
        page,
        pageSize,
        totalPages,
      };
    }),

  // ---- 兑换码充值 ----
  redeemCode: memberQuery
    .input(z.object({ code: z.string().min(4).max(32) }))
    .mutation(({ ctx, input }) => {
      const db = getDb();
      const normalizedCode = input.code.trim();
      return db.transaction((tx) => {
        const code = tx.select().from(inviteCodes).where(and(
          eq(inviteCodes.code, normalizedCode),
          or(eq(inviteCodes.type, "redeem"), eq(inviteCodes.type, "report")),
          isNull(inviteCodes.archivedAt),
        )).limit(1).get();
        const amount = Number(code?.amount ?? 0);
        if (!code || !Number.isFinite(amount) || amount <= 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "兑换码无效" });
        }
        const isReportCard = code.type === "report";
        if (isReportCard && (!Number.isSafeInteger(amount) || amount < 1 || amount > 10_000))
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "举报卡次数配置无效，请联系管理员" });
        const creditExpiresAt = isReportCard ? null : code.creditExpiresAt;
        if (creditExpiresAt && creditExpiresAt.getTime() <= Date.now())
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该兑换码的额度失效时间已到，不能再兑换" });
        const me = tx.select({ balance: users.balance }).from(users).where(eq(users.id, ctx.user.id)).limit(1).get();
        if (!me) throw new TRPCError({ code: "NOT_FOUND", message: "用户不存在" });
        const balanceBefore = Number(me.balance);
        const balanceBelow = code.balanceBelow === null ? null : Number(code.balanceBelow);
        if (balanceBelow !== null && (!Number.isFinite(balanceBelow) || balanceBelow < 0))
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "兑换码余额门槛配置无效，请联系管理员" });
        if (!isReportCard && balanceBelow !== null && balanceBefore >= balanceBelow) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `当前余额 $${balanceBefore.toFixed(2)}；此码仅限余额严格低于 $${balanceBelow.toFixed(2)} 时兑换`,
          });
        }

        // 先原子占用总次数，再写 user_id + code_id 唯一审计；任一步失败整个事务都会回滚。
        const claimed = code.mode === "reusable"
          ? tx.update(inviteCodes).set({
            redemptionCount: sql`${inviteCodes.redemptionCount} + 1`,
            usedAt: new Date(),
          }).where(and(
            eq(inviteCodes.id, code.id),
            eq(inviteCodes.mode, "reusable"),
            isNull(inviteCodes.archivedAt),
            code.maxUses === null
              ? sql`1 = 1`
              : lt(inviteCodes.redemptionCount, code.maxUses),
          )).run()
          : tx.update(inviteCodes).set({
            redemptionCount: 1,
            usedBy: ctx.user.id,
            usedAt: new Date(),
          }).where(and(
            eq(inviteCodes.id, code.id),
            eq(inviteCodes.mode, "single"),
            eq(inviteCodes.redemptionCount, 0),
            isNull(inviteCodes.usedBy),
            isNull(inviteCodes.archivedAt),
          )).run();
        if (claimed.changes === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "兑换码已用完" });
        }

        let redemption: typeof codeRedemptions.$inferSelect;
        try {
          redemption = tx.insert(codeRedemptions).values({
            codeId: code.id,
            code: code.code,
            userId: ctx.user.id,
            amount,
            balanceBefore,
            balanceBelow,
            creditExpiresAt,
          }).returning().get();
        } catch {
          throw new TRPCError({ code: "BAD_REQUEST", message: "你已经兑换过这个兑换码" });
        }
        if (isReportCard) {
          tx.insert(reportCardBalances).values({
            userId: ctx.user.id,
            grantedCount: amount,
            remainingCount: amount,
            updatedAt: new Date(),
          }).onConflictDoUpdate({
            target: reportCardBalances.userId,
            set: {
              grantedCount: sql`${reportCardBalances.grantedCount} + ${amount}`,
              remainingCount: sql`${reportCardBalances.remainingCount} + ${amount}`,
              updatedAt: new Date(),
            },
          }).run();
          const balance = tx.select().from(reportCardBalances).where(eq(reportCardBalances.userId, ctx.user.id)).get()!;
          tx.insert(reportCardLedger).values({
            userId: ctx.user.id,
            type: "redeem",
            amount,
            remainingAfter: balance.remainingCount,
            redemptionId: redemption.id,
            note: `兑换举报卡 ${normalizedCode}，永久增加 ${amount} 次`,
          }).run();
        } else if (creditExpiresAt) createTimedCreditGrant(tx, {
          redemptionId: redemption.id,
          codeId: code.id,
          code: code.code,
          userId: ctx.user.id,
          amountUnits: creditDollarsToUnits(amount),
          expiresAt: creditExpiresAt,
        });
        if (!isReportCard) {
          tx.update(users).set({ balance: sql`balance + ${amount}` }).where(eq(users.id, ctx.user.id)).run();
          recordTx(tx, ctx.user.id, "redeem", amount, `兑换码 ${normalizedCode}${creditExpiresAt ? `（额度失效：${creditExpiresAt.toISOString()}）` : "（永久额度）"}`);
        }
        const usedCount = code.redemptionCount + 1;
        const remainingUses = code.mode === "reusable" && code.maxUses !== null
          ? Math.max(0, code.maxUses - usedCount)
          : null;
        return {
          amount,
          mode: code.mode,
          remainingUses,
          balanceBefore,
          balanceBelow,
          creditExpiresAt,
          rewardType: isReportCard ? "report_card" as const : "credit" as const,
          message: isReportCard
            ? `兑换成功，永久举报次数 +${amount}`
            : creditExpiresAt
            ? `兑换成功，$${amount.toFixed(2)} 已到账；剩余额度将于 ${creditExpiresAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（北京时间）失效`
            : `兑换成功，$${amount.toFixed(2)} 永久额度已到账`,
        };
      });
    }),

  // ---- 老虎机：服务端安全随机、固定赔率表、后台配置每日次数限制 ----
  checkinStatus: memberQuery.query(async ({ ctx }) => {
    const featureEnabled = (await getSetting(SETTING_KEYS.checkinEnabled, "1")) !== "0";
    return getDb().transaction((tx) => {
      const state = resolveSlotState(tx);
      const day = currentBusinessDay(tx);
      const dailyLimit = readDailyLimits(tx).slot;
      const rows = tx
        .select()
        .from(checkins)
        .where(and(
          eq(checkins.userId, ctx.user.id),
          gte(checkins.createdAt, day.startsAt),
          lt(checkins.createdAt, day.endsAt),
        ))
        .orderBy(desc(checkins.id))
        .all();
      const used = rows.length;
      return {
        enabled: featureEnabled && dailyLimit > 0,
        done: dailyLimit === 0 || used >= dailyLimit,
        used,
        dailyLimit,
        remaining: Math.max(0, dailyLimit - used),
        businessDay: day,
        result: rows[0] ? slotRecord(rows[0]) : null,
        rules: publicSlotState(state),
      };
    });
  }),

  checkin: memberQuery
    .input(z.object({
      requestId: z.string().uuid(),
      expectedConfigVersion: z.string().min(1).max(96),
      bet: z.number().min(SLOT_MIN_BET).max(SLOT_MAX_BET)
        .refine((value) => Math.round(value * 100) === value * 100, "下注金额最多保留两位小数"),
    }))
    .mutation(async ({ ctx, input }) => {
    assertModuleAvailable(getDb(), "slot", ctx.user.id);
    const enabled = (await getSetting(SETTING_KEYS.checkinEnabled, "1")) !== "0";
    if (!enabled) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "老虎机暂未开启" });
    const db = getDb();
    return db.transaction((tx) => {
      const existingRequest = tx.select().from(checkins).where(eq(checkins.requestId, input.requestId)).limit(1).get();
      const state = resolveSlotState(tx);
      const publicRules = publicSlotState(state);
      if (existingRequest) {
        if (existingRequest.userId !== ctx.user.id)
          throw new TRPCError({ code: "CONFLICT", message: "请求编号已被占用" });
        return { ...slotRecord(existingRequest), idempotent: true, rules: publicRules };
      }
      const day = currentBusinessDay(tx);
      const dailyLimit = readDailyLimits(tx).slot;
      if (dailyLimit === 0)
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "老虎机已关闭（每日次数限制为 0）" });
      const used = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(checkins).where(and(
        eq(checkins.userId, ctx.user.id),
        gte(checkins.createdAt, day.startsAt),
        lt(checkins.createdAt, day.endsAt),
      )).get()?.n ?? 0);
      if (used >= dailyLimit) throw new TRPCError({ code: "BAD_REQUEST", message: "今天已经玩过了，老虎机次数已经用完，明天再来" });
      if (input.expectedConfigVersion !== state.config.version)
        throw new TRPCError({ code: "CONFLICT", message: "老虎机规则刚刚更新，请刷新后重新确认下注" });
      if (state.pausedReason || state.allowedMaxBetUnits < state.rules.minBetUnits)
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: state.pausedReason ?? "当前暂不可下注" });
      let betUnits: number;
      try {
        betUnits = dollarsToMoneyUnits(input.bet);
      } catch (error) {
        throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "下注金额无效" });
      }
      if (betUnits < state.rules.minBetUnits || betUnits > state.allowedMaxBetUnits)
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `当前允许下注 $${moneyUnitsToDollars(state.rules.minBetUnits).toFixed(2)}–$${moneyUnitsToDollars(state.allowedMaxBetUnits).toFixed(2)}`,
        });
      const me = tx.select({ balance: users.balance }).from(users).where(eq(users.id, ctx.user.id)).limit(1).get();
      if (!me || Number(me.balance) < input.bet)
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `余额不足，至少需要 $${input.bet.toFixed(2)}` });

      // 所有最坏赔付校验均已在开奖前完成；之后只开奖一次，绝不因结果重抽。
      const outcome = spinSlot(secureRandomInt, state.rules, betUnits);
      const fundBeforeUnits = state.fund.balanceUnits;
      const fundAfterBetUnits = fundBeforeUnits + betUnits;
      const fundAfterUnits = fundAfterBetUnits - outcome.grossPayoutUnits;
      const dayNetAfterUnits = state.fund.dayNetUnits + betUnits - outcome.grossPayoutUnits;
      if (fundAfterUnits < state.fund.reserveUnits || dayNetAfterUnits < -state.fund.dailyLossLimitUnits)
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "风险额度发生变化，请刷新后重试" });
      const promotionBudgetBeforeUnits = state.promotionRemainingUnits;
      const promotionSpendUnits = state.promotion ? Math.max(0, outcome.grossPayoutUnits - betUnits) : 0;
      const promotionBudgetAfterUnits = promotionBudgetBeforeUnits === null ? null : promotionBudgetBeforeUnits - promotionSpendUnits;
      if (promotionBudgetAfterUnits !== null && promotionBudgetAfterUnits < 0)
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "活动预算刚刚用完，已切回日常规则，请刷新后重试" });

      let created: typeof checkins.$inferSelect;
      try {
        created = tx.insert(checkins).values({
          requestId: input.requestId,
          userId: ctx.user.id,
          day: day.key,
          delta: outcome.netChange,
          bet: input.bet,
          symbols: outcome.symbols.join(","),
          payoutMultiplier: outcome.payoutMultiplier,
          grossPayout: outcome.grossPayout,
          configVersion: state.config.version,
          configId: state.config.id,
          prizeTier: outcome.prizeTierId,
          rulesSnapshot: serializeSlotRules(state.rules),
          winRatePpm: state.metrics.winRatePpm,
          rtpPpm: state.metrics.rtpPpm,
          fundBeforeUnits,
          fundAfterUnits,
          promotionId: state.promotion?.id ?? null,
          promotionBudgetBeforeUnits,
          promotionBudgetAfterUnits,
        }).returning().get();
      } catch {
        const raced = tx.select().from(checkins).where(eq(checkins.requestId, input.requestId)).limit(1).get();
        if (raced?.userId === ctx.user.id)
          return { ...slotRecord(raced), idempotent: true, rules: publicRules };
        throw new TRPCError({ code: "BAD_REQUEST", message: "今天已经玩过了，明天再来" });
      }
      try {
        debitUserBalance(tx, { userId: ctx.user.id, amount: input.bet, sourceKind: "slot", requestId: input.requestId, note: `老虎机下注 ${state.config.version}` });
      } catch {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "余额不足，请刷新后重试" });
      }
      if (outcome.grossPayout > 0) tx.update(users).set({ balance: sql`${users.balance} + ${outcome.grossPayout}` }).where(eq(users.id, ctx.user.id)).run();
      tx.update(slotFund).set({
        balanceUnits: fundAfterUnits,
        dayNetUnits: dayNetAfterUnits,
        updatedAt: new Date(),
      }).where(eq(slotFund.id, 1)).run();
      if (state.promotion) {
        tx.update(slotPromotions).set({
          spentUnits: state.promotion.spentUnits + promotionSpendUnits,
          status: promotionBudgetAfterUnits === 0 ? "exhausted" : "active",
          stoppedAt: promotionBudgetAfterUnits === 0 ? new Date() : null,
        }).where(eq(slotPromotions.id, state.promotion.id)).run();
      }
      tx.insert(slotFundLedger).values([
        {
          requestId: input.requestId,
          roundId: created.id,
          type: "bet",
          amountUnits: betUnits,
          balanceAfterUnits: fundAfterBetUnits,
          note: `用户下注，配置 ${state.config.version}`,
        },
        {
          requestId: input.requestId,
          roundId: created.id,
          type: "payout",
          amountUnits: -outcome.grossPayoutUnits,
          balanceAfterUnits: fundAfterUnits,
          note: `${outcome.prizeTierName}，返还 $${outcome.grossPayout.toFixed(2)}`,
        },
      ]).run();
      recordTx(
        tx,
        ctx.user.id,
        "checkin",
        outcome.netChange,
        `老虎机：下注 $${input.bet.toFixed(2)}，${outcome.symbols.join("/")}，返还 $${outcome.grossPayout.toFixed(2)}（受每日次数限制）`,
      );
      return { ...slotRecord(created), idempotent: false, rules: publicRules };
    });
  }),

  // ---- 举报：指定/随机独立每日次数，免费次数耗尽后消耗永久举报卡 ----
  report: memberQuery
    .input(z.object({ requestId: z.string().uuid(), targetUserId: z.number().optional() }))
    .mutation(async ({ ctx, input }) => {
      assertModuleAvailable(getDb(), "reporting", ctx.user.id);
      const kind = input.targetUserId ? ("targeted" as const) : ("random" as const);
      if (input.targetUserId === ctx.user.id)
        throw new TRPCError({ code: "BAD_REQUEST", message: "不能举报自己" });
      const db = getDb();
      const configuredTax = Number(await getSetting(
        SETTING_KEYS.reportTaxBasisPoints,
        String(DEFAULT_REPORT_TAX_BASIS_POINTS),
      ));
      const taxBasisPoints = Number.isInteger(configuredTax) && configuredTax >= 0 && configuredTax <= MAX_REPORT_TAX_BASIS_POINTS
        ? configuredTax
        : DEFAULT_REPORT_TAX_BASIS_POINTS;
      const taxPercent = formatReportTaxPercent(taxBasisPoints);

      // 事务内完成配额检查 + 结算（better-sqlite3 同步事务）
      return db.transaction((tx) => {
        const existing = tx.select().from(reports).where(eq(reports.requestId, input.requestId)).limit(1).get();
        if (existing) {
          if (existing.reporterId !== ctx.user.id)
            throw new TRPCError({ code: "CONFLICT", message: "请求编号已被占用" });
          const existingTarget = tx.select().from(users).where(eq(users.id, existing.targetId)).limit(1).get();
          return {
            success: existing.success,
            amount: existing.creditedAmount,
            reporterBalanceBefore: existing.reporterBalanceBefore,
            targetBalanceBefore: existing.targetBalanceBefore,
            lowerBalance: existing.lowerBalance,
            grossAmount: existing.grossAmount,
            tax: existing.tax,
            taxBasisPoints: existing.taxBasisPoints,
            taxRatePercent: formatReportTaxPercent(existing.taxBasisPoints),
            creditedAmount: existing.creditedAmount,
            deductedAmount: existing.deductedAmount,
            quotaSource: existing.quotaSource,
            targetName: existingTarget?.groupName ?? existingTarget?.username ?? "未知",
            idempotent: true,
            title: existing.success ? "举报成功" : "非必要不举报",
            message: existing.success
              ? `税前 $${existing.grossAmount.toFixed(2)}，扣 ${formatReportTaxPercent(existing.taxBasisPoints)}% 税后到账 $${existing.creditedAmount.toFixed(2)}`
              : `本次举报未成立，你被扣除 $${existing.deductedAmount.toFixed(2)}，对方税后到账 $${existing.creditedAmount.toFixed(2)}`,
          };
        }
        const day = currentBusinessDay(tx);
        const rules = readReportRules(tx);
        const quotaStartsAt = rules.quotaResetAt > day.startsAt && rules.quotaResetAt < day.endsAt
          ? rules.quotaResetAt
          : day.startsAt;
        const limit = kind === "targeted" ? rules.targetedDailyLimit : rules.randomDailyLimit;
        const used = tx
          .select({ n: sql<number>`COUNT(*)` })
          .from(reports)
          .where(and(
            eq(reports.reporterId, ctx.user.id),
            eq(reports.kind, kind),
            gte(reports.createdAt, quotaStartsAt),
            lt(reports.createdAt, day.endsAt),
            eq(reports.quotaSource, "daily"),
          ))
          .all()[0].n;
        const card = tx.select().from(reportCardBalances).where(eq(reportCardBalances.userId, ctx.user.id)).get();
        const useCard = used >= limit;
        if (useCard && Number(card?.remainingCount ?? 0) <= 0)
          throw new TRPCError({ code: "BAD_REQUEST", message: `今天的${kind === "targeted" ? "指定" : "随机"}举报次数已经用完，且没有可用举报卡次数` });

        const reporter = tx.select().from(users).where(eq(users.id, ctx.user.id)).limit(1).all()[0];
        const settlementNow = new Date();
        const reporterPermanent = readPermanentAvailable(tx, reporter.id, Number(reporter.balance));
        if (reporterPermanent <= 0)
          throw new TRPCError({ code: "BAD_REQUEST", message: "你的永久可用额度必须大于 0 才能举报" });

        let target: typeof users.$inferSelect | undefined;
        if (kind === "targeted") {
          target = tx.select().from(users).where(eq(users.id, input.targetUserId!)).limit(1).all()[0];
          if (!target || !target.groupName) throw new TRPCError({ code: "NOT_FOUND", message: "对方不存在" });
        } else {
          // 随机候选只允许永久可用额度为正；临时额度不能使用户成为举报目标。
          const candidatePermanent = permanentAvailableSql();
          const candidates = tx
            .select()
            .from(users)
            .where(and(gt(candidatePermanent, 0), ne(users.id, ctx.user.id), eq(users.banned, false), isNotNull(users.groupName)))
            .all();
          if (!candidates.length) throw new TRPCError({ code: "BAD_REQUEST", message: "目前没有可举报的对象" });
          target = candidates[secureRandomInt(candidates.length)];
        }
        const targetPermanent = readPermanentAvailable(tx, target.id, Number(target.balance));
        if (target.banned || !target.groupName || targetPermanent <= 0)
          throw new TRPCError({ code: "BAD_REQUEST", message: "只能举报永久可用额度大于 0 的正式用户" });

        // 结算基数只看永久可用额度；临时额度不能参与风险计算或被洗成永久额度。
        const risk = calculateReportGross(reporterPermanent, targetPermanent);
        const gross = risk.grossAmount;
        if (gross <= 0)
          throw new TRPCError({ code: "BAD_REQUEST", message: "双方较低余额不足，没有可结算的举报额度" });

        const quotaSource = useCard ? "card" as const : "daily" as const;
        if (useCard) {
          const consumed = tx.update(reportCardBalances).set({
            consumedCount: sql`${reportCardBalances.consumedCount} + 1`,
            remainingCount: sql`${reportCardBalances.remainingCount} - 1`,
            updatedAt: new Date(),
          }).where(and(eq(reportCardBalances.userId, ctx.user.id), gt(reportCardBalances.remainingCount, 0))).run();
          if (consumed.changes !== 1) throw new TRPCError({ code: "CONFLICT", message: "举报卡次数已被其他请求使用，请重试" });
          const after = tx.select().from(reportCardBalances).where(eq(reportCardBalances.userId, ctx.user.id)).get()!;
          tx.insert(reportCardLedger).values({
            userId: ctx.user.id,
            type: "consume",
            amount: -1,
            remainingAfter: after.remainingCount,
            reportRequestId: input.requestId,
            note: `${kind === "targeted" ? "指定" : "随机"}举报消耗 1 次举报卡`,
          }).run();
        }
        const success = secureRandomInt(10_000) < rules.successBasisPoints;
        if (success) {
          const settlement = calculateReportSettlement(gross, taxBasisPoints);
          debitPermanentBalance(tx, { userId: target.id, amount: gross, note: `被「${reporter.groupName ?? reporter.username}」举报成功`, kind: "report", now: settlementNow });
          tx.update(users).set({ balance: sql`balance + ${settlement.creditedAmount}` }).where(eq(users.id, reporter.id)).run();
          recordTx(tx, reporter.id, "report", settlement.creditedAmount, `举报「${target.groupName ?? target.username}」成功（税前 $${gross.toFixed(2)}，税率 ${taxPercent}%）`);
          tx.insert(reports).values({
            requestId: input.requestId,
            reporterId: reporter.id,
            targetId: target.id,
            kind,
            success: true,
            amount: settlement.creditedAmount,
            reporterBalanceBefore: risk.reporterBalanceBefore,
            targetBalanceBefore: risk.targetBalanceBefore,
            lowerBalance: risk.lowerBalance,
            grossAmount: settlement.grossAmount,
            taxBasisPoints,
            tax: settlement.taxAmount,
            creditedAmount: settlement.creditedAmount,
            deductedAmount: settlement.deductedAmount,
            quotaSource,
            successBasisPoints: rules.successBasisPoints,
          }).run();
          return {
            success: true,
            amount: settlement.creditedAmount,
            ...risk,
            ...settlement,
            tax: settlement.taxAmount,
            taxRatePercent: taxPercent,
            targetName: target.groupName ?? target.username,
            idempotent: false,
            quotaSource,
            title: "举报成功",
            message: `税前 $${gross.toFixed(2)}，扣 ${taxPercent}% 税后 +$${settlement.creditedAmount.toFixed(2)}`,
          };
        }
        const settlement = calculateReportSettlement(gross, taxBasisPoints);
        debitPermanentBalance(tx, { userId: reporter.id, amount: gross, note: `举报「${target.groupName ?? target.username}」失败`, kind: "report", now: settlementNow });
        tx.update(users).set({ balance: sql`balance + ${settlement.creditedAmount}` }).where(eq(users.id, target.id)).run();
        recordTx(tx, target.id, "report", settlement.creditedAmount, `「${reporter.groupName ?? reporter.username}」举报你失败，补偿入账（税前 $${gross.toFixed(2)}，税率 ${taxPercent}%）`);
        tx.insert(reports).values({
          requestId: input.requestId,
          reporterId: reporter.id,
          targetId: target.id,
          kind,
          success: false,
          amount: settlement.creditedAmount,
          reporterBalanceBefore: risk.reporterBalanceBefore,
          targetBalanceBefore: risk.targetBalanceBefore,
          lowerBalance: risk.lowerBalance,
          grossAmount: settlement.grossAmount,
          taxBasisPoints,
          tax: settlement.taxAmount,
          creditedAmount: settlement.creditedAmount,
          deductedAmount: settlement.deductedAmount,
          quotaSource,
          successBasisPoints: rules.successBasisPoints,
        }).run();
        return {
          success: false,
          amount: settlement.creditedAmount,
          ...risk,
          ...settlement,
          tax: settlement.taxAmount,
          taxRatePercent: taxPercent,
          targetName: target.groupName ?? target.username,
          idempotent: false,
          quotaSource,
          title: "非必要不举报",
          message: `本次举报未成立，你被扣除 $${gross.toFixed(2)}，对方扣 ${taxPercent}% 税后得 $${settlement.creditedAmount.toFixed(2)}`,
        };
      });
    }),

  reportQuota: memberQuery.query(async ({ ctx }) => {
    const quota = getDb().transaction((tx) => {
      const controls = readControlState(tx);
      const policy = readUserPolicy(tx, ctx.user.id);
      const day = currentBusinessDay(tx);
      const rules = readReportRules(tx);
      const quotaStartsAt = rules.quotaResetAt > day.startsAt && rules.quotaResetAt < day.endsAt ? rules.quotaResetAt : day.startsAt;
      const rows = tx.select({ kind: reports.kind, n: sql<number>`COUNT(*)` })
        .from(reports)
        .where(and(
          eq(reports.reporterId, ctx.user.id),
          gte(reports.createdAt, quotaStartsAt),
          lt(reports.createdAt, day.endsAt),
          eq(reports.quotaSource, "daily"),
        ))
        .groupBy(reports.kind).all();
      const byKind = Object.fromEntries(rows.map((row) => [row.kind, Number(row.n)]));
      const used = (byKind.targeted ?? 0) + (byKind.random ?? 0);
      const current = tx.select({ balance: users.balance }).from(users).where(eq(users.id, ctx.user.id)).get();
      const permanentAvailable = readPermanentAvailable(tx, ctx.user.id, Number(current?.balance ?? 0));
      const cardRemaining = Number(tx.select({ n: reportCardBalances.remainingCount }).from(reportCardBalances).where(eq(reportCardBalances.userId, ctx.user.id)).get()?.n ?? 0);
      return { controls, policy, day, rules, byKind, used, permanentAvailable, cardRemaining };
    });
    const rawTax = Number(await getSetting(SETTING_KEYS.reportTaxBasisPoints, String(DEFAULT_REPORT_TAX_BASIS_POINTS)));
    const taxBasisPoints = Number.isInteger(rawTax) && rawTax >= 0 && rawTax <= MAX_REPORT_TAX_BASIS_POINTS
      ? rawTax
      : DEFAULT_REPORT_TAX_BASIS_POINTS;
    const example = calculateReportSettlement(10, taxBasisPoints);
    const targetedRemaining = Math.max(0, quota.rules.targetedDailyLimit - (quota.byKind.targeted ?? 0));
    const randomRemaining = Math.max(0, quota.rules.randomDailyLimit - (quota.byKind.random ?? 0));
    const remaining = targetedRemaining + randomRemaining;
    const unavailableReason = quota.controls.maintenance ? "系统正在维护，暂时无法发起举报"
      : !quota.controls.modules.reporting ? "举报功能当前已由管理员关闭"
      : (quota.policy.allFrozen || quota.policy.entertainmentFrozen) ? "你的娱乐权限已被冻结"
      : quota.rules.targetedDailyLimit + quota.rules.randomDailyLimit <= 0 && quota.cardRemaining <= 0 ? "举报功能暂未开放"
      : remaining <= 0 && quota.cardRemaining <= 0 ? "今天的举报次数已经用完，且没有可用举报卡次数"
      : quota.permanentAvailable <= 0 ? "永久可用额度必须大于 0 才能举报"
      : null;
    return {
      enabled: quota.controls.modules.reporting && (quota.rules.targetedDailyLimit + quota.rules.randomDailyLimit > 0 || quota.cardRemaining > 0),
      canReport: unavailableReason === null,
      unavailableReason,
      permanentAvailable: quota.permanentAvailable,
      dailyLimit: quota.rules.targetedDailyLimit + quota.rules.randomDailyLimit,
      used: quota.used,
      remaining,
      businessDay: quota.day,
      cardRemaining: quota.cardRemaining,
      targeted: { dailyLimit: quota.rules.targetedDailyLimit, used: quota.byKind.targeted ?? 0, remaining: targetedRemaining, canReport: targetedRemaining > 0 || quota.cardRemaining > 0 },
      random: { dailyLimit: quota.rules.randomDailyLimit, used: quota.byKind.random ?? 0, remaining: randomRemaining, canReport: randomRemaining > 0 || quota.cardRemaining > 0 },
      tax: {
        basisPoints: taxBasisPoints,
        percent: formatReportTaxPercent(taxBasisPoints),
        exampleGross: example.grossAmount,
        exampleTax: example.taxAmount,
        exampleCredited: example.creditedAmount,
      },
    };
  }),

  // ---- 举报记录（我举报的 + 举报我的） ----
  myReports: memberQuery.query(async ({ ctx }) => {
    const reporter = alias(users, "reporter");
    const target = alias(users, "target");
    const rows = await getDb()
      .select({
        id: reports.id,
        kind: reports.kind,
        success: reports.success,
        amount: reports.amount,
        reporterBalanceBefore: reports.reporterBalanceBefore,
        targetBalanceBefore: reports.targetBalanceBefore,
        lowerBalance: reports.lowerBalance,
        grossAmount: reports.grossAmount,
        taxBasisPoints: reports.taxBasisPoints,
        tax: reports.tax,
        creditedAmount: reports.creditedAmount,
        deductedAmount: reports.deductedAmount,
        createdAt: reports.createdAt,
        reporterId: reports.reporterId,
        targetId: reports.targetId,
        reporterName: reporter.groupName,
        reporterUsername: reporter.username,
        targetName: target.groupName,
        targetUsername: target.username,
      })
      .from(reports)
      .leftJoin(reporter, eq(reports.reporterId, reporter.id))
      .leftJoin(target, eq(reports.targetId, target.id))
      .where(or(eq(reports.reporterId, ctx.user.id), eq(reports.targetId, ctx.user.id)))
      .orderBy(desc(reports.createdAt))
      .limit(100);
    return rows.map((r) => ({
      ...r,
      direction: r.reporterId === ctx.user.id ? ("out" as const) : ("in" as const),
      reporterDisplay: r.reporterName ?? r.reporterUsername ?? "未知",
      targetDisplay: r.targetName ?? r.targetUsername ?? "未知",
    }));
  }),

  myReportsPage: memberQuery.input(paginationInput.extend({
    direction: z.enum(["all", "out", "in"]).default("all"),
    success: z.boolean().optional(),
  })).query(({ ctx, input }) => getDb().transaction((tx) => {
    const reporter = alias(users, "reporter_page_member");
    const target = alias(users, "target_page_member");
    const visibility = input.direction === "out"
      ? eq(reports.reporterId, ctx.user.id)
      : input.direction === "in"
        ? eq(reports.targetId, ctx.user.id)
        : or(eq(reports.reporterId, ctx.user.id), eq(reports.targetId, ctx.user.id))!;
    const where = input.success === undefined ? visibility : and(visibility, eq(reports.success, input.success));
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(reports).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const rows = tx.select({
      id: reports.id,
      kind: reports.kind,
      success: reports.success,
      amount: reports.amount,
      reporterBalanceBefore: reports.reporterBalanceBefore,
      targetBalanceBefore: reports.targetBalanceBefore,
      lowerBalance: reports.lowerBalance,
      grossAmount: reports.grossAmount,
      taxBasisPoints: reports.taxBasisPoints,
      tax: reports.tax,
      creditedAmount: reports.creditedAmount,
      deductedAmount: reports.deductedAmount,
      createdAt: reports.createdAt,
      reporterId: reports.reporterId,
      targetId: reports.targetId,
      reporterName: reporter.groupName,
      reporterUsername: reporter.username,
      targetName: target.groupName,
      targetUsername: target.username,
    }).from(reports)
      .leftJoin(reporter, eq(reports.reporterId, reporter.id))
      .leftJoin(target, eq(reports.targetId, target.id))
      .where(where).orderBy(desc(reports.createdAt), desc(reports.id))
      .limit(pageSize).offset(offset).all();
    const items = rows.map((row) => ({
      ...row,
      direction: row.reporterId === ctx.user.id ? "out" as const : "in" as const,
      reporterDisplay: row.reporterName ?? row.reporterUsername ?? "未知",
      targetDisplay: row.targetName ?? row.targetUsername ?? "未知",
    }));
    return paginatedResult(items, total, page, pageSize);
  })),

  // ---- 额度流水（分页，可按类型筛选） ----
  myTransactions: memberQuery
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
        kind: z.enum(["draw", "checkin", "video_reward", "report", "redeem", "credit_expire", "adjust", "usage", "duel", "team_battle"]).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const conds = [eq(transactions.userId, ctx.user.id)];
      if (input.kind) conds.push(eq(transactions.kind, input.kind));
      const where = and(...conds);
      const db = getDb();
      const total = (await db.select({ c: sql<number>`COUNT(*)` }).from(transactions).where(where))[0]?.c ?? 0;
      const { page, pageSize, totalPages, offset } = resolvePagination(Number(total), input.page, input.pageSize);
      const rows = await db
        .select()
        .from(transactions)
        .where(where)
        .orderBy(desc(transactions.id))
        .limit(pageSize)
        .offset(offset);
      return { rows, items: rows, total, page, pageSize, totalPages };
    }),
});
