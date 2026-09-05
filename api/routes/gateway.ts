import { Hono } from "hono";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { recordTx } from "../queries/ledger";
import { debitUserBalance, expireUserCreditGrants } from "../queries/credit-grants";
import { apiKeys, users, models, groups, upstreams, usageLogs, type Model, type User, type ApiKey, type Group } from "../../db/schema";
import { sha256 } from "../auth";
import { assertModuleAvailable, isApiGroupFrozen, readUserPolicy } from "../queries/policies";
import { currentBusinessDay } from "../queries/entertainment-control";

/**
 * 多协议 API 网关（OpenAI chat / responses / Claude messages / Gemini）
 * - GET  /v1/models
 * - POST /v1/chat/completions              OpenAI chat 协议
 * - POST /v1/responses                     OpenAI responses 协议（Codex）
 * - POST /v1/messages                      Claude messages 协议
 * - POST /v1beta/models/{model}:generateContent | :streamGenerateContent   Gemini 协议
 * 认证：Authorization: Bearer <用户 API Key>
 * 说明：模型标注的 apiType 只是备注，四种协议入口对所有模型开放，原样透传到上游
 * 计费：模型四档价（输入/输出/写缓存/读缓存，留空不计费）× 分组倍率
 */
export const gatewayApp = new Hono();

type Protocol = "chat" | "responses" | "claude" | "gemini";

type Usage = {
  promptTokens: number;
  completionTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

type UsageSource = "upstream" | "estimated";
type CacheStatus = "hit" | "write" | "hit_write" | "miss" | "unknown";
type DetectedUsage = {
  usage: Usage;
  source: UsageSource;
  cacheStatus: CacheStatus;
};

type Caller = { user: User; key: ApiKey; group: Group };
type RoutedModel = Model & { upstreamTimeoutMs: number };

/** 每 Key RPM 滑动窗口限流（内存实现） */
const rateBuckets = new Map<number, number[]>();
const activeRequests = new Map<number, number>();
function checkRateLimit(keyId: number, rpmLimit: number): boolean {
  if (rpmLimit <= 0) return true;
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (rateBuckets.get(keyId) ?? []).filter((t) => t > windowStart);
  if (arr.length >= rpmLimit) {
    rateBuckets.set(keyId, arr);
    return false;
  }
  arr.push(now);
  rateBuckets.set(keyId, arr);
  // 防止 Map 无限增长
  if (rateBuckets.size > 10_000) rateBuckets.clear();
  return true;
}

type LogMeta = {
  durationMs: number;
  ttftMs: number;
  stream: boolean;
  status: "ok" | "error";
  requestId: string;
  protocol: Protocol;
  endpoint: string;
  requestBody: string;
  responseBody: string;
  httpStatus: number;
  upstreamRequestId: string;
  errorMessage: string;
  clientIp: string;
};

const LOG_BODY_LIMIT = 64 * 1024;
const SENSITIVE_KEYS = /(?:^|[-_])(authorization|api[-_]?key|password|secret|token)(?:$|[-_])/i;

function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "").trim().slice(0, 128);
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[depth limited]";
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_KEYS.test(key) ? "[redacted]" : redactValue(item, depth + 1),
    ]),
  );
}

/** 日志正文限制为 64 KiB，并脱敏常见凭据字段，避免数据库被超大请求撑满。 */
export function bodyForLog(text: string): string {
  let output = text;
  try {
    output = JSON.stringify(redactValue(JSON.parse(text)));
  } catch {
    // SSE/纯文本响应保留原样
  }
  return output.length > LOG_BODY_LIMIT ? `${output.slice(0, LOG_BODY_LIMIT)}\n...[truncated]` : output;
}

export function cacheStatus(usage: Usage, cacheMetadataReported: boolean): CacheStatus {
  if (usage.cacheReadTokens > 0 && usage.cacheWriteTokens > 0) return "hit_write";
  if (usage.cacheReadTokens > 0) return "hit";
  if (usage.cacheWriteTokens > 0) return "write";
  return cacheMetadataReported ? "miss" : "unknown";
}

function estimatedUsage(bodyText: string, resultText: string): DetectedUsage {
  return { usage: estimateUsage(bodyText, resultText), source: "estimated", cacheStatus: "unknown" };
}

function jsonError(status: number, message: string, type = "invalid_request_error") {
  return new Response(JSON.stringify({ error: { message, type, code: null } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function defaultGroup(): Promise<Group> {
  const db = getDb();
  let row = (await db.select().from(groups).where(eq(groups.name, "default")).limit(1))[0];
  if (!row) {
    await db.insert(groups).values({ name: "default", multiplier: 1, description: "默认分组" });
    row = (await db.select().from(groups).where(eq(groups.name, "default")).limit(1))[0];
  }
  return row;
}

async function resolveCaller(req: Request): Promise<Caller | Response> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return jsonError(401, "缺少 API Key（Authorization: Bearer sk-...）", "authentication_error");
  const db = getDb();
  const rows = await db
    .select({ key: apiKeys, user: users })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .where(eq(apiKeys.keyHash, sha256(token)))
    .limit(1);
  const row = rows[0];
  if (!row || !row.key.active) return jsonError(401, "API Key 无效或已停用", "authentication_error");
  if (row.key.expiresAt && row.key.expiresAt.getTime() <= Date.now())
    return jsonError(401, "API Key 已过期", "authentication_error");
  if (row.user.banned) return jsonError(403, "账号已被封禁", "authentication_error");
  try { assertModuleAvailable(db, "api", row.user.id); }
  catch (error) { return jsonError(403, error instanceof Error ? error.message : "API 调用不可用", "policy_error"); }
  const policy = readUserPolicy(db, row.user.id);
  if (policy.apiDailySpendLimitUnits !== null) {
    const day = currentBusinessDay(db);
    const spent = Number(db.select({ n: sql<number>`COALESCE(SUM(${usageLogs.cost}), 0)` }).from(usageLogs).where(and(
      eq(usageLogs.userId, row.user.id), eq(usageLogs.status, "ok"), gte(usageLogs.createdAt, day.startsAt), lt(usageLogs.createdAt, day.endsAt),
    )).get()?.n ?? 0);
    if (spent * 1_000_000 >= policy.apiDailySpendLimitUnits)
      return jsonError(429, "已达到管理员设置的 API 每日消费上限", "policy_error");
  }
  const cleanup = db.transaction((tx) => expireUserCreditGrants(tx, row.user.id));
  row.user.balance = cleanup.balanceAfter;
  if (Number(row.user.balance) <= 0) return jsonError(402, "余额不足，请先抽奖或联系管理员充值", "billing_error");
  if (row.key.quota !== null && Number(row.key.quota) <= 0)
    return jsonError(402, "该密钥的独立额度已用完，请到控制台调整或改用不限额密钥", "billing_error");

  let group: Group;
  if (row.key.groupId) {
    group = (await db.select().from(groups).where(eq(groups.id, row.key.groupId)).limit(1))[0] ?? (await defaultGroup());
  } else {
    group = await defaultGroup();
  }
  if (isApiGroupFrozen(policy, group.id)) return jsonError(403, `你的 API 分组「${group.name}」权限已被冻结`, "policy_error");
  return { user: row.user, key: row.key, group };
}

/** 模型 + 关联上游渠道；渠道停用等同模型不可用；旧数据用内联地址/密钥兜底 */
async function findModel(name: string): Promise<RoutedModel | null> {
  const rows = await getDb()
    .select({ m: models, u: upstreams })
    .from(models)
    .leftJoin(upstreams, eq(models.upstreamId, upstreams.id))
    .where(and(eq(models.name, name), eq(models.enabled, true)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const { m, u } = row;
  if (u && !u.enabled) return null;
  return {
    ...m,
    upstreamBaseUrl: u?.baseUrl ?? m.upstreamBaseUrl,
    upstreamKey: u?.apiKey ?? m.upstreamKey,
    upstreamTimeoutMs: u?.timeoutMs ?? 60000,
  };
}

function modelAllowsGroup(model: Model, groupName: string): boolean {
  if (!model.allowedGroups.trim()) return true; // 空 = 全部分组可用
  return model.allowedGroups.split(",").map((s) => s.trim()).includes(groupName);
}

/** 四档计费 × 分组倍率：留空（null）的档位不计费；缓存命中部分按缓存读价单独计费 */
function calcCost(model: Model, group: Group, usage: Usage) {
  const pIn = model.priceInput === null ? null : Number(model.priceInput);
  const pOut = model.priceOutput === null ? null : Number(model.priceOutput);
  const pCW = model.priceCacheWrite === null ? null : Number(model.priceCacheWrite);
  const pCR = model.priceCacheRead === null ? null : Number(model.priceCacheRead);

  const cacheRead = Math.min(usage.cacheReadTokens, usage.promptTokens);
  const normalInput = usage.promptTokens - cacheRead;
  const multiplier = Number(group.multiplier);
  const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
  const inputCost = round((pIn === null ? 0 : (normalInput / 1_000_000) * pIn) * multiplier);
  const outputCost = round((pOut === null ? 0 : (usage.completionTokens / 1_000_000) * pOut) * multiplier);
  const cacheWriteCost = round((pCW === null ? 0 : (usage.cacheWriteTokens / 1_000_000) * pCW) * multiplier);
  const cacheReadCost = round((pCR === null ? 0 : (cacheRead / 1_000_000) * pCR) * multiplier);
  return {
    inputCost,
    outputCost,
    cacheWriteCost,
    cacheReadCost,
    total: round(inputCost + outputCost + cacheWriteCost + cacheReadCost),
    multiplier,
  };
}

function estimateUsage(bodyText: string, resultText: string): Usage {
  return {
    promptTokens: Math.ceil(bodyText.length / 4),
    completionTokens: Math.ceil(resultText.length / 4),
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
}

/** 调用前预估费用下限：余额不足直接拒绝，防止大额调用透支 */
function precheckBalance(model: Model, group: Group, body: Record<string, unknown>, bodyText: string, balance: number): string | null {
  const mult = Number(group.multiplier);
  const pIn = model.priceInput === null ? 0 : Number(model.priceInput);
  const pOut = model.priceOutput === null ? 0 : Number(model.priceOutput);
  const estPrompt = Math.ceil(bodyText.length / 4);
  const maxOut =
    (typeof body.max_tokens === "number" ? body.max_tokens : 0) ||
    (typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : 0) ||
    (typeof body.max_output_tokens === "number" ? body.max_output_tokens : 0) ||
    (typeof (body.generationConfig as Record<string, unknown> | undefined)?.maxOutputTokens === "number"
      ? ((body.generationConfig as Record<string, unknown>).maxOutputTokens as number)
      : 0) || 0;
  const estimated = ((estPrompt / 1_000_000) * pIn + (maxOut / 1_000_000) * pOut) * mult;
  const required = Math.max(0.1, estimated);
  if (balance < required) {
    return `余额不足：本次调用预估需要 $${required.toFixed(2)}，当前余额 $${balance.toFixed(2)}`;
  }
  return null;
}

async function logUsage(
  model: RoutedModel,
  caller: Caller,
  detected: DetectedUsage,
  meta: LogMeta,
) {
  const usage = detected.usage;
  const calculated = calcCost(model, caller.group, usage);
  const intendedCost = meta.status === "ok" ? calculated.total : 0;
  const db = getDb();
  db.transaction((tx) => {
    const currentUser = tx.select({ balance: users.balance }).from(users).where(eq(users.id, caller.user.id)).limit(1).get();
    const currentKey = tx.select({ quota: apiKeys.quota }).from(apiKeys).where(eq(apiKeys.id, caller.key.id)).limit(1).get();
    if (!currentUser || !currentKey) throw new Error("gateway caller disappeared before usage settlement");
    const available = Math.max(0, Number(currentUser.balance));
    const quotaAvailable = currentKey.quota === null ? Number.POSITIVE_INFINITY : Math.max(0, Number(currentKey.quota));
    const cost = Math.round(Math.min(intendedCost, available, quotaAvailable) * 1_000_000) / 1_000_000;
    const ratio = calculated.total > 0 ? cost / calculated.total : 0;
    const scaledCosts = [calculated.inputCost, calculated.outputCost, calculated.cacheWriteCost, calculated.cacheReadCost]
      .map((value) => Math.round(value * ratio * 1_000_000) / 1_000_000);
    const scaledTotal = Math.round(scaledCosts.reduce((sum, value) => sum + value, 0) * 1_000_000) / 1_000_000;
    if (scaledTotal !== cost) {
      const lastCharged = [...scaledCosts].map((value, index) => ({ value, index })).reverse().find((entry) => entry.value > 0)?.index ?? 0;
      scaledCosts[lastCharged] = Math.round((scaledCosts[lastCharged] + cost - scaledTotal) * 1_000_000) / 1_000_000;
    }
    if (cost > 0) {
      debitUserBalance(tx, { userId: caller.user.id, amount: cost, sourceKind: "usage", requestId: meta.requestId, note: `${model.name} API 调用` });
      if (currentKey.quota !== null) {
        tx.update(apiKeys).set({ quota: sql`${apiKeys.quota} - ${cost}` }).where(eq(apiKeys.id, caller.key.id)).run();
      }
      recordTx(tx, caller.user.id, "usage", -cost, `${model.name} 调用（${usage.promptTokens + usage.completionTokens} tokens）`);
    }
    tx.insert(usageLogs).values({
    userId: caller.user.id,
    apiKeyId: caller.key.id,
    apiKeyName: caller.key.name,
    apiKeyPrefix: caller.key.prefix,
    requestId: meta.requestId,
    model: model.name,
    protocol: meta.protocol,
    upstreamId: model.upstreamId,
    endpoint: meta.endpoint,
    requestBody: bodyForLog(meta.requestBody),
    responseBody: bodyForLog(meta.responseBody),
    httpStatus: meta.httpStatus,
    upstreamRequestId: meta.upstreamRequestId,
    errorMessage: meta.errorMessage.slice(0, 2048),
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cacheReadTokens: usage.cacheReadTokens,
    usageSource: detected.source,
    cacheStatus: detected.cacheStatus,
    inputCost: meta.status === "ok" ? scaledCosts[0] : 0,
    outputCost: meta.status === "ok" ? scaledCosts[1] : 0,
    cacheWriteCost: meta.status === "ok" ? scaledCosts[2] : 0,
    cacheReadCost: meta.status === "ok" ? scaledCosts[3] : 0,
    groupMultiplier: calculated.multiplier,
    cost,
    durationMs: meta.durationMs,
    ttftMs: meta.ttftMs,
    stream: meta.stream,
    status: meta.status,
    }).run();
    tx.update(apiKeys).set({ lastUsedAt: new Date(), lastUsedIp: meta.clientIp || null }).where(eq(apiKeys.id, caller.key.id)).run();
  });
}

/** 从 JSON 响应体中提取 usage（按协议解析，含缓存明细） */
export function extractUsageFromJson(data: unknown, protocol: Protocol): DetectedUsage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);

  if (protocol === "gemini") {
    const u = d.usageMetadata as Record<string, unknown> | undefined;
    if (!u) return null;
    const usage = {
      promptTokens: num(u.promptTokenCount),
      completionTokens: num(u.candidatesTokenCount) + num(u.thoughtsTokenCount),
      cacheWriteTokens: 0,
      cacheReadTokens: num(u.cachedContentTokenCount),
    };
    return {
      usage,
      source: "upstream",
      cacheStatus: cacheStatus(usage, Object.hasOwn(u, "cachedContentTokenCount")),
    };
  }

  if (protocol === "claude") {
    const u = d.usage as Record<string, unknown> | undefined;
    if (!u) return null;
    const cacheRead = num(u.cache_read_input_tokens);
    // Claude 的 input_tokens 不含缓存部分；归一为「含缓存读、不含缓存写」的总输入
    const usage = {
      promptTokens: num(u.input_tokens) + cacheRead,
      completionTokens: num(u.output_tokens),
      cacheWriteTokens: num(u.cache_creation_input_tokens),
      cacheReadTokens: cacheRead,
    };
    const reported = Object.hasOwn(u, "cache_read_input_tokens") || Object.hasOwn(u, "cache_creation_input_tokens");
    return { usage, source: "upstream", cacheStatus: cacheStatus(usage, reported) };
  }

  // chat / responses：usage 在顶层或 response.usage
  const u = (d.usage ?? (d.response as Record<string, unknown> | undefined)?.usage) as
    | Record<string, unknown>
    | undefined;
  if (!u) return null;
  const prompt = num(u.prompt_tokens) || num(u.input_tokens);
  const completion = num(u.completion_tokens) || num(u.output_tokens);
  const promptDetails = (u.prompt_tokens_details ?? u.input_tokens_details ?? {}) as Record<string, unknown>;
  const cacheRead =
    num(promptDetails.cached_tokens) || num(u.cache_read_input_tokens) || num(promptDetails.cached_read_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens) || num(promptDetails.cache_creation_tokens);
  const usage = { promptTokens: prompt, completionTokens: completion, cacheWriteTokens: cacheWrite, cacheReadTokens: cacheRead };
  const reported = Object.hasOwn(promptDetails, "cached_tokens") ||
    Object.hasOwn(promptDetails, "cached_read_tokens") ||
    Object.hasOwn(promptDetails, "cache_creation_tokens") ||
    Object.hasOwn(u, "cache_read_input_tokens") ||
    Object.hasOwn(u, "cache_creation_input_tokens");
  return { usage, source: "upstream", cacheStatus: cacheStatus(usage, reported) };
}

/** 流式转发：边转发边扫描 usage，同时记录首字耗时，结束后结算 */
function streamProxy(
  upstream: ReadableStream<Uint8Array>,
  startedAt: number,
  onFirst: (ttftMs: number) => void,
  onDone: (acc: string, durationMs: number) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let acc = "";
  let first = false;
  const ts = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!first) {
        first = true;
        onFirst(Date.now() - startedAt);
      }
      acc += decoder.decode(chunk, { stream: true });
      controller.enqueue(chunk);
    },
    flush() {
      onDone(acc, Date.now() - startedAt);
    },
  });
  return upstream.pipeThrough(ts);
}

/** 从 SSE 流文本中提取 usage（按协议解析） */
function extractUsageFromStream(text: string, protocol: Protocol): DetectedUsage | null {
  if (protocol === "claude") {
    // Claude SSE：message_start 带输入侧 usage，message_delta 带累计 output_tokens
    let input = 0, cacheW = 0, cacheR = 0, output = 0, found = false, cacheReported = false;
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const d = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        const u = d.type === "message_start"
          ? ((d.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined)
          : d.type === "message_delta"
            ? (d.usage as Record<string, unknown> | undefined)
            : undefined;
        if (!u) continue;
        const num = (v: unknown) => (typeof v === "number" ? v : 0);
        if (d.type === "message_start") {
          input = num(u.input_tokens); cacheW = num(u.cache_creation_input_tokens); cacheR = num(u.cache_read_input_tokens);
          cacheReported = Object.hasOwn(u, "cache_read_input_tokens") || Object.hasOwn(u, "cache_creation_input_tokens");
          found = true;
        } else {
          output = num(u.output_tokens) || output;
        }
      } catch { /* 忽略非 JSON 行 */ }
    }
    if (!found) return null;
    const usage = { promptTokens: input + cacheR, completionTokens: output, cacheWriteTokens: cacheW, cacheReadTokens: cacheR };
    return { usage, source: "upstream", cacheStatus: cacheStatus(usage, cacheReported) };
  }

  // chat / responses / gemini：取最后一次出现的有效 usage
  let usage: DetectedUsage | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const data = JSON.parse(payload) as Record<string, unknown>;
      const found = extractUsageFromJson(data, protocol);
      if (found && (found.usage.promptTokens > 0 || found.usage.completionTokens > 0)) usage = found;
    } catch { /* 忽略非 JSON 行 */ }
  }
  return usage;
}

async function proxyToUpstream(
  model: RoutedModel,
  opts: { protocol: Protocol; upstreamUrl: string; bodyText: string; forceStream: boolean; request: Request },
  caller: Caller,
): Promise<Response> {
  const startedAt = Date.now();
  const { protocol, upstreamUrl, bodyText } = opts;
  const requestId = crypto.randomUUID();
  const endpoint = new URL(upstreamUrl).pathname;
  const sourceIp = clientIp(opts.request);
  const body = (bodyText.trim() ? JSON.parse(bodyText) : {}) as Record<string, unknown>;
  const policy = readUserPolicy(getDb(), caller.user.id);
  const concurrencyLimit = policy.apiConcurrencyLimit ?? 0;
  const currentActive = activeRequests.get(caller.user.id) ?? 0;
  if (concurrencyLimit > 0 && currentActive >= concurrencyLimit)
    return jsonError(429, `并发请求已达到管理员设置的 ${concurrencyLimit} 路上限`, "policy_error");
  // Gemini 的模型名在 URL 里，body 无 model 字段
  if (protocol !== "gemini") body.model = model.upstreamModel;
  const isStream = opts.forceStream || body.stream === true;

  // RPM 限流（按 Key 所属分组）
  if (!checkRateLimit(caller.key.id, caller.group.rpmLimit)) {
    return jsonError(429, `请求过于频繁：当前分组限流 ${caller.group.rpmLimit} 次/分钟`, "rate_limit_error");
  }
  // 透支保护：预估费用不足则拒绝
  const insufficient = precheckBalance(model, caller.group, body, bodyText, Number(caller.user.balance));
  if (insufficient) return jsonError(402, insufficient, "billing_error");
  activeRequests.set(caller.user.id, currentActive + 1);

  // 尽量让上游在流里返回 usage
  if (isStream && protocol === "chat") {
    body.stream_options = { ...(body.stream_options as object), include_usage: true };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${model.upstreamKey}`,
  };
  if (protocol === "gemini") headers["x-goog-api-key"] = model.upstreamKey;
  // Claude：兼容 Anthropic 原生鉴权（中转站忽略这两个头也无妨）
  if (protocol === "claude") {
    headers["x-api-key"] = model.upstreamKey;
    headers["anthropic-version"] = "2023-06-01";
  }

  let upstreamRes: globalThis.Response;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1000, Math.min(model.upstreamTimeoutMs, 300000))),
    });
  } catch (error) {
    activeRequests.set(caller.user.id, Math.max(0, (activeRequests.get(caller.user.id) ?? 1) - 1));
    const message = error instanceof Error ? error.message : "上游服务连接失败";
    logUsage(model, caller, estimatedUsage(bodyText, ""), {
      durationMs: Date.now() - startedAt, ttftMs: 0, stream: isStream, status: "error",
      requestId, protocol, endpoint, requestBody: bodyText, responseBody: "", httpStatus: 502,
      upstreamRequestId: "", errorMessage: message, clientIp: sourceIp,
    }).catch(() => {});
    const response = jsonError(502, "上游服务连接失败");
    response.headers.set("X-Lucky-Request-Id", requestId);
    return response;
  }

  if (!upstreamRes.ok) {
    activeRequests.set(caller.user.id, Math.max(0, (activeRequests.get(caller.user.id) ?? 1) - 1));
    const errText = await upstreamRes.text();
    const upstreamRequestId = upstreamRes.headers.get("x-request-id") ?? upstreamRes.headers.get("request-id") ?? "";
    logUsage(model, caller, estimatedUsage(bodyText, errText), {
      durationMs: Date.now() - startedAt, ttftMs: 0, stream: isStream, status: "error",
      requestId, protocol, endpoint, requestBody: bodyText, responseBody: errText, httpStatus: upstreamRes.status,
      upstreamRequestId, errorMessage: errText.slice(0, 2048), clientIp: sourceIp,
    }).catch(() => {});
    return new Response(errText, {
      status: upstreamRes.status,
      headers: {
        "Content-Type": upstreamRes.headers.get("content-type") ?? "application/json",
        "X-Lucky-Request-Id": requestId,
      },
    });
  }

  if (isStream && upstreamRes.body) {
    let ttft = 0;
    const stream = streamProxy(
      upstreamRes.body,
      startedAt,
      (t) => { ttft = t; },
      (acc, durationMs) => {
        activeRequests.set(caller.user.id, Math.max(0, (activeRequests.get(caller.user.id) ?? 1) - 1));
        const detected = extractUsageFromStream(acc, protocol) ?? estimatedUsage(bodyText, acc);
        logUsage(model, caller, detected, {
          durationMs, ttftMs: ttft, stream: true, status: "ok", requestId, protocol, endpoint,
          requestBody: bodyText, responseBody: acc, httpStatus: upstreamRes.status,
          upstreamRequestId: upstreamRes.headers.get("x-request-id") ?? upstreamRes.headers.get("request-id") ?? "",
          errorMessage: "", clientIp: sourceIp,
        }).catch(() => {});
      },
    );
    const resHeaders = new Headers();
    resHeaders.set("Content-Type", upstreamRes.headers.get("content-type") ?? "text/event-stream");
    resHeaders.set("Cache-Control", "no-cache");
    resHeaders.set("X-Lucky-Request-Id", requestId);
    return new Response(stream, { status: 200, headers: resHeaders });
  }

  const resText = await upstreamRes.text();
  activeRequests.set(caller.user.id, Math.max(0, (activeRequests.get(caller.user.id) ?? 1) - 1));
  const durationMs = Date.now() - startedAt;
  let detected: DetectedUsage | null = null;
  try {
    detected = extractUsageFromJson(JSON.parse(resText), protocol);
  } catch {
    /* 非 JSON 响应 */
  }
  logUsage(model, caller, detected ?? estimatedUsage(bodyText, resText), {
    durationMs, ttftMs: durationMs, stream: false, status: "ok",
    requestId, protocol, endpoint, requestBody: bodyText, responseBody: resText, httpStatus: upstreamRes.status,
    upstreamRequestId: upstreamRes.headers.get("x-request-id") ?? upstreamRes.headers.get("request-id") ?? "",
    errorMessage: "", clientIp: sourceIp,
  }).catch(() => {});
  return new Response(resText, {
    status: 200,
    headers: {
      "Content-Type": upstreamRes.headers.get("content-type") ?? "application/json",
      "X-Lucky-Request-Id": requestId,
    },
  });
}

gatewayApp.get("/v1/models", async (c) => {
  const caller = await resolveCaller(c.req.raw);
  if (caller instanceof Response) return caller;
  const list = await getDb()
    .select({ m: models, u: upstreams })
    .from(models)
    .leftJoin(upstreams, eq(models.upstreamId, upstreams.id))
    .where(eq(models.enabled, true));
  const visible = list.filter((r) => (!r.u || r.u.enabled) && modelAllowsGroup(r.m, caller.group.name)).map((r) => r.m);
  return c.json({
    object: "list",
    data: visible.map((m) => ({
      id: m.name,
      object: "model",
      created: Math.floor(m.createdAt.getTime() / 1000),
      owned_by: "lucky-draw",
    })),
  });
});

/**
 * 上游地址归一化：去掉尾部斜杠。
 * chat / responses / claude 协议：上游无论填「https://域名」还是「https://域名/v1」，
 * 最终都透传到 {域名}/v1/xxx（Anthropic 原生与各中转站一致，Claude 也是 /v1/messages）。
 */
function joinUpstream(baseUrl: string, path: string): string {
  let base = baseUrl.replace(/\/+$/, "");
  if (!/\/v1$/.test(base)) base += "/v1";
  return `${base}${path}`;
}

/** chat / responses / claude：模型名在 body.model，路径拼归一化后的上游地址 */
async function handleCompletion(rawReq: Request, protocol: Exclude<Protocol, "gemini">) {
  const caller = await resolveCaller(rawReq);
  if (caller instanceof Response) return caller;
  const bodyText = await rawReq.text();
  let requestedModel = "";
  try {
    requestedModel = String((JSON.parse(bodyText) as Record<string, unknown>).model ?? "");
  } catch {
    return jsonError(400, "请求体不是合法 JSON");
  }
  const model = await findModel(requestedModel);
  if (!model) return jsonError(404, `模型 ${requestedModel} 不存在或未启用`, "model_not_found");
  if (!modelAllowsGroup(model, caller.group.name))
    return jsonError(403, `你的分组「${caller.group.name}」无权使用模型 ${requestedModel}`, "permission_error");
  const path = protocol === "chat" ? "/chat/completions" : protocol === "responses" ? "/responses" : "/messages";
  return proxyToUpstream(model, {
    protocol,
    upstreamUrl: joinUpstream(model.upstreamBaseUrl, path),
    bodyText,
    forceStream: false,
    request: rawReq,
  }, caller);
}

/** Gemini：模型名在 URL 路径里（{model}:generateContent / :streamGenerateContent） */
async function handleGemini(rawReq: Request, modelAction: string, query: string) {
  const caller = await resolveCaller(rawReq);
  if (caller instanceof Response) return caller;
  const sep = modelAction.lastIndexOf(":");
  if (sep <= 0) return jsonError(400, "Gemini 路径格式应为 /v1beta/models/{model}:generateContent");
  const requestedModel = modelAction.slice(0, sep);
  const action = modelAction.slice(sep + 1);
  if (action !== "generateContent" && action !== "streamGenerateContent")
    return jsonError(400, `不支持的 Gemini 动作：${action}`);

  const model = await findModel(requestedModel);
  if (!model) return jsonError(404, `模型 ${requestedModel} 不存在或未启用`, "model_not_found");
  if (!modelAllowsGroup(model, caller.group.name))
    return jsonError(403, `你的分组「${caller.group.name}」无权使用模型 ${requestedModel}`, "permission_error");

  const bodyText = await rawReq.text();
  try {
    if (bodyText.trim()) JSON.parse(bodyText);
  } catch {
    return jsonError(400, "请求体不是合法 JSON");
  }

  // 上游 baseUrl 可能是 https://域名、.../v1 或 .../v1beta，统一归一后走 /v1beta/models/...；替换模型名为上游模型名
  const base = model.upstreamBaseUrl.replace(/\/+$/, "").replace(/\/v1(beta)?$/, "");
  const upstreamUrl = `${base}/v1beta/models/${model.upstreamModel}:${action}${query}`;
  return proxyToUpstream(model, {
    protocol: "gemini",
    upstreamUrl,
    bodyText,
    forceStream: action === "streamGenerateContent",
    request: rawReq,
  }, caller);
}

gatewayApp.post("/v1/chat/completions", (c) => handleCompletion(c.req.raw, "chat"));
gatewayApp.post("/v1/responses", (c) => handleCompletion(c.req.raw, "responses"));
gatewayApp.post("/v1/messages", (c) => handleCompletion(c.req.raw, "claude"));
gatewayApp.post("/v1beta/models/:modelAction", (c) =>
  handleGemini(c.req.raw, c.req.param("modelAction"), new URL(c.req.url).search),
);
