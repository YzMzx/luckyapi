import { z } from "zod";
import { randomBytes, randomInt as secureRandomInt } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { recordTx } from "../queries/ledger";
import {
  announcements,
  checkins,
  dailySignins,
  drawFund,
  draws,
  signinFund,
  users,
  videoRewardFund,
  videoRewardLedger,
  videoRewardSessions,
} from "@db/schema";
import { createRouter } from "../middleware";
import { assertModuleAvailable } from "../queries/policies";
import { memberQuery } from "../auth";
import {
  currentBusinessDay,
  readDailyLimits,
  readDrawConfig,
  readSigninConfig,
} from "../queries/entertainment-control";
import { publicSlotState, resolveSlotState } from "../queries/slot-control";
import { centsToDollars, selectWeightedReward } from "@contracts/entertainment";
import { paginatedResult, paginationInput, resolvePagination } from "../pagination";
import {
  VIDEO_REWARD_MAX_HEARTBEAT_MS,
  VIDEO_REWARD_MAX_SESSION_MS,
  VIDEO_REWARD_MIN_HEARTBEAT_MS,
  videoRewardUnitsToDollars,
} from "@contracts/video-reward";
import {
  parseVideoRewardSnapshot,
  readVideoRewardConfig,
  videoRewardSnapshot,
} from "../queries/video-reward";

type EntertainmentDb = Parameters<typeof currentBusinessDay>[0];
type VideoRewardDb = EntertainmentDb & Pick<ReturnType<typeof getDb>, "update">;
type VideoRewardSession = typeof videoRewardSessions.$inferSelect;

function dailyVideoRewardSpent(db: EntertainmentDb, businessDay: string) {
  return Number(db.select({ n: sql<number>`COALESCE(SUM(${videoRewardLedger.amountUnits}), 0)` })
    .from(videoRewardLedger).where(eq(videoRewardLedger.businessDay, businessDay)).get()?.n ?? 0);
}

function videoRewardClaimResult(row: VideoRewardSession, idempotent: boolean) {
  if (row.rewardUnits === null || !row.claimedAt) return null;
  return {
    sessionId: row.id,
    requestId: row.claimRequestId,
    businessDay: row.businessDay,
    rewardUnits: row.rewardUnits,
    reward: videoRewardUnitsToDollars(row.rewardUnits),
    claimedAt: row.claimedAt,
    idempotent,
  };
}

function publicVideoRewardSession(row: VideoRewardSession | undefined, includeToken = true) {
  if (!row) return null;
  const snapshot = parseVideoRewardSnapshot(row.configSnapshot);
  const requiredMs = snapshot.minWatchSeconds * 1_000;
  return {
    id: row.id,
    sessionToken: includeToken && row.status !== "claimed" ? row.sessionToken : undefined,
    businessDay: row.businessDay,
    videoResource: row.videoResource,
    status: row.status,
    watchedMs: row.watchedMs,
    watchedSeconds: Math.floor(row.watchedMs / 1_000),
    requiredSeconds: snapshot.minWatchSeconds,
    remainingSeconds: Math.max(0, Math.ceil((requiredMs - row.watchedMs) / 1_000)),
    ready: row.status === "ready" || row.status === "claimed",
    lastSequence: row.lastSequence,
    startedAt: row.startedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    claimedAt: row.claimedAt,
    result: videoRewardClaimResult(row, true),
  };
}

function expireStaleVideoRewardSessions(db: VideoRewardDb, userId: number, businessDay: string, now = new Date()) {
  db.update(videoRewardSessions).set({ status: "expired", updatedAt: now }).where(and(
    eq(videoRewardSessions.userId, userId),
    eq(videoRewardSessions.businessDay, businessDay),
    or(eq(videoRewardSessions.status, "active"), eq(videoRewardSessions.status, "ready")),
    lt(videoRewardSessions.startedAt, new Date(now.getTime() - VIDEO_REWARD_MAX_SESSION_MS)),
  )).run();
}

function claimedVideoRewardCount(db: EntertainmentDb, userId: number, businessDay: string) {
  return Number(db.select({ n: sql<number>`COUNT(*)` }).from(videoRewardSessions).where(and(
    eq(videoRewardSessions.userId, userId),
    eq(videoRewardSessions.businessDay, businessDay),
    eq(videoRewardSessions.status, "claimed"),
  )).get()?.n ?? 0);
}

function readMemberVideoRewardState(db: VideoRewardDb, userId: number) {
  const day = currentBusinessDay(db);
  const config = readVideoRewardConfig(db);
  expireStaleVideoRewardSessions(db, userId, day.key);
  const activeSession = db.select().from(videoRewardSessions).where(and(
    eq(videoRewardSessions.userId, userId),
    eq(videoRewardSessions.businessDay, day.key),
    or(eq(videoRewardSessions.status, "active"), eq(videoRewardSessions.status, "ready")),
  )).orderBy(desc(videoRewardSessions.id)).limit(1).get();
  const lastClaimedSession = db.select().from(videoRewardSessions).where(and(
    eq(videoRewardSessions.userId, userId),
    eq(videoRewardSessions.businessDay, day.key),
    eq(videoRewardSessions.status, "claimed"),
  )).orderBy(desc(videoRewardSessions.claimedAt), desc(videoRewardSessions.id)).limit(1).get();
  const claimedCount = claimedVideoRewardCount(db, userId, day.key);
  const remainingCount = Math.max(0, config.dailyLimit - claimedCount);
  const spentUnits = dailyVideoRewardSpent(db, day.key);
  const remainingBudgetUnits = Math.max(0, config.dailyBudgetUnits - spentUnits);
  const fundUnits = Number(db.select({ balanceUnits: videoRewardFund.balanceUnits }).from(videoRewardFund)
    .where(eq(videoRewardFund.id, 1)).limit(1).get()?.balanceUnits ?? 0);
  const enoughBudget = remainingBudgetUnits >= config.maxRewardUnits;
  const enoughFund = !config.useFund || fundUnits >= config.maxRewardUnits;
  const unavailableReason = !config.enabled
      ? "disabled" as const
      : remainingCount === 0
        ? "daily_limit_reached" as const
      : config.dailyBudgetUnits === 0
        ? "budget_disabled" as const
        : !enoughBudget
          ? "daily_budget_exhausted" as const
          : !enoughFund
            ? "fund_exhausted" as const
            : null;
  return {
    businessDay: day.key,
    nextDayAt: day.endsAt,
    enabled: config.enabled,
    dailyLimit: config.dailyLimit,
    claimedCount,
    remainingCount,
    canStart: !activeSession && unavailableReason === null,
    canResume: !!activeSession,
    unavailableReason,
    minWatchSeconds: config.minWatchSeconds,
    minRewardUnits: config.minRewardUnits,
    maxRewardUnits: config.maxRewardUnits,
    minReward: videoRewardUnitsToDollars(config.minRewardUnits),
    maxReward: videoRewardUnitsToDollars(config.maxRewardUnits),
    dailyBudgetUnits: config.dailyBudgetUnits,
    dailySpentUnits: spentUnits,
    dailyRemainingUnits: remainingBudgetUnits,
    useFund: config.useFund,
    fundRemainingUnits: config.useFund ? fundUnits : null,
    videoResource: config.videoResource,
    session: publicVideoRewardSession(activeSession),
    result: lastClaimedSession ? videoRewardClaimResult(lastClaimedSession, true) : null,
  };
}

function publicAnnouncementWhere(now: Date) {
  return and(
    eq(announcements.status, "published"),
    lte(announcements.publishedAt, now),
    or(isNull(announcements.endsAt), gt(announcements.endsAt, now)),
  );
}

function publicAnnouncements(db: Parameters<typeof currentBusinessDay>[0], now: Date, limit: number) {
  return db.select({
    id: announcements.id,
    title: announcements.title,
    content: announcements.content,
    severity: announcements.severity,
    pinned: announcements.pinned,
    sortOrder: announcements.sortOrder,
    publishedAt: announcements.publishedAt,
    endsAt: announcements.endsAt,
  }).from(announcements).where(publicAnnouncementWhere(now))
    .orderBy(desc(announcements.pinned), desc(announcements.sortOrder), desc(announcements.publishedAt), asc(announcements.id))
    .limit(limit).all();
}

function signinResult(row: typeof dailySignins.$inferSelect, idempotent: boolean) {
  return {
    requestId: row.requestId,
    day: row.day,
    reward: centsToDollars(row.rewardUnits),
    rewardUnits: row.rewardUnits,
    createdAt: row.createdAt,
    idempotent,
  };
}

export const entertainmentRouter = createRouter({
  summary: memberQuery.query(({ ctx }) => getDb().transaction((tx) => {
    const now = new Date();
    const day = currentBusinessDay(tx, now);
    const limits = readDailyLimits(tx);
    const drawConfig = readDrawConfig(tx);
    const signinConfig = readSigninConfig(tx);
    const draw = tx.select().from(draws).where(eq(draws.userId, ctx.user.id)).limit(1).get();
    const drawPool = tx.select().from(drawFund).where(eq(drawFund.id, 1)).limit(1).get();
    const drawUsed = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(draws)
      .where(sql`${draws.userId} IS NOT NULL`).get()?.n ?? 0);
    const slotUsed = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(checkins)
      .where(and(
        eq(checkins.userId, ctx.user.id),
        gte(checkins.createdAt, day.startsAt),
        lt(checkins.createdAt, day.endsAt),
      )).get()?.n ?? 0);
    const signin = tx.select().from(dailySignins)
      .where(and(eq(dailySignins.userId, ctx.user.id), eq(dailySignins.day, day.key))).limit(1).get();
    const signinPool = tx.select().from(signinFund).where(eq(signinFund.id, 1)).limit(1).get();
    const signinRiskUnits = signinConfig.mode === "fixed" ? signinConfig.fixedUnits : signinConfig.maxUnits;
    const signinBudgetAvailable = Number(signinPool?.balanceUnits ?? 0) >= signinRiskUnits;
    const slotState = resolveSlotState(tx);
    const drawCapacity = drawConfig.totalLimit === 0 || drawUsed < drawConfig.totalLimit;
    const drawBudget = drawConfig.ratePpm === 0 || Number(drawPool?.balanceUnits ?? 0) >= drawConfig.minUnits;
    return {
      businessDay: {
        key: day.key,
        startsAt: day.startsAt,
        endsAt: day.endsAt,
        timezoneOffsetMinutes: day.timezoneOffsetMinutes,
        startHour: day.startHour,
      },
      draw: {
        enabled: drawConfig.enabled,
        participated: !!draw,
        canDraw: drawConfig.enabled && !draw && drawCapacity && drawBudget,
        result: draw ? { won: draw.won, amount: draw.amount, createdAt: draw.createdAt } : null,
        rewardRange: [centsToDollars(drawConfig.minUnits), centsToDollars(drawConfig.maxUnits)] as const,
      },
      slot: {
        enabled: limits.slot > 0,
        dailyLimit: limits.slot,
        used: slotUsed,
        remaining: Math.max(0, limits.slot - slotUsed),
        rules: publicSlotState(slotState),
      },
      signin: {
        enabled: signinConfig.enabled,
        done: !!signin,
        canSignin: signinConfig.enabled && !signin && signinBudgetAvailable,
        unavailableReason: signin
          ? "already_signed" as const
          : !signinConfig.enabled
            ? "disabled" as const
            : !signinBudgetAvailable
              ? "budget_exhausted" as const
              : null,
        result: signin ? signinResult(signin, true) : null,
        minReward: centsToDollars(signinConfig.minUnits),
        maxReward: centsToDollars(signinConfig.maxUnits),
        mode: signinConfig.mode,
        budgetRemaining: centsToDollars(Number(signinPool?.balanceUnits ?? 0)),
      },
      videoReward: readMemberVideoRewardState(tx, ctx.user.id),
      announcements: publicAnnouncements(tx, now, 10),
    };
  })),

  signinStatus: memberQuery.query(({ ctx }) => getDb().transaction((tx) => {
    const day = currentBusinessDay(tx);
    const config = readSigninConfig(tx);
    const row = tx.select().from(dailySignins)
      .where(and(eq(dailySignins.userId, ctx.user.id), eq(dailySignins.day, day.key))).limit(1).get();
    const fund = tx.select().from(signinFund).where(eq(signinFund.id, 1)).limit(1).get();
    const riskUnits = config.mode === "fixed" ? config.fixedUnits : config.maxUnits;
    const budgetAvailable = Number(fund?.balanceUnits ?? 0) >= riskUnits;
    return {
      enabled: config.enabled,
      done: !!row,
      canSignin: config.enabled && !row && budgetAvailable,
      unavailableReason: row
        ? "already_signed" as const
        : !config.enabled
          ? "disabled" as const
          : !budgetAvailable
            ? "budget_exhausted" as const
            : null,
      result: row ? signinResult(row, true) : null,
      day: day.key,
      nextDayAt: day.endsAt,
      minReward: centsToDollars(config.minUnits),
      maxReward: centsToDollars(config.maxUnits),
      mode: config.mode,
      budgetRemaining: centsToDollars(Number(fund?.balanceUnits ?? 0)),
    };
  })),

  signin: memberQuery.input(z.object({ requestId: z.string().uuid() })).mutation(({ ctx, input }) =>
    getDb().transaction((tx) => {
      assertModuleAvailable(tx, "signin", ctx.user.id);
      const existingRequest = tx.select().from(dailySignins)
        .where(eq(dailySignins.requestId, input.requestId)).limit(1).get();
      if (existingRequest) {
        if (existingRequest.userId !== ctx.user.id)
          throw new TRPCError({ code: "CONFLICT", message: "请求编号已被占用" });
        return signinResult(existingRequest, true);
      }
      const day = currentBusinessDay(tx);
      const config = readSigninConfig(tx);
      if (!config.enabled) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "每日签到暂未开放" });
      const existingDay = tx.select().from(dailySignins)
        .where(and(eq(dailySignins.userId, ctx.user.id), eq(dailySignins.day, day.key))).limit(1).get();
      if (existingDay) return signinResult(existingDay, true);
      const fund = tx.select().from(signinFund).where(eq(signinFund.id, 1)).limit(1).get();
      const fundBeforeUnits = Number(fund?.balanceUnits ?? 0);
      if (fundBeforeUnits < config.minUnits)
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "签到活动预算已用完" });

      let rewardUnits: number;
      if (config.mode === "fixed") {
        if (fundBeforeUnits < config.fixedUnits)
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "签到活动预算不足" });
        rewardUnits = config.fixedUnits;
      } else if (config.mode === "tiers") {
        if (fundBeforeUnits < config.maxUnits)
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "签到活动剩余预算低于最大分档奖励，请联系管理员调整配置" });
        rewardUnits = selectWeightedReward(secureRandomInt, config.tiers).rewardUnits;
      } else {
        rewardUnits = secureRandomInt(config.minUnits, Math.min(config.maxUnits, fundBeforeUnits) + 1);
      }
      const fundAfterUnits = fundBeforeUnits - rewardUnits;
      const snapshot = JSON.stringify({
        minUnits: config.minUnits,
        maxUnits: config.maxUnits,
        mode: config.mode,
        fixedUnits: config.fixedUnits,
        tiers: config.tiers,
        timezoneOffsetMinutes: day.timezoneOffsetMinutes,
        startHour: day.startHour,
      });

      let created: typeof dailySignins.$inferSelect;
      try {
        created = tx.insert(dailySignins).values({
          requestId: input.requestId,
          userId: ctx.user.id,
          day: day.key,
          rewardUnits,
          configSnapshot: snapshot,
          fundBeforeUnits,
          fundAfterUnits,
        }).returning().get();
      } catch {
        const raced = tx.select().from(dailySignins)
          .where(and(eq(dailySignins.userId, ctx.user.id), eq(dailySignins.day, day.key))).limit(1).get();
        if (raced) return signinResult(raced, true);
        throw new TRPCError({ code: "CONFLICT", message: "签到请求冲突，请刷新后查看结果" });
      }
      const funded = tx.update(signinFund).set({
        balanceUnits: sql`${signinFund.balanceUnits} - ${rewardUnits}`,
        updatedAt: new Date(),
      }).where(and(eq(signinFund.id, 1), gte(signinFund.balanceUnits, rewardUnits))).run();
      if (funded.changes !== 1) throw new TRPCError({ code: "CONFLICT", message: "签到预算刚刚发生变化，请重试" });
      const reward = centsToDollars(rewardUnits);
      tx.update(users).set({
        balance: sql`${users.balance} + ${reward}`,
        totalWon: sql`${users.totalWon} + ${reward}`,
      }).where(eq(users.id, ctx.user.id)).run();
      recordTx(tx, ctx.user.id, "checkin", reward, `每日签到（业务日 ${day.key}）`);
      return signinResult(created, false);
    })),

  videoRewardStatus: memberQuery.query(({ ctx }) => getDb().transaction((tx) =>
    readMemberVideoRewardState(tx, ctx.user.id))),

  startVideoRewardSession: memberQuery.input(z.object({
    requestId: z.string().uuid(),
  }).strict()).mutation(({ ctx, input }) => getDb().transaction((tx) => {
    assertModuleAvailable(tx, "videoReward", ctx.user.id);
    const day = currentBusinessDay(tx);
    const sameRequest = tx.select().from(videoRewardSessions)
      .where(eq(videoRewardSessions.startRequestId, input.requestId)).limit(1).get();
    if (sameRequest) {
      if (sameRequest.userId !== ctx.user.id)
        throw new TRPCError({ code: "CONFLICT", message: "Request ID is already in use" });
      if (sameRequest.businessDay !== day.key)
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This request belongs to an expired business day" });
      return { session: publicVideoRewardSession(sameRequest), idempotent: true };
    }

    expireStaleVideoRewardSessions(tx, ctx.user.id, day.key);
    const existing = tx.select().from(videoRewardSessions).where(and(
      eq(videoRewardSessions.userId, ctx.user.id),
      eq(videoRewardSessions.businessDay, day.key),
      or(eq(videoRewardSessions.status, "active"), eq(videoRewardSessions.status, "ready")),
    )).orderBy(desc(videoRewardSessions.id)).limit(1).get();
    if (existing) return { session: publicVideoRewardSession(existing), idempotent: true };

    const state = readMemberVideoRewardState(tx, ctx.user.id);
    if (state.unavailableReason)
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Video reward unavailable: ${state.unavailableReason}` });
    const snapshot = videoRewardSnapshot(tx);
    const now = new Date();
    let created: VideoRewardSession;
    try {
      created = tx.insert(videoRewardSessions).values({
        sessionToken: randomBytes(32).toString("hex"),
        startRequestId: input.requestId,
        userId: ctx.user.id,
        businessDay: day.key,
        videoResource: snapshot.videoResource,
        configSnapshot: JSON.stringify(snapshot),
        startedAt: now,
        lastHeartbeatAt: now,
        updatedAt: now,
      }).returning().get();
    } catch {
      const raced = tx.select().from(videoRewardSessions).where(and(
        eq(videoRewardSessions.userId, ctx.user.id),
        eq(videoRewardSessions.businessDay, day.key),
        or(eq(videoRewardSessions.status, "active"), eq(videoRewardSessions.status, "ready")),
      )).orderBy(desc(videoRewardSessions.id)).limit(1).get();
      if (raced) return { session: publicVideoRewardSession(raced), idempotent: true };
      throw new TRPCError({ code: "CONFLICT", message: "Unable to start the viewing session; please retry" });
    }
    return { session: publicVideoRewardSession(created), idempotent: false };
  })),

  heartbeatVideoReward: memberQuery.input(z.object({
    sessionToken: z.string().regex(/^[a-f0-9]{64}$/),
    sequence: z.number().int().positive(),
  }).strict()).mutation(({ ctx, input }) => {
    const outcome = getDb().transaction((tx) => {
    const row = tx.select().from(videoRewardSessions).where(and(
      eq(videoRewardSessions.sessionToken, input.sessionToken),
      eq(videoRewardSessions.userId, ctx.user.id),
    )).limit(1).get();
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Viewing session not found" });
    const day = currentBusinessDay(tx);
    const now = new Date();
    if (row.businessDay !== day.key) {
      if (row.status === "active" || row.status === "ready")
        tx.update(videoRewardSessions).set({ status: "expired", updatedAt: now })
          .where(eq(videoRewardSessions.id, row.id)).run();
      return { rejection: "crossed_business_day" as const };
    }
    if (now.getTime() - row.startedAt.getTime() > VIDEO_REWARD_MAX_SESSION_MS) {
      tx.update(videoRewardSessions).set({ status: "expired", updatedAt: now })
        .where(eq(videoRewardSessions.id, row.id)).run();
      return { rejection: "expired" as const };
    }
    if (row.status === "claimed") return { accepted: false, reason: "already_claimed" as const, session: publicVideoRewardSession(row) };
    if (row.status === "expired")
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Viewing session has expired" });
    if (row.status === "ready") return { accepted: false, reason: "already_ready" as const, session: publicVideoRewardSession(row) };
    if (input.sequence !== row.lastSequence + 1)
      throw new TRPCError({ code: "CONFLICT", message: `Expected heartbeat sequence ${row.lastSequence + 1}` });

    const elapsedMs = now.getTime() - row.lastHeartbeatAt.getTime();
    if (elapsedMs < VIDEO_REWARD_MIN_HEARTBEAT_MS)
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Heartbeat arrived too quickly" });
    if (elapsedMs > VIDEO_REWARD_MAX_HEARTBEAT_MS) {
      const updated = tx.update(videoRewardSessions).set({
        lastSequence: input.sequence,
        lastHeartbeatAt: now,
        updatedAt: now,
      }).where(and(eq(videoRewardSessions.id, row.id), eq(videoRewardSessions.lastSequence, row.lastSequence)))
        .returning().get();
      if (!updated) throw new TRPCError({ code: "CONFLICT", message: "Heartbeat sequence was already consumed" });
      return { accepted: false, reason: "gap_too_large" as const, creditedMs: 0, session: publicVideoRewardSession(updated) };
    }

    const snapshot = parseVideoRewardSnapshot(row.configSnapshot);
    const watchedMs = Math.min(snapshot.minWatchSeconds * 1_000, row.watchedMs + elapsedMs);
    const status = watchedMs >= snapshot.minWatchSeconds * 1_000 ? "ready" as const : "active" as const;
    const updated = tx.update(videoRewardSessions).set({
      watchedMs,
      status,
      lastSequence: input.sequence,
      lastHeartbeatAt: now,
      updatedAt: now,
    }).where(and(eq(videoRewardSessions.id, row.id), eq(videoRewardSessions.lastSequence, row.lastSequence)))
      .returning().get();
    if (!updated) throw new TRPCError({ code: "CONFLICT", message: "Heartbeat sequence was already consumed" });
    return { accepted: true, reason: null, creditedMs: elapsedMs, session: publicVideoRewardSession(updated) };
    });
    if ("rejection" in outcome) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: outcome.rejection === "crossed_business_day"
          ? "Viewing session has crossed the business-day boundary"
          : "Viewing session has expired",
      });
    }
    return outcome;
  }),

  claimVideoReward: memberQuery.input(z.object({
    sessionToken: z.string().regex(/^[a-f0-9]{64}$/),
    requestId: z.string().uuid(),
  }).strict()).mutation(({ ctx, input }) => getDb().transaction((tx) => {
    const sameRequest = tx.select().from(videoRewardLedger)
      .where(eq(videoRewardLedger.requestId, input.requestId)).limit(1).get();
    if (sameRequest) {
      if (sameRequest.userId !== ctx.user.id)
        throw new TRPCError({ code: "CONFLICT", message: "Request ID is already in use" });
      const existingSession = tx.select().from(videoRewardSessions)
        .where(eq(videoRewardSessions.id, sameRequest.sessionId)).limit(1).get();
      if (!existingSession) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Reward audit session is missing" });
      if (existingSession.sessionToken !== input.sessionToken)
        throw new TRPCError({ code: "CONFLICT", message: "Request ID belongs to another viewing session" });
      return videoRewardClaimResult(existingSession, true);
    }

    const session = tx.select().from(videoRewardSessions).where(and(
      eq(videoRewardSessions.sessionToken, input.sessionToken),
      eq(videoRewardSessions.userId, ctx.user.id),
    )).limit(1).get();
    if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Viewing session not found" });
    if (session.status === "claimed") return videoRewardClaimResult(session, true);
    const day = currentBusinessDay(tx);
    if (session.businessDay !== day.key)
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Viewing session has crossed the business-day boundary" });
    if (Date.now() - session.startedAt.getTime() > VIDEO_REWARD_MAX_SESSION_MS)
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Viewing session has expired" });
    if (session.status !== "ready")
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Required server-verified viewing time has not been reached" });
    const snapshot = parseVideoRewardSnapshot(session.configSnapshot);
    if (session.watchedMs < snapshot.minWatchSeconds * 1_000)
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Required server-verified viewing time has not been reached" });

    // Daily count and enabled state are live controls. Reward/watch/budget/fund
    // values remain the immutable session snapshot for an auditable claim.
    const liveConfig = readVideoRewardConfig(tx);
    if (!liveConfig.enabled)
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Video reward unavailable: disabled" });
    if (claimedVideoRewardCount(tx, ctx.user.id, day.key) >= liveConfig.dailyLimit)
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Video reward unavailable: daily_limit_reached" });

    const dailySpentBeforeUnits = dailyVideoRewardSpent(tx, day.key);
    const dailyRemainingUnits = snapshot.dailyBudgetUnits - dailySpentBeforeUnits;
    if (snapshot.dailyBudgetUnits === 0 || dailyRemainingUnits < snapshot.maxRewardUnits)
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Daily video reward budget is exhausted" });
    const fund = tx.select().from(videoRewardFund).where(eq(videoRewardFund.id, 1)).limit(1).get();
    const fundBeforeUnits = Number(fund?.balanceUnits ?? 0);
    if (snapshot.useFund && fundBeforeUnits < snapshot.maxRewardUnits)
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Video reward fund is exhausted" });

    const rewardUnits = secureRandomInt(snapshot.minRewardUnits, snapshot.maxRewardUnits + 1);
    const reward = videoRewardUnitsToDollars(rewardUnits);
    const dailySpentAfterUnits = dailySpentBeforeUnits + rewardUnits;
    const fundAfterUnits = snapshot.useFund ? fundBeforeUnits - rewardUnits : null;
    if (snapshot.useFund) {
      const funded = tx.update(videoRewardFund).set({
        balanceUnits: sql`${videoRewardFund.balanceUnits} - ${rewardUnits}`,
        updatedAt: new Date(),
      }).where(and(eq(videoRewardFund.id, 1), gte(videoRewardFund.balanceUnits, rewardUnits))).run();
      if (funded.changes !== 1)
        throw new TRPCError({ code: "CONFLICT", message: "Video reward fund changed; please retry" });
    }

    const credited = tx.update(users).set({
      balance: sql`${users.balance} + ${reward}`,
      totalWon: sql`${users.totalWon} + ${reward}`,
    }).where(eq(users.id, ctx.user.id)).run();
    if (credited.changes !== 1) throw new TRPCError({ code: "NOT_FOUND", message: "User no longer exists" });
    recordTx(tx, ctx.user.id, "video_reward", reward, `Daily video reward (${day.key})`);
    const balanceAfter = Number(tx.select({ balance: users.balance }).from(users)
      .where(eq(users.id, ctx.user.id)).limit(1).get()?.balance ?? 0);
    const now = new Date();
    try {
      tx.insert(videoRewardLedger).values({
        sessionId: session.id,
        requestId: input.requestId,
        userId: ctx.user.id,
        businessDay: day.key,
        amountUnits: rewardUnits,
        userBalanceAfter: balanceAfter,
        dailySpentBeforeUnits,
        dailySpentAfterUnits,
        fundBeforeUnits: snapshot.useFund ? fundBeforeUnits : null,
        fundAfterUnits,
        note: `server watched ${session.watchedMs}ms / required ${snapshot.minWatchSeconds * 1_000}ms`,
        createdAt: now,
      }).run();
      const claimed = tx.update(videoRewardSessions).set({
        claimRequestId: input.requestId,
        status: "claimed",
        rewardUnits,
        dailySpentBeforeUnits,
        dailySpentAfterUnits,
        fundBeforeUnits: snapshot.useFund ? fundBeforeUnits : null,
        fundAfterUnits,
        claimedAt: now,
        updatedAt: now,
      }).where(and(eq(videoRewardSessions.id, session.id), eq(videoRewardSessions.status, "ready")))
        .returning().get();
      if (!claimed) throw new TRPCError({ code: "CONFLICT", message: "Reward was already claimed" });
      return videoRewardClaimResult(claimed, false);
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      throw new TRPCError({ code: "CONFLICT", message: "Reward claim raced with another request" });
    }
  })),

  announcements: memberQuery.query(() => getDb().transaction((tx) => publicAnnouncements(tx, new Date(), 100))),

  announcementsPage: memberQuery.input(paginationInput).query(({ input }) => getDb().transaction((tx) => {
    const now = new Date();
    const where = publicAnnouncementWhere(now);
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(announcements).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const items = tx.select({
      id: announcements.id,
      title: announcements.title,
      content: announcements.content,
      severity: announcements.severity,
      pinned: announcements.pinned,
      sortOrder: announcements.sortOrder,
      publishedAt: announcements.publishedAt,
      endsAt: announcements.endsAt,
    }).from(announcements).where(where)
      .orderBy(desc(announcements.pinned), desc(announcements.sortOrder), desc(announcements.publishedAt), asc(announcements.id))
      .limit(pageSize).offset(offset).all();
    return paginatedResult(items, total, page, pageSize);
  })),

  announcement: memberQuery.input(z.object({ id: z.number().int().positive() })).query(({ input }) =>
    getDb().transaction((tx) => {
      const now = new Date();
      const row = tx.select().from(announcements).where(and(
        eq(announcements.id, input.id),
        eq(announcements.status, "published"),
        lte(announcements.publishedAt, now),
        or(isNull(announcements.endsAt), gt(announcements.endsAt, now)),
      )).limit(1).get();
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "公告不存在或当前不可见" });
      return row;
    })),
});
