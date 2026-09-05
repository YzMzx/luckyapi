import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// 用户（Linux.do OAuth 登录）
export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    linuxdoId: text("linuxdo_id").notNull(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull().default(""),
    avatarUrl: text("avatar_url").notNull().default(""),
    trustLevel: integer("trust_level").notNull().default(0),
    // 群内名称（注册时填写，作为公开身份且唯一）
    groupName: text("group_name"),
    // 余额（美元）
    balance: real("balance").notNull().default(0),
    totalWon: real("total_won").notNull().default(0),
    // 是否已中过奖（原子控制「每个号只能中一次」）
    hasWon: integer("has_won", { mode: "boolean" }).notNull().default(false),
    banned: integer("banned", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_linuxdo_id_idx").on(t.linuxdoId), uniqueIndex("users_group_name_idx").on(t.groupName)],
);

// OAuth 已授权但尚未完成必填注册资料的临时身份；不参与任何业务查询/统计。
export const pendingUsers = sqliteTable(
  "pending_users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    linuxdoId: text("linuxdo_id").notNull(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull().default(""),
    avatarUrl: text("avatar_url").notNull().default(""),
    trustLevel: integer("trust_level").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pending_users_linuxdo_id_idx").on(t.linuxdoId)],
);

export const pendingSessions = sqliteTable(
  "pending_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    token: text("token").notNull(),
    pendingUserId: integer("pending_user_id").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pending_sessions_token_idx").on(t.token),
    index("pending_sessions_user_idx").on(t.pendingUserId),
  ],
);

// 登录会话
export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    token: text("token").notNull(),
    userId: integer("user_id").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sessions_token_idx").on(t.token)],
);

// 单用户业务策略；null 数值表示继承全局规则，布尔冻结彼此独立。
export const userPolicies = sqliteTable("user_policies", {
  userId: integer("user_id").primaryKey(),
  // 一键冻结全部业务权限；登录、退出和历史只读查询不受影响。
  allFrozen: integer("all_frozen", { mode: "boolean" }).notNull().default(false),
  apiFrozen: integer("api_frozen", { mode: "boolean" }).notNull().default(false),
  // 仅冻结指定 API 分组；JSON 数组保存分组 ID，空数组表示不冻结具体分组。
  frozenApiGroupIds: text("frozen_api_group_ids").notNull().default("[]"),
  financeFrozen: integer("finance_frozen", { mode: "boolean" }).notNull().default(false),
  entertainmentFrozen: integer("entertainment_frozen", { mode: "boolean" }).notNull().default(false),
  apiDailySpendLimitUnits: integer("api_daily_spend_limit_units"),
  apiKeyLimit: integer("api_key_limit"),
  apiConcurrencyLimit: integer("api_concurrency_limit"),
  transferDailyLimitUnits: integer("transfer_daily_limit_units"),
  lendingDailyLimitUnits: integer("lending_daily_limit_units"),
  outstandingBorrowLimitUnits: integer("outstanding_borrow_limit_units"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

// 管理员会话
export const adminSessions = sqliteTable(
  "admin_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    token: text("token").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("admin_sessions_token_idx").on(t.token)],
);

// 邀请码 / 兑换码（统一码系统）
export const inviteCodes = sqliteTable(
  "invite_codes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    code: text("code").notNull(),
    // invite = 注册邀请码；redeem = 充值兑换码；report = 永久举报次数卡
    type: text("type", { enum: ["invite", "redeem", "report"] }).notNull().default("invite"),
    // 充值码为美元面额；举报卡为整数次数
    amount: real("amount"),
    // single = 全局仅一次；reusable = 多账号可用，但每个账号仅一次
    mode: text("mode", { enum: ["single", "reusable"] }).notNull().default("single"),
    // reusable 为 null 时不限总次数，否则达到次数后失效
    maxUses: integer("max_uses"),
    redemptionCount: integer("redemption_count").notNull().default(0),
    usedBy: integer("used_by"),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    // 兑换时账户余额必须严格低于该值；null 表示不设余额门槛。
    balanceBelow: real("balance_below"),
    // 兑换到账额度的绝对失效时间；null 表示永久额度。
    creditExpiresAt: integer("credit_expires_at", { mode: "timestamp_ms" }),
    // 一键清理采用归档而非物理删除，保留审计链路
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("invite_codes_code_idx").on(t.code)],
);

// 兑换审计：数据库唯一约束保证同一账号对同一码最多成功一次。
export const codeRedemptions = sqliteTable(
  "code_redemptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    codeId: integer("code_id").notNull(),
    code: text("code").notNull(),
    userId: integer("user_id").notNull(),
    amount: real("amount").notNull(),
    balanceBefore: real("balance_before"),
    balanceBelow: real("balance_below"),
    creditExpiresAt: integer("credit_expires_at", { mode: "timestamp_ms" }),
    redeemedAt: integer("redeemed_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("code_redemptions_code_user_unique").on(t.codeId, t.userId),
    index("code_redemptions_code_idx").on(t.codeId),
    index("code_redemptions_user_idx").on(t.userId),
  ],
);

// 用户永久举报卡次数。每日免费次数耗尽后才会原子消耗这里的次数。
export const reportCardBalances = sqliteTable("report_card_balances", {
  userId: integer("user_id").primaryKey(),
  grantedCount: integer("granted_count").notNull().default(0),
  consumedCount: integer("consumed_count").notNull().default(0),
  remainingCount: integer("remaining_count").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

export const reportCardLedger = sqliteTable(
  "report_card_ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    type: text("type", { enum: ["redeem", "consume"] }).notNull(),
    amount: integer("amount").notNull(),
    remainingAfter: integer("remaining_after").notNull(),
    redemptionId: integer("redemption_id"),
    reportRequestId: text("report_request_id"),
    note: text("note").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [
    index("report_card_ledger_user_idx").on(t.userId, t.id),
    uniqueIndex("report_card_ledger_redemption_unique").on(t.redemptionId),
    uniqueIndex("report_card_ledger_request_unique").on(t.reportRequestId),
  ],
);

// 限时额度桶：所有余额下降优先按 expires_at、id 消耗这些桶。
export const creditGrants = sqliteTable("credit_grants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  redemptionId: integer("redemption_id").notNull(),
  codeId: integer("code_id").notNull(),
  code: text("code").notNull(),
  userId: integer("user_id").notNull(),
  originalUnits: integer("original_units").notNull(),
  consumedUnits: integer("consumed_units").notNull().default(0),
  remainingUnits: integer("remaining_units").notNull(),
  expiredUnits: integer("expired_units").notNull().default(0),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  status: text("status", { enum: ["active", "exhausted", "expired"] }).notNull().default("active"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  exhaustedAt: integer("exhausted_at", { mode: "timestamp_ms" }),
  expiredAt: integer("expired_at", { mode: "timestamp_ms" }),
}, (t) => [
  uniqueIndex("credit_grants_redemption_unique").on(t.redemptionId),
  index("credit_grants_user_expiry_idx").on(t.userId, t.status, t.expiresAt, t.id),
  index("credit_grants_expiry_idx").on(t.status, t.expiresAt, t.id),
]);

export const creditGrantLedger = sqliteTable("credit_grant_ledger", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  grantId: integer("grant_id").notNull(),
  userId: integer("user_id").notNull(),
  type: text("type", { enum: ["grant", "consume", "restore", "expire"] }).notNull(),
  amountUnits: integer("amount_units").notNull(),
  remainingAfterUnits: integer("remaining_after_units").notNull(),
  sourceKind: text("source_kind").notNull().default(""),
  requestId: text("request_id"),
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
}, (t) => [
  index("credit_grant_ledger_grant_idx").on(t.grantId, t.id),
  index("credit_grant_ledger_user_idx").on(t.userId, t.id),
]);

// 一次性抽奖：正式账号全局一次；IP 只做审计，避免共享网络误伤。
export const draws = sqliteTable(
  "draws",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestId: text("request_id"),
    ip: text("ip").notNull(),
    userId: integer("user_id"),
    won: integer("won", { mode: "boolean" }).notNull().default(false),
    amount: real("amount"),
    configSnapshot: text("config_snapshot").notNull().default(""),
    fundBeforeUnits: integer("fund_before_units"),
    fundAfterUnits: integer("fund_after_units"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("draws_request_unique").on(t.requestId),
    uniqueIndex("draws_user_unique").on(t.userId),
    index("draws_ip_idx").on(t.ip),
  ],
);

export const drawFund = sqliteTable("draw_fund", {
  id: integer("id").primaryKey(),
  balanceUnits: integer("balance_units").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

// 每日签到与老虎机独立；按上海业务日每账号一次，奖励以美分整数结算。
export const dailySignins = sqliteTable(
  "daily_signins",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestId: text("request_id").notNull(),
    userId: integer("user_id").notNull(),
    day: text("day").notNull(),
    rewardUnits: integer("reward_units").notNull(),
    configSnapshot: text("config_snapshot").notNull(),
    fundBeforeUnits: integer("fund_before_units").notNull(),
    fundAfterUnits: integer("fund_after_units").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("daily_signins_request_unique").on(t.requestId),
    uniqueIndex("daily_signins_user_day_unique").on(t.userId, t.day),
    index("daily_signins_day_idx").on(t.day, t.createdAt),
  ],
);

export const signinFund = sqliteTable("signin_fund", {
  id: integer("id").primaryKey(),
  balanceUnits: integer("balance_units").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

// 每日看视频领红包：同一正式用户/业务日只允许一个服务端观看会话。
export const videoRewardSessions = sqliteTable(
  "video_reward_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionToken: text("session_token").notNull(),
    startRequestId: text("start_request_id").notNull(),
    claimRequestId: text("claim_request_id"),
    userId: integer("user_id").notNull(),
    businessDay: text("business_day").notNull(),
    videoResource: text("video_resource").notNull(),
    configSnapshot: text("config_snapshot").notNull(),
    status: text("status", { enum: ["active", "ready", "claimed", "expired"] }).notNull().default("active"),
    watchedMs: integer("watched_ms").notNull().default(0),
    lastSequence: integer("last_sequence").notNull().default(0),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    lastHeartbeatAt: integer("last_heartbeat_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    rewardUnits: integer("reward_units"),
    dailySpentBeforeUnits: integer("daily_spent_before_units"),
    dailySpentAfterUnits: integer("daily_spent_after_units"),
    fundBeforeUnits: integer("fund_before_units"),
    fundAfterUnits: integer("fund_after_units"),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("video_reward_sessions_token_unique").on(t.sessionToken),
    uniqueIndex("video_reward_sessions_start_request_unique").on(t.startRequestId),
    uniqueIndex("video_reward_sessions_claim_request_unique").on(t.claimRequestId),
    index("video_reward_sessions_user_day_idx").on(t.userId, t.businessDay),
    index("video_reward_sessions_day_idx").on(t.businessDay, t.startedAt),
    index("video_reward_sessions_status_idx").on(t.status, t.updatedAt),
  ],
);

export const videoRewardFund = sqliteTable("video_reward_fund", {
  id: integer("id").primaryKey(),
  balanceUnits: integer("balance_units").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

// 领取成功的追加式审计流水；与通用余额流水一一对应。
export const videoRewardLedger = sqliteTable(
  "video_reward_ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id").notNull(),
    requestId: text("request_id").notNull(),
    userId: integer("user_id").notNull(),
    businessDay: text("business_day").notNull(),
    amountUnits: integer("amount_units").notNull(),
    userBalanceAfter: real("user_balance_after").notNull(),
    dailySpentBeforeUnits: integer("daily_spent_before_units").notNull(),
    dailySpentAfterUnits: integer("daily_spent_after_units").notNull(),
    fundBeforeUnits: integer("fund_before_units"),
    fundAfterUnits: integer("fund_after_units"),
    note: text("note").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("video_reward_ledger_session_unique").on(t.sessionId),
    uniqueIndex("video_reward_ledger_request_unique").on(t.requestId),
    index("video_reward_ledger_day_idx").on(t.businessDay, t.createdAt),
    index("video_reward_ledger_user_idx").on(t.userId, t.createdAt),
  ],
);

export const announcements = sqliteTable(
  "announcements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    status: text("status", { enum: ["draft", "published", "withdrawn"] }).notNull().default("draft"),
    severity: text("severity", { enum: ["info", "important", "urgent"] }).notNull().default("info"),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    endsAt: integer("ends_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [index("announcements_public_idx").on(t.status, t.pinned, t.sortOrder, t.publishedAt)],
);

// 用户 API Key（存哈希，只展示一次）
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    name: text("name").notNull().default("默认 Key"),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    // 所属分组（null = 默认分组）
    groupId: integer("group_id"),
    // 密钥独立额度（美元，剩余量；null = 不限，共用账户余额）
    quota: real("quota"),
    // 可选过期时间；null = 永不过期
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    lastUsedIp: text("last_used_ip"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("api_keys_hash_idx").on(t.keyHash), index("api_keys_user_idx").on(t.userId)],
);

// 分组（计费倍率）
export const groups = sqliteTable(
  "groups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    multiplier: real("multiplier").notNull().default(1),
    // 每 Key 每分钟请求上限，0 = 不限
    rpmLimit: integer("rpm_limit").notNull().default(0),
    description: text("description").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("groups_name_idx").on(t.name)],
);

// 上游渠道（New API 风格：地址+密钥配一次，多个模型共用）
export const upstreams = sqliteTable("upstreams", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKey: text("api_key").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  timeoutMs: integer("timeout_ms").notNull().default(60000),
  lastTestedAt: integer("last_tested_at", { mode: "timestamp_ms" }),
  lastTestOk: integer("last_test_ok", { mode: "boolean" }),
  lastTestLatencyMs: integer("last_test_latency_ms"),
  lastTestMessage: text("last_test_message").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

// 上游模型配置
export const models = sqliteTable("models", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // 对外暴露的模型名（用户调用时用）
  name: text("name").notNull(),
  // 所属上游渠道（null = 旧数据，用下面的内联地址/密钥兜底）
  upstreamId: integer("upstream_id"),
  upstreamBaseUrl: text("upstream_base_url").notNull().default(""),
  upstreamKey: text("upstream_key").notNull().default(""),
  // 上游实际模型名
  upstreamModel: text("upstream_model").notNull(),
  apiType: text("api_type", { enum: ["chat", "responses", "claude", "gemini"] }).notNull().default("chat"),
  // 美元 / 每百万 token；留空（null）= 该项不计费
  priceInput: real("price_input"),
  priceOutput: real("price_output"),
  priceCacheWrite: real("price_cache_write"),
  priceCacheRead: real("price_cache_read"),
  // 可用分组名，逗号分隔；空 = 所有分组可用
  allowedGroups: text("allowed_groups").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

// 额度流水（每笔余额变动一条记录，可审计）
export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    // draw=抽奖 checkin=签到 video_reward=看视频红包 report=举报 redeem=兑换 adjust=管理员调整 usage=调用扣费
    kind: text("kind", { enum: ["draw", "checkin", "video_reward", "report", "redeem", "credit_expire", "adjust", "usage", "duel", "team_battle", "permanent_debit", "transfer_out", "transfer_in", "loan_disbursement", "loan_due", "loan_repayment", "loan_offer_refund"] }).notNull(),
    // 有符号金额（收入为正，支出为负）
    amount: real("amount").notNull(),
    balanceAfter: real("balance_after").notNull(),
    note: text("note").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [index("tx_user_idx").on(t.userId, t.id)],
);

// 系统设置（后台可改：LINUX DO Connect、管理员账号密码）
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
});

// 调用用量日志
export const usageLogs = sqliteTable(
  "usage_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    apiKeyId: integer("api_key_id"),
    apiKeyName: text("api_key_name").notNull().default(""),
    apiKeyPrefix: text("api_key_prefix").notNull().default(""),
    requestId: text("request_id").notNull().default(""),
    model: text("model").notNull(),
    protocol: text("protocol").notNull().default("chat"),
    upstreamId: integer("upstream_id"),
    endpoint: text("endpoint").notNull().default(""),
    requestBody: text("request_body").notNull().default(""),
    responseBody: text("response_body").notNull().default(""),
    httpStatus: integer("http_status").notNull().default(200),
    upstreamRequestId: text("upstream_request_id").notNull().default(""),
    errorMessage: text("error_message").notNull().default(""),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    usageSource: text("usage_source").notNull().default("estimated"),
    cacheStatus: text("cache_status").notNull().default("unknown"),
    inputCost: real("input_cost").notNull().default(0),
    outputCost: real("output_cost").notNull().default(0),
    cacheWriteCost: real("cache_write_cost").notNull().default(0),
    cacheReadCost: real("cache_read_cost").notNull().default(0),
    groupMultiplier: real("group_multiplier").notNull().default(1),
    cost: real("cost").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    ttftMs: integer("ttft_ms").notNull().default(0),
    stream: integer("stream", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull().default("ok"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [index("usage_user_idx").on(t.userId)],
);

// 举报记录
export const reports = sqliteTable(
  "reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestId: text("request_id"),
    reporterId: integer("reporter_id").notNull(),
    targetId: integer("target_id").notNull(),
    // targeted = 指定举报；random = 随机举报
    kind: text("kind", { enum: ["targeted", "random"] }).notNull().default("targeted"),
    success: integer("success", { mode: "boolean" }).notNull().default(false),
    // 历史兼容：amount 始终等于当次获益方实际到账
    amount: real("amount").notNull().default(0),
    // 仅新结算写入；历史记录保持 null，不依据当前余额反推。
    reporterBalanceBefore: real("reporter_balance_before"),
    targetBalanceBefore: real("target_balance_before"),
    lowerBalance: real("lower_balance"),
    grossAmount: real("gross_amount").notNull().default(0),
    taxBasisPoints: integer("tax_basis_points").notNull().default(500),
    // 举报税（从获益方扣除，烧掉）
    tax: real("tax").notNull().default(0),
    creditedAmount: real("credited_amount").notNull().default(0),
    deductedAmount: real("deducted_amount").notNull().default(0),
    quotaSource: text("quota_source", { enum: ["daily", "card"] }).notNull().default("daily"),
    successBasisPoints: integer("success_basis_points").notNull().default(4000),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reports_request_id_unique").on(t.requestId),
    index("reports_reporter_idx").on(t.reporterId),
    index("reports_target_idx").on(t.targetId),
  ],
);

// 不可变老虎机配置版本；规则 JSON 使用整数概率、倍率基点和金额单位。
export const slotConfigs = sqliteTable(
  "slot_configs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    version: text("version").notNull(),
    name: text("name").notNull(),
    mode: text("mode", { enum: ["base", "promotion"] }).notNull().default("base"),
    status: text("status", { enum: ["draft", "published", "active", "retired"] }).notNull().default("draft"),
    rulesJson: text("rules_json").notNull(),
    minBetUnits: integer("min_bet_units").notNull(),
    maxBetUnits: integer("max_bet_units").notNull(),
    winRatePpm: integer("win_rate_ppm").notNull(),
    rtpPpm: integer("rtp_ppm").notNull(),
    maxMultiplierBasisPoints: integer("max_multiplier_basis_points").notNull(),
    maxNetLiabilityUnits: integer("max_net_liability_units").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    activatedAt: integer("activated_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("slot_configs_version_unique").on(t.version), index("slot_configs_status_idx").on(t.mode, t.status)],
);

// 奖金池单例。所有金额均为美分整数；dayNetUnits 为当日下注减赔付。
export const slotFund = sqliteTable("slot_fund", {
  id: integer("id").primaryKey(),
  balanceUnits: integer("balance_units").notNull(),
  reserveUnits: integer("reserve_units").notNull(),
  dailyLossLimitUnits: integer("daily_loss_limit_units").notNull(),
  day: text("day").notNull(),
  dayNetUnits: integer("day_net_units").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

export const slotPromotions = sqliteTable(
  "slot_promotions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    configId: integer("config_id").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["scheduled", "active", "stopped", "exhausted", "ended"] }).notNull().default("scheduled"),
    startsAt: integer("starts_at", { mode: "timestamp_ms" }).notNull(),
    endsAt: integer("ends_at", { mode: "timestamp_ms" }).notNull(),
    budgetUnits: integer("budget_units").notNull(),
    spentUnits: integer("spent_units").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    stoppedAt: integer("stopped_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("slot_promotions_status_idx").on(t.status, t.startsAt, t.endsAt)],
);

export const slotFundLedger = sqliteTable(
  "slot_fund_ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestId: text("request_id"),
    roundId: integer("round_id"),
    type: text("type", { enum: ["seed", "adjustment", "bet", "payout"] }).notNull(),
    amountUnits: integer("amount_units").notNull(),
    balanceAfterUnits: integer("balance_after_units").notNull(),
    note: text("note").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [index("slot_fund_ledger_request_idx").on(t.requestId), index("slot_fund_ledger_round_idx").on(t.roundId)],
);

// 每日老虎机（每个用户每天一条，有加有扣）
export const checkins = sqliteTable(
  "checkins",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestId: text("request_id"),
    userId: integer("user_id").notNull(),
    // 日期 YYYY-MM-DD（UTC）
    day: text("day").notNull(),
    // 正 = 签到奖励，负 = 倒扣
    delta: real("delta").notNull(),
    bet: real("bet").notNull().default(0),
    symbols: text("symbols").notNull().default(""),
    payoutMultiplier: real("payout_multiplier").notNull().default(0),
    grossPayout: real("gross_payout").notNull().default(0),
    configVersion: text("config_version").notNull().default("legacy"),
    configId: integer("config_id"),
    prizeTier: text("prize_tier").notNull().default("legacy"),
    rulesSnapshot: text("rules_snapshot").notNull().default(""),
    winRatePpm: integer("win_rate_ppm").notNull().default(0),
    rtpPpm: integer("rtp_ppm").notNull().default(0),
    fundBeforeUnits: integer("fund_before_units"),
    fundAfterUnits: integer("fund_after_units"),
    promotionId: integer("promotion_id"),
    promotionBudgetBeforeUnits: integer("promotion_budget_before_units"),
    promotionBudgetAfterUnits: integer("promotion_budget_after_units"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [
    index("checkins_user_day_idx").on(t.userId, t.day),
    uniqueIndex("checkins_request_id_unique").on(t.requestId),
  ],
);

// 幸运决斗场：配置采用不可变版本，房间在创建时快照配置版本与关键限制。
export const duelConfigs = sqliteTable(
  "duel_configs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    version: integer("version").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    diceEnabled: integer("dice_enabled", { mode: "boolean" }).notNull().default(true),
    blackjackEnabled: integer("blackjack_enabled", { mode: "boolean" }).notNull().default(true),
    winnerTaxBasisPoints: integer("winner_tax_basis_points").notNull().default(300),
    feeBasisPoints: integer("fee_basis_points").notNull().default(300),
    betOptionsJson: text("bet_options_json").notNull(),
    minPlayers: integer("min_players").notNull().default(2),
    maxPlayers: integer("max_players").notNull().default(6),
    roomTimeoutSeconds: integer("room_timeout_seconds").notNull().default(1800),
    actionTimeoutSeconds: integer("action_timeout_seconds").notNull().default(60),
    minBetUnits: integer("min_bet_units").notNull().default(100_000),
    maxBetUnits: integer("max_bet_units").notNull().default(5_000_000),
    betPrecision: integer("bet_precision").notNull().default(2),
    singleBetLimitUnits: integer("single_bet_limit_units").notNull().default(5_000_000),
    dailyStakeLimitUnits: integer("daily_stake_limit_units").notNull().default(50_000_000),
    dailyNetLossLimitUnits: integer("daily_net_loss_limit_units").notNull().default(20_000_000),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("duel_configs_version_unique").on(t.version), index("duel_configs_active_idx").on(t.active)],
);

export const duelRooms = sqliteTable(
  "duel_rooms",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    game: text("game", { enum: ["dice", "blackjack"] }).notNull(),
    visibility: text("visibility", { enum: ["public", "private"] }).notNull().default("public"),
    ownerId: integer("owner_id").notNull(),
    status: text("status", { enum: ["lobby", "active", "settled", "cancelled", "refunded"] }).notNull().default("lobby"),
    configId: integer("config_id").notNull(),
    configVersion: integer("config_version").notNull(),
    configSnapshotJson: text("config_snapshot_json").notNull(),
    betUnits: integer("bet_units").notNull(),
    minPlayers: integer("min_players").notNull(),
    maxPlayers: integer("max_players").notNull(),
    winnerTaxBasisPoints: integer("winner_tax_basis_points").notNull().default(300),
    feeBasisPoints: integer("fee_basis_points").notNull(),
    grossPrizePoolUnits: integer("gross_prize_pool_units").notNull().default(0),
    winnerTaxUnits: integer("winner_tax_units").notNull().default(0),
    netPrizePoolUnits: integer("net_prize_pool_units").notNull().default(0),
    potUnits: integer("pot_units").notNull().default(0),
    feeUnits: integer("fee_units").notNull().default(0),
    roundNo: integer("round_no").notNull().default(1),
    nonce: integer("nonce").notNull().default(0),
    seedHash: text("seed_hash").notNull().default(""),
    seedSecret: text("seed_secret"),
    seedReveal: text("seed_reveal"),
    stateJson: text("state_json").notNull().default("{}"),
    currentSeat: integer("current_seat"),
    actionDeadlineAt: integer("action_deadline_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    voidedAt: integer("voided_at", { mode: "timestamp_ms" }),
    voidReason: text("void_reason"),
  },
  (t) => [uniqueIndex("duel_rooms_code_unique").on(t.code), index("duel_rooms_status_idx").on(t.status, t.createdAt)],
);

export const duelPlayers = sqliteTable(
  "duel_players",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    roomId: text("room_id").notNull(),
    userId: integer("user_id").notNull(),
    gameType: text("game_type", { enum: ["dice", "blackjack"] }).notNull(),
    seat: integer("seat").notNull(),
    ready: integer("ready", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull().default("joined"),
    balanceBeforeUnits: integer("balance_before_units"),
    stakeUnits: integer("stake_units").notNull().default(0),
    payoutUnits: integer("payout_units").notNull().default(0),
    settledNetUnits: integer("settled_net_units").notNull().default(0),
    result: text("result").notNull().default("pending"),
    handJson: text("hand_json").notNull().default("[]"),
    handRankJson: text("hand_rank_json").notNull().default("{}"),
    score: integer("score"),
    joinedAt: integer("joined_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    settledAt: integer("settled_at", { mode: "timestamp_ms" }),
    voidedAt: integer("voided_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("duel_players_room_user_unique").on(t.roomId, t.userId),
    uniqueIndex("duel_players_room_seat_unique").on(t.roomId, t.seat),
    index("duel_players_user_idx").on(t.userId, t.joinedAt),
    index("duel_players_leaderboard_idx").on(t.result, t.gameType, t.settledAt),
  ],
);

// 房间可复用；每局结算快照独立保存，避免下一局准备时覆盖历史与排行榜数据。
export const duelRoundResults = sqliteTable(
  "duel_round_results",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    roomId: text("room_id").notNull(),
    roundNo: integer("round_no").notNull(),
    userId: integer("user_id").notNull(),
    gameType: text("game_type", { enum: ["dice", "blackjack"] }).notNull(),
    seat: integer("seat").notNull(),
    status: text("status").notNull(),
    result: text("result").notNull(),
    balanceBeforeUnits: integer("balance_before_units"),
    stakeUnits: integer("stake_units").notNull().default(0),
    payoutUnits: integer("payout_units").notNull().default(0),
    settledNetUnits: integer("settled_net_units").notNull().default(0),
    handJson: text("hand_json").notNull().default("[]"),
    handRankJson: text("hand_rank_json").notNull().default("{}"),
    score: integer("score"),
    betUnits: integer("bet_units").notNull(),
    potUnits: integer("pot_units").notNull(),
    winnerTaxBasisPoints: integer("winner_tax_basis_points").notNull(),
    grossPrizePoolUnits: integer("gross_prize_pool_units").notNull(),
    winnerTaxUnits: integer("winner_tax_units").notNull(),
    netPrizePoolUnits: integer("net_prize_pool_units").notNull(),
    seedHash: text("seed_hash").notNull(),
    seedReveal: text("seed_reveal"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    settledAt: integer("settled_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("duel_round_results_room_round_user_unique").on(t.roomId, t.roundNo, t.userId),
    index("duel_round_results_user_idx").on(t.userId, t.settledAt),
    index("duel_round_results_room_idx").on(t.roomId, t.roundNo),
    index("duel_round_results_leaderboard_idx").on(t.result, t.gameType, t.settledAt),
  ],
);

export const duelEvents = sqliteTable(
  "duel_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    roomId: text("room_id").notNull(),
    seq: integer("seq").notNull(),
    requestId: text("request_id"),
    userId: integer("user_id"),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("duel_events_room_seq_unique").on(t.roomId, t.seq),
    uniqueIndex("duel_events_request_unique").on(t.requestId),
    index("duel_events_room_idx").on(t.roomId, t.id),
  ],
);

export const duelFund = sqliteTable("duel_fund", {
  id: integer("id").primaryKey(),
  balanceUnits: integer("balance_units").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

export const duelLedger = sqliteTable(
  "duel_ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    roomId: text("room_id").notNull(),
    userId: integer("user_id"),
    requestId: text("request_id"),
    type: text("type").notNull(),
    amountUnits: integer("amount_units").notNull(),
    userBalanceAfterUnits: integer("user_balance_after_units"),
    fundBalanceAfterUnits: integer("fund_balance_after_units"),
    note: text("note").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (t) => [index("duel_ledger_room_idx").on(t.roomId, t.id), index("duel_ledger_user_idx").on(t.userId, t.id)],
);

// 战队对抗与原骰子/二十一点房完全隔离；所有押注均以 10^-6 美元整数单位托管。
export const teamBattleConfigs = sqliteTable("team_battle_configs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  version: integer("version").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  singleBetLimitUnits: integer("single_bet_limit_units").notNull().default(10_000_000),
  userBetLimitUnits: integer("user_bet_limit_units").notNull().default(50_000_000),
  roomBetLimitUnits: integer("room_bet_limit_units").notNull().default(500_000_000),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
}, (t) => [uniqueIndex("team_battle_configs_version_unique").on(t.version), index("team_battle_configs_active_idx").on(t.active)]);

export const teamBattleRooms = sqliteTable("team_battle_rooms", {
  id: text("id").primaryKey(),
  code: text("code").notNull(),
  mode: text("mode", { enum: ["1v1", "3v3", "5v5"] }).notNull(),
  visibility: text("visibility", { enum: ["public", "private"] }).notNull().default("public"),
  ownerId: integer("owner_id").notNull(),
  status: text("status", { enum: ["lobby", "betting", "voting", "settled", "disputed", "cancelled", "refunded"] }).notNull().default("lobby"),
  seatsPerTeam: integer("seats_per_team").notNull(),
  rosterLocked: integer("roster_locked", { mode: "boolean" }).notNull().default(false),
  configVersion: integer("config_version").notNull(),
  configSnapshotJson: text("config_snapshot_json").notNull(),
  voteRound: integer("vote_round").notNull().default(1),
  winnerTeam: text("winner_team", { enum: ["A", "B"] }),
  poolAUnits: integer("pool_a_units").notNull().default(0),
  poolBUnits: integer("pool_b_units").notNull().default(0),
  losingPoolTaxUnits: integer("losing_pool_tax_units").notNull().default(0),
  playerTaxUnits: integer("player_tax_units").notNull().default(0),
  platformTaxUnits: integer("platform_tax_units").notNull().default(0),
  payoutUnits: integer("payout_units").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  lockedAt: integer("locked_at", { mode: "timestamp_ms" }),
  bettingClosedAt: integer("betting_closed_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  disputeReason: text("dispute_reason"),
}, (t) => [uniqueIndex("team_battle_rooms_code_unique").on(t.code), index("team_battle_rooms_status_idx").on(t.status, t.createdAt)]);

export const teamBattlePlayers = sqliteTable("team_battle_players", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  roomId: text("room_id").notNull(),
  userId: integer("user_id").notNull(),
  team: text("team", { enum: ["A", "B"] }).notNull(),
  seat: integer("seat").notNull(),
  status: text("status", { enum: ["joined", "exited"] }).notNull().default("joined"),
  taxShareUnits: integer("tax_share_units").notNull().default(0),
  joinedAt: integer("joined_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  exitedAt: integer("exited_at", { mode: "timestamp_ms" }),
}, (t) => [
  uniqueIndex("team_battle_players_room_user_unique").on(t.roomId, t.userId),
  uniqueIndex("team_battle_players_room_team_seat_unique").on(t.roomId, t.team, t.seat),
  index("team_battle_players_user_idx").on(t.userId, t.joinedAt),
]);

export const teamBattleBets = sqliteTable("team_battle_bets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requestId: text("request_id").notNull(),
  roomId: text("room_id").notNull(),
  userId: integer("user_id").notNull(),
  team: text("team", { enum: ["A", "B"] }).notNull(),
  amountUnits: integer("amount_units").notNull(),
  poolABeforeUnits: integer("pool_a_before_units").notNull(),
  poolBBeforeUnits: integer("pool_b_before_units").notNull(),
  projectedReturnPpm: integer("projected_return_ppm"),
  status: text("status", { enum: ["escrowed", "won", "lost", "refunded"] }).notNull().default("escrowed"),
  payoutUnits: integer("payout_units").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  settledAt: integer("settled_at", { mode: "timestamp_ms" }),
}, (t) => [
  uniqueIndex("team_battle_bets_request_unique").on(t.requestId),
  index("team_battle_bets_room_idx").on(t.roomId, t.id),
  index("team_battle_bets_user_idx").on(t.userId, t.id),
]);

export const teamBattleVotes = sqliteTable("team_battle_votes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requestId: text("request_id").notNull(),
  roomId: text("room_id").notNull(),
  voteRound: integer("vote_round").notNull(),
  userId: integer("user_id").notNull(),
  winnerTeam: text("winner_team", { enum: ["A", "B"] }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("team_battle_votes_request_unique").on(t.requestId),
  uniqueIndex("team_battle_votes_room_round_user_unique").on(t.roomId, t.voteRound, t.userId),
  index("team_battle_votes_room_idx").on(t.roomId, t.voteRound),
]);

export const teamBattleEvents = sqliteTable("team_battle_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  roomId: text("room_id").notNull(),
  seq: integer("seq").notNull(),
  requestId: text("request_id"),
  userId: integer("user_id"),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("team_battle_events_room_seq_unique").on(t.roomId, t.seq),
  uniqueIndex("team_battle_events_request_unique").on(t.requestId),
  index("team_battle_events_room_idx").on(t.roomId, t.id),
]);

export const teamBattleFund = sqliteTable("team_battle_fund", {
  id: integer("id").primaryKey(),
  balanceUnits: integer("balance_units").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

export const teamBattleLedger = sqliteTable("team_battle_ledger", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  roomId: text("room_id").notNull(),
  userId: integer("user_id"),
  requestId: text("request_id"),
  type: text("type").notNull(),
  amountUnits: integer("amount_units").notNull(),
  userBalanceAfterUnits: integer("user_balance_after_units"),
  fundBalanceAfterUnits: integer("fund_balance_after_units"),
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
}, (t) => [index("team_battle_ledger_room_idx").on(t.roomId, t.id), index("team_battle_ledger_user_idx").on(t.userId, t.id)]);

// 玩家资金转移（收款人按 Linux.do 登录记录中的账号 ID 定位）
export const moneyTransfers = sqliteTable("money_transfers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requestId: text("request_id").notNull(),
  senderId: integer("sender_id").notNull(),
  recipientId: integer("recipient_id").notNull(),
  amountUnits: integer("amount_units").notNull(),
  feeUnits: integer("fee_units").notNull(),
  status: text("status", { enum: ["completed", "reversed"] }).notNull().default("completed"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("money_transfers_request_unique").on(t.requestId),
  index("money_transfers_sender_idx").on(t.senderId, t.id),
  index("money_transfers_recipient_idx").on(t.recipientId, t.id),
]);

// 民间借贷合同。利率使用基点，金额均为 6 位小数整数单位。
export const peerLoans = sqliteTable("peer_loans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requestId: text("request_id").notNull(),
  lenderId: integer("lender_id").notNull(),
  borrowerId: integer("borrower_id").notNull(),
  principalUnits: integer("principal_units").notNull(),
  monthlyRateBasisPoints: integer("monthly_rate_basis_points").notNull(),
  ruleSnapshotJson: text("rule_snapshot_json").notNull().default("{}"),
  status: text("status", { enum: ["pending", "active", "collecting", "fulfilled", "defaulted", "cancelled"] }).notNull().default("pending"),
  terminalReason: text("terminal_reason", { enum: ["rejected", "cancelled", "expired"] }),
  offeredAt: integer("offered_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  offerExpiresAt: integer("offer_expires_at", { mode: "timestamp_ms" }).notNull(),
  acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
  dueAt: integer("due_at", { mode: "timestamp_ms" }).notNull(),
  settledAt: integer("settled_at", { mode: "timestamp_ms" }),
  accruedInterestUnits: integer("accrued_interest_units").notNull().default(0),
  interestTaxUnits: integer("interest_tax_units").notNull().default(0),
  outstandingPrincipalUnits: integer("outstanding_principal_units").notNull().default(0),
  outstandingInterestUnits: integer("outstanding_interest_units").notNull().default(0),
  paidPrincipalUnits: integer("paid_principal_units").notNull().default(0),
  paidInterestUnits: integer("paid_interest_units").notNull().default(0),
  taxPaidUnits: integer("tax_paid_units").notNull().default(0),
  defaultedAt: integer("defaulted_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("peer_loans_request_unique").on(t.requestId),
  index("peer_loans_lender_idx").on(t.lenderId, t.id),
  index("peer_loans_borrower_idx").on(t.borrowerId, t.id),
  index("peer_loans_due_idx").on(t.status, t.dueAt),
]);

export const peerLoanLedger = sqliteTable("peer_loan_ledger", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  loanId: integer("loan_id").notNull(),
  requestId: text("request_id").notNull(),
  type: text("type").notNull(),
  amountUnits: integer("amount_units").notNull(),
  principalUnits: integer("principal_units").notNull().default(0),
  interestUnits: integer("interest_units").notNull().default(0),
  taxUnits: integer("tax_units").notNull().default(0),
  borrowerBalanceAfterUnits: integer("borrower_balance_after_units"),
  lenderBalanceAfterUnits: integer("lender_balance_after_units"),
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("peer_loan_ledger_request_unique").on(t.requestId),
  index("peer_loan_ledger_loan_idx").on(t.loanId, t.id),
]);

// 后台操作日志（谁改了什么，留痕可查）
export const adminLogs = sqliteTable("admin_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  action: text("action").notNull(),
  detail: text("detail").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type PendingUser = typeof pendingUsers.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Model = typeof models.$inferSelect;
export type UsageLog = typeof usageLogs.$inferSelect;
export type Draw = typeof draws.$inferSelect;
export type InviteCode = typeof inviteCodes.$inferSelect;
export type CodeRedemption = typeof codeRedemptions.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type Group = typeof groups.$inferSelect;
