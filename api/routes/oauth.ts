import { Hono, type Context } from "hono";
import {
  clearCookieHeader,
  createPendingSession,
  createSession,
  cookieHeader,
  PENDING_COOKIE,
  USER_COOKIE,
  randomToken,
} from "../auth";
import { getSetting, SETTING_KEYS } from "../settings";
import { upsertOAuthIdentity } from "../queries/oauth-identity";
import { assertModuleAvailable } from "../queries/policies";
import { getDb } from "../queries/connection";

const AUTHORIZE_URL = "https://connect.linux.do/oauth2/authorize";
const TOKEN_URL = "https://connect.linux.do/oauth2/token";
const USERINFO_URL = "https://connect.linux.do/api/user";
type PendingState = { createdAt: number; origin: string; returnTo: string };
const pendingStates = new Map<string, PendingState>();
export const oauthApp = new Hono();

export function normalizeConfiguredOrigin(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return /^https?:$/.test(url.protocol) ? url.origin : "";
  } catch { return ""; }
}

export function safeReturnTo(value: string | undefined) {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\r\n]/.test(value)) return "/draw";
  return value;
}

export function isTrustedOrigin(requestOrigin: string, configuredOrigin: string) {
  return !!configuredOrigin && requestOrigin === configuredOrigin;
}

export function trustedCandidateOrigin(candidates: string[], configuredOrigin: string) {
  return candidates.find((origin) => isTrustedOrigin(origin, configuredOrigin)) ?? null;
}

export function validPendingState(pending: PendingState | undefined, currentOrigin: string, now = Date.now()): pending is PendingState {
  return !!pending && now - pending.createdAt <= 10 * 60_000 && pending.origin === currentOrigin;
}

export function resolveRequestOrigin(requestUrl: string, forwardedHostHeader?: string, forwardedProtoHeader?: string) {
  const request = new URL(requestUrl);
  const forwardedHost = forwardedHostHeader?.split(",")[0]?.trim();
  const forwardedProto = forwardedProtoHeader?.split(",")[0]?.trim().toLowerCase();
  const protocol = forwardedProto === "http" || forwardedProto === "https"
    ? `${forwardedProto}:`
    : forwardedHost
      ? "https:"
      : request.protocol;
  try { return new URL(`${protocol}//${forwardedHost || request.host}`).origin; }
  catch { return request.origin; }
}

function forwardedOrigin(c: Context) {
  return resolveRequestOrigin(
    c.req.url,
    c.req.header("x-forwarded-host"),
    c.req.header("x-forwarded-proto"),
  );
}

function browserOrigin(c: Context) {
  const explicit = normalizeConfiguredOrigin(c.req.query("origin"));
  if (explicit) return explicit;
  const referer = c.req.header("referer");
  return normalizeConfiguredOrigin(referer);
}

async function oauthConfig() {
  return {
    clientId: await getSetting(SETTING_KEYS.linuxdoClientId, process.env.LINUXDO_CLIENT_ID),
    clientSecret: await getSetting(SETTING_KEYS.linuxdoClientSecret, process.env.LINUXDO_CLIENT_SECRET),
    configuredOrigin: normalizeConfiguredOrigin(await getSetting(SETTING_KEYS.linuxdoPrimaryOrigin, process.env.LINUXDO_PRIMARY_ORIGIN)),
    callbackPath: "/api/oauth/callback",
    label: "OAuth 入口",
  };
}

function callbackUrl(origin: string, path: string) { return `${origin}${path}`; }
function failPage(c: Context, message: string) {
  return c.html(`<html><body style="font-family:sans-serif;background:#162638;color:#fce1b6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>登录失败</h2><p>${message}</p><p><a href="/" style="color:#af915f">返回首页重试</a></p></div></body></html>`, 400);
}

async function originForRequest(c: Context) {
  const configuredOrigin = normalizeConfiguredOrigin(
    await getSetting(SETTING_KEYS.linuxdoPrimaryOrigin, process.env.LINUXDO_PRIMARY_ORIGIN),
  );
  // Some multi-layer reverse proxies replace Host with the container address.
  // The browser therefore sends its public Origin explicitly. It is never
  // trusted by itself: it must still match the single administrator-owned
  // OAuth origin exactly.
  return trustedCandidateOrigin(
    [forwardedOrigin(c), browserOrigin(c)].filter(Boolean),
    configuredOrigin,
  );
}

async function beginLogin(c: Context, selectedOrigin: string) {
  try { assertModuleAvailable(getDb(), "login"); }
  catch (error) { return failPage(c, error instanceof Error ? error.message : "登录暂不可用"); }
  const config = await oauthConfig();
  if (!config.clientId || !config.clientSecret || !config.configuredOrigin) {
    return c.html(`<html><body style="font-family:sans-serif;background:#162638;color:#fce1b6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>${config.label}尚未配置 LINUX DO Connect</h2><p>请管理员到后台设置 OAuth Client ID、Client Secret 和域名。</p><p><a href="/" style="color:#af915f">返回首页</a></p></div></body></html>`, 500);
  }
  const origin = config.configuredOrigin;
  if (selectedOrigin !== origin) return failPage(c, `${config.label}只能从已配置的可信域名发起登录`);
  const state = randomToken(24);
  pendingStates.set(state, { createdAt: Date.now(), origin, returnTo: safeReturnTo(c.req.query("returnTo")) });
  for (const [key, value] of pendingStates) if (Date.now() - value.createdAt > 10 * 60_000) pendingStates.delete(key);
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", callbackUrl(origin, config.callbackPath));
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
}

async function finishLogin(c: Context) {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return failPage(c, "缺少 code 或 state 参数");
  const pending = pendingStates.get(state);
  const config = await oauthConfig();
  if (!validPendingState(pending, config.configuredOrigin)) return failPage(c, "state 校验失败、入口或回调域名不匹配，或登录已过期，请重新登录");
  pendingStates.delete(state);
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const tokenRes = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callbackUrl(pending.origin, config.callbackPath) }) });
  if (!tokenRes.ok) return failPage(c, `换取 token 失败（${tokenRes.status}）`);
  const tokenData = (await tokenRes.json()) as { access_token?: string };
  if (!tokenData.access_token) return failPage(c, "未获得 access_token");
  const infoRes = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
  if (!infoRes.ok) return failPage(c, `获取用户信息失败（${infoRes.status}）`);
  const info = (await infoRes.json()) as { id: number | string; username: string; name?: string; avatar_template?: string; trust_level?: number; silenced?: boolean };
  if (info.silenced) return failPage(c, "你的 Linux.do 账号处于禁言状态，无法登录");
  // 始终按 Linux.do ID 关联同一站内用户。
  const identity = await upsertOAuthIdentity({ linuxdoId: String(info.id), username: info.username, displayName: info.name || info.username, avatarUrl: info.avatar_template ? `https://linux.do${info.avatar_template.replace("{size}", "120")}` : "", trustLevel: info.trust_level ?? 0 });
  if (identity.kind !== "registered") {
    try { assertModuleAvailable(getDb(), "registration"); }
    catch (error) { return failPage(c, error instanceof Error ? error.message : "新用户注册暂不可用"); }
  }
  const headers = new Headers();
  const secureCookie = pending.origin.startsWith("https://");
  if (identity.kind === "registered") {
    if (identity.user.banned) return failPage(c, "账号已被封禁");
    headers.set("Location", pending.returnTo);
    headers.append("Set-Cookie", cookieHeader(USER_COOKIE, await createSession(identity.user.id), 30 * 24 * 3600, secureCookie));
    headers.append("Set-Cookie", clearCookieHeader(PENDING_COOKIE, secureCookie));
  } else {
    headers.set("Location", "/onboarding");
    headers.append("Set-Cookie", cookieHeader(PENDING_COOKIE, await createPendingSession(identity.user.id), 24 * 3600, secureCookie));
    headers.append("Set-Cookie", clearCookieHeader(USER_COOKIE, secureCookie));
  }
  return new Response(null, { status: 302, headers });
}

// 单一 OAuth 客户端：浏览器公开 origin 必须与管理员配置的唯一可信 origin 精确匹配。
oauthApp.get("/login", async (c) => {
  const origin = await originForRequest(c);
  return origin ? beginLogin(c, origin) : failPage(c, "当前请求域名不是已配置的可信 OAuth 入口。请从站点首页点击登录；若仍失败，请检查反向代理 Host 配置");
});
oauthApp.get("/callback", async (c) => {
  const state = c.req.query("state");
  const pending = state ? pendingStates.get(state) : undefined;
  if (!pending) return failPage(c, "登录 state 不存在或已过期，请从首页重新登录");
  // 回调来自 Linux.do，Origin/Referer 不属于本站，且反向代理可能重写 Host。
  // 安全边界由一次性随机 state、十分钟 TTL、state 绑定的唯一配置域名，以及
  // token 交换时完全相同的 redirect_uri 共同保证，不能再依赖回调请求 Host。
  return finishLogin(c);
});
