import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { eq, gt, and, lte } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { expireAllCreditGrants, expireUserCreditGrants } from "./queries/credit-grants";
import { sessions, pendingSessions, pendingUsers, adminSessions, users, creditGrants, type User, type PendingUser } from "../db/schema";
import { publicQuery } from "./middleware";

export const USER_COOKIE = "ld_session";
export const PENDING_COOKIE = "ld_pending_session";
export const ADMIN_COOKIE = "ld_admin";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

const ADMIN_PASSWORD_PREFIX = "scrypt";
export function hashAdminPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `${ADMIN_PASSWORD_PREFIX}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyAdminPassword(password: string, stored: string): boolean {
  if (!stored.startsWith(`${ADMIN_PASSWORD_PREFIX}$`)) return password === stored;
  const [, saltHex, hashHex] = stored.split("$");
  if (!saltHex || !hashHex || !/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return false;
  try {
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function requestUsesHttps(req: Request): boolean {
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwardedProto === "https") return true;
  if (forwardedProto === "http") return false;
  try { return new URL(req.url).protocol === "https:"; }
  catch { return false; }
}

export function cookieHeader(name: string, value: string, maxAgeSec: number, secure = false): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

export function clearCookieHeader(name: string, secure = false): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export async function createSession(userId: number): Promise<string> {
  const token = randomToken();
  await getDb().insert(sessions).values({
    token,
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

export async function createPendingSession(pendingUserId: number): Promise<string> {
  const token = randomToken();
  const db = getDb();
  await db.delete(pendingSessions).where(eq(pendingSessions.pendingUserId, pendingUserId));
  await db.insert(pendingSessions).values({
    token,
    pendingUserId,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
  return token;
}

export async function destroySession(token: string): Promise<void> {
  await getDb().delete(sessions).where(eq(sessions.token, token));
}

export async function destroyPendingSession(token: string): Promise<void> {
  await getDb().delete(pendingSessions).where(eq(pendingSessions.token, token));
}

export async function getSessionUser(req: Request): Promise<User | null> {
  const token = readCookie(req, USER_COOKIE);
  if (!token) return null;
  const db = getDb();
  const rows = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0]?.user ?? null;
}

export async function getPendingSessionUser(req: Request): Promise<PendingUser | null> {
  const token = readCookie(req, PENDING_COOKIE);
  if (!token) return null;
  const rows = await getDb()
    .select({ user: pendingUsers })
    .from(pendingSessions)
    .innerJoin(pendingUsers, eq(pendingSessions.pendingUserId, pendingUsers.id))
    .where(and(eq(pendingSessions.token, token), gt(pendingSessions.expiresAt, new Date())))
    .limit(1);
  return rows[0]?.user ?? null;
}

async function getAdminSessionId(req: Request): Promise<number | null> {
  const token = readCookie(req, ADMIN_COOKIE);
  if (!token) return null;
  const [session] = await getDb()
    .select({ id: adminSessions.id })
    .from(adminSessions)
    .where(and(eq(adminSessions.token, token), gt(adminSessions.expiresAt, new Date())))
    .limit(1);
  return session?.id ?? null;
}

export async function isAdminRequest(req: Request): Promise<boolean> {
  return (await getAdminSessionId(req)) !== null;
}

export async function createAdminSession(): Promise<string> {
  const token = randomToken();
  await getDb().insert(adminSessions).values({
    token,
    expiresAt: new Date(Date.now() + 12 * 3600 * 1000), // 12 小时
  });
  return token;
}

/** 需要用户登录的 procedure */
export const authedQuery = publicQuery.use(async ({ ctx, next }) => {
  const user = await getSessionUser(ctx.req);
  if (!user) throw new TRPCError({ code: "UNAUTHORIZED", message: "请先登录" });
  if (user.banned) throw new TRPCError({ code: "FORBIDDEN", message: "账号已被封禁" });
  return next({ ctx: { ...ctx, user } });
});

/** 需要已完善资料（群内昵称）的用户 */
export const memberQuery = authedQuery.use(async ({ ctx, next }) => {
  if (!ctx.user.groupName) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "请先完善资料（邀请码 + 群内昵称）" });
  }
  const db = getDb();
  const now = new Date();
  const hasExpiredGrant = db.select({ id: creditGrants.id }).from(creditGrants).where(and(
    eq(creditGrants.userId, ctx.user.id),
    eq(creditGrants.status, "active"),
    gt(creditGrants.remainingUnits, 0),
    lte(creditGrants.expiresAt, now),
  )).limit(1).get();
  if (hasExpiredGrant) db.transaction((tx) => expireUserCreditGrants(tx, ctx.user.id, now));
  const balance = Number(db.select({ balance: users.balance }).from(users).where(eq(users.id, ctx.user.id)).limit(1).get()?.balance ?? 0);
  return next({ ctx: { ...ctx, user: { ...ctx.user, balance } } });
});

/** 仅供完成注册使用；临时身份不能访问任何 member/business procedure。 */
export const pendingQuery = publicQuery.use(async ({ ctx, next }) => {
  const pendingUser = await getPendingSessionUser(ctx.req);
  if (!pendingUser) throw new TRPCError({ code: "UNAUTHORIZED", message: "注册会话已失效，请重新登录" });
  return next({ ctx: { ...ctx, pendingUser } });
});

/** 需要管理员登录的 procedure */
export const adminQuery = publicQuery.use(async ({ ctx, next }) => {
  const adminSessionId = await getAdminSessionId(ctx.req);
  if (adminSessionId === null) throw new TRPCError({ code: "UNAUTHORIZED", message: "需要管理员登录" });
  getDb().transaction((tx) => expireAllCreditGrants(tx));
  return next({ ctx: { adminSessionId } });
});

/** 取客户端 IP：取代理链最后一跳（客户端可伪造前面的条目，最后一跳由平台网关写入） */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}
