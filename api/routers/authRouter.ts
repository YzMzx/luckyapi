import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, and, isNull, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { inviteCodes, pendingSessions, pendingUsers, sessions, users, models } from "../../db/schema";
import { createRouter, publicQuery } from "../middleware";
import { getSetting, SETTING_KEYS } from "../settings";
import {
  pendingQuery,
  getSessionUser,
  getPendingSessionUser,
  destroySession,
  destroyPendingSession,
  clearCookieHeader,
  cookieHeader,
  randomToken,
  PENDING_COOKIE,
  requestUsesHttps,
  USER_COOKIE,
} from "../auth";
import { groupNameSchema } from "@contracts/group-name";
import { assertModuleAvailable } from "../queries/policies";

export const authRouter = createRouter({
  // 公开站点配置：抽奖金额范围（首页/跑马灯展示用）
  publicConfig: publicQuery.query(async () => {
    const p = async (key: string, def: string) => {
      const v = Number(await getSetting(key, def));
      return Number.isNaN(v) ? Number(def) : v;
    };
    const min = await p(SETTING_KEYS.drawMin, "5");
    const max = await p(SETTING_KEYS.drawMax, "10");
    return {
      drawMin: min,
      drawMax: Math.max(min, max),
    };
  }),

  // 模型广场（公开）：展示可用模型与价格
  publicModels: publicQuery.query(async () => {
    const rows = await getDb()
      .select({
        id: models.id,
        name: models.name,
        apiType: models.apiType,
        priceInput: models.priceInput,
        priceOutput: models.priceOutput,
        priceCacheWrite: models.priceCacheWrite,
        priceCacheRead: models.priceCacheRead,
        allowedGroups: models.allowedGroups,
      })
      .from(models)
      .where(eq(models.enabled, true));
    return rows;
  }),

  me: publicQuery.query(async ({ ctx }) => {
    const user = await getSessionUser(ctx.req);
    if (user) {
      return {
        id: user.id,
        linuxdoId: user.linuxdoId,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        trustLevel: user.trustLevel,
        groupName: user.groupName,
        balance: user.balance,
        totalWon: user.totalWon,
        onboarded: true as const,
        registrationState: "registered" as const,
      };
    }
    const pending = await getPendingSessionUser(ctx.req);
    if (!pending) return null;
    return {
      id: pending.id,
      linuxdoId: pending.linuxdoId,
      username: pending.username,
      displayName: pending.displayName,
      avatarUrl: pending.avatarUrl,
      trustLevel: pending.trustLevel,
      groupName: null,
      balance: 0,
      totalWon: 0,
      onboarded: false as const,
      registrationState: "pending" as const,
    };
  }),

  // 首次登录后：填邀请码 + 群内昵称
  completeOnboarding: pendingQuery
    .input(z.object({ inviteCode: z.string().trim().min(4).max(32), groupName: groupNameSchema }))
    .mutation(({ ctx, input }) => {
      const db = getDb();
      const sessionToken = randomToken();
      return db.transaction((tx) => {
        assertModuleAvailable(tx, "registration");
        const alreadyRegistered = tx.select({ id: users.id }).from(users)
          .where(eq(users.linuxdoId, ctx.pendingUser.linuxdoId)).limit(1).get();
        if (alreadyRegistered)
          throw new TRPCError({ code: "BAD_REQUEST", message: "该账号已完成注册，请重新登录" });
        const duplicate = tx.select({ id: users.id }).from(users)
          .where(sql`lower(${users.groupName}) = lower(${input.groupName})`).limit(1).get();
        if (duplicate)
          throw new TRPCError({ code: "BAD_REQUEST", message: "该群内名称已被占用，换一个吧" });

        const created = tx.insert(users).values({
          linuxdoId: ctx.pendingUser.linuxdoId,
          username: ctx.pendingUser.username,
          displayName: ctx.pendingUser.displayName,
          avatarUrl: ctx.pendingUser.avatarUrl,
          trustLevel: ctx.pendingUser.trustLevel,
          groupName: input.groupName,
        }).returning({ id: users.id }).get();

        // 邀请码核销与名称写入放在同一事务；任一步失败都会回滚，避免邀请码被吃掉。
        const res = tx
          .update(inviteCodes)
          .set({ usedBy: created.id, usedAt: new Date(), redemptionCount: 1 })
          .where(and(
            eq(inviteCodes.code, input.inviteCode),
            eq(inviteCodes.type, "invite"),
            isNull(inviteCodes.usedBy),
          ))
          .run();
        if (res.changes === 0)
          throw new TRPCError({ code: "BAD_REQUEST", message: "邀请码无效或已被使用" });
        tx.insert(sessions).values({
          token: sessionToken,
          userId: created.id,
          expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        }).run();
        tx.delete(pendingSessions).where(eq(pendingSessions.pendingUserId, ctx.pendingUser.id)).run();
        tx.delete(pendingUsers).where(eq(pendingUsers.id, ctx.pendingUser.id)).run();
        const secureCookie = requestUsesHttps(ctx.req);
        ctx.resHeaders.append("set-cookie", cookieHeader(USER_COOKIE, sessionToken, 30 * 24 * 3600, secureCookie));
        ctx.resHeaders.append("set-cookie", clearCookieHeader(PENDING_COOKIE, secureCookie));
        return { ok: true, groupName: input.groupName, userId: created.id };
      });
    }),

  logout: publicQuery.mutation(async ({ ctx }) => {
    const cookie = ctx.req.headers.get("cookie") ?? "";
    const match = cookie.match(new RegExp(`${USER_COOKIE}=([^;]+)`));
    if (match) await destroySession(decodeURIComponent(match[1]));
    const pendingMatch = cookie.match(new RegExp(`${PENDING_COOKIE}=([^;]+)`));
    if (pendingMatch) await destroyPendingSession(decodeURIComponent(pendingMatch[1]));
    const secureCookie = requestUsesHttps(ctx.req);
    ctx.resHeaders.append("set-cookie", clearCookieHeader(USER_COOKIE, secureCookie));
    ctx.resHeaders.append("set-cookie", clearCookieHeader(PENDING_COOKIE, secureCookie));
    return { ok: true };
  }),
});
