import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { memberQuery } from "../auth";
import { createRouter } from "../middleware";
import { getDb } from "../queries/connection";
import { readDisplayBadges } from "../queries/display-badges";
import { currentBusinessDay } from "../queries/entertainment-control";

const categories = ["overall", "api", "finance", "entertainment", "contracts"] as const;
const periods = ["today", "week", "month", "all"] as const;
type Category = typeof categories[number];
type Period = typeof periods[number];

type Board = {
  category: Category;
  key: string;
  title: string;
  description: string;
  unit: "money" | "sim" | "count" | "tokens" | "milliseconds" | "minutes" | "score";
  periods: Period[];
  table: string;
  userColumn: string;
  metric: string;
  dateColumn?: string;
  where?: string;
  having?: string;
  order?: "asc" | "desc";
  detail?: string;
  joins?: string;
};

const allPeriods: Period[] = ["today", "week", "month", "all"];
const realtime: Period[] = ["all"];
const boards: Board[] = [
  { category: "overall", key: "balance", title: "可用额度", description: "当前永久可用额度实时排名", unit: "money", periods: realtime, table: "users x", userColumn: "x.id", metric: "x.balance - COALESCE((SELECT SUM(c.remaining_units) / 1000000.0 FROM credit_grants c WHERE c.user_id = x.id AND c.status = 'active' AND c.remaining_units > 0 AND c.expires_at > (unixepoch() * 1000)), 0)" },
  { category: "overall", key: "activity", title: "累计活跃", description: "按已产生的真实业务记录数量排名", unit: "count", periods: allPeriods, table: "transactions x", userColumn: "x.user_id", metric: "COUNT(*)", dateColumn: "x.created_at" },
  { category: "overall", key: "participation", title: "综合参与度", description: "API、金融及娱乐已完成行为总数", unit: "score", periods: allPeriods, table: "transactions x", userColumn: "x.user_id", metric: "COUNT(DISTINCT x.kind) * 1000 + COUNT(*)", dateColumn: "x.created_at", detail: "COUNT(DISTINCT x.kind)" },

  { category: "api", key: "calls", title: "API 调用次数", description: "成功与失败调用总次数", unit: "count", periods: allPeriods, table: "usage_logs x", userColumn: "x.user_id", metric: "COUNT(*)", dateColumn: "x.created_at" },
  { category: "api", key: "spend", title: "API 消费金额", description: "成功调用产生的客户扣费", unit: "money", periods: allPeriods, table: "usage_logs x", userColumn: "x.user_id", metric: "SUM(x.cost)", dateColumn: "x.created_at", where: "x.status = 'ok'" },
  { category: "api", key: "tokens", title: "Token 用量", description: "输入、输出 Token 合计", unit: "tokens", periods: allPeriods, table: "usage_logs x", userColumn: "x.user_id", metric: "SUM(x.prompt_tokens + x.completion_tokens)", dateColumn: "x.created_at", where: "x.status = 'ok'" },
  { category: "api", key: "cache_tokens", title: "缓存 Token", description: "缓存写入与读取 Token 合计", unit: "tokens", periods: allPeriods, table: "usage_logs x", userColumn: "x.user_id", metric: "SUM(x.cache_write_tokens + x.cache_read_tokens)", dateColumn: "x.created_at", where: "x.status = 'ok'" },
  { category: "api", key: "low_latency", title: "低延迟表现", description: "至少 10 次成功调用后的平均响应耗时", unit: "milliseconds", periods: allPeriods, table: "usage_logs x", userColumn: "x.user_id", metric: "AVG(x.duration_ms)", dateColumn: "x.created_at", where: "x.status = 'ok'", having: "COUNT(*) >= 10", order: "asc", detail: "COUNT(*)" },

  { category: "finance", key: "transfer_sent", title: "转出金额", description: "已完成转账的到账金额", unit: "money", periods: allPeriods, table: "money_transfers x", userColumn: "x.sender_id", metric: "SUM(x.amount_units) / 1000000.0", dateColumn: "x.created_at", where: "x.status = 'completed'", detail: "COUNT(*)" },
  { category: "finance", key: "transfer_received", title: "收款金额", description: "已完成转账的收款金额", unit: "money", periods: allPeriods, table: "money_transfers x", userColumn: "x.recipient_id", metric: "SUM(x.amount_units) / 1000000.0", dateColumn: "x.created_at", where: "x.status = 'completed'", detail: "COUNT(*)" },
  { category: "finance", key: "borrowed", title: "借款本金", description: "已生效合同累计借款本金", unit: "money", periods: allPeriods, table: "peer_loans x", userColumn: "x.borrower_id", metric: "SUM(x.principal_units) / 1000000.0", dateColumn: "x.accepted_at", where: "x.accepted_at IS NOT NULL", detail: "COUNT(*)" },
  { category: "finance", key: "lent", title: "放贷本金", description: "已生效合同累计放贷本金", unit: "money", periods: allPeriods, table: "peer_loans x", userColumn: "x.lender_id", metric: "SUM(x.principal_units) / 1000000.0", dateColumn: "x.accepted_at", where: "x.accepted_at IS NOT NULL", detail: "COUNT(*)" },
  { category: "finance", key: "interest", title: "利息收入", description: "放贷方实际收到的税前利息", unit: "money", periods: allPeriods, table: "peer_loan_ledger x JOIN peer_loans l ON l.id = x.loan_id", userColumn: "l.lender_id", metric: "SUM(x.interest_units) / 1000000.0", dateColumn: "x.created_at", where: "x.interest_units > 0", detail: "COUNT(*)" },
  { category: "finance", key: "credit", title: "履约信用", description: "履约优先、违约更少者优先", unit: "score", periods: realtime, table: "peer_loans x", userColumn: "x.borrower_id", metric: "SUM(CASE WHEN x.status = 'fulfilled' THEN 1 ELSE 0 END) * 1000 - SUM(CASE WHEN x.defaulted_at IS NOT NULL THEN 1 ELSE 0 END)", where: "x.accepted_at IS NOT NULL", detail: "COUNT(*)" },

  { category: "entertainment", key: "signin_count", title: "签到次数", description: "完成每日签到的次数", unit: "count", periods: allPeriods, table: "daily_signins x", userColumn: "x.user_id", metric: "COUNT(*)", dateColumn: "x.created_at" },
  { category: "entertainment", key: "signin_streak", title: "连续签到", description: "历史最长连续签到天数", unit: "count", periods: realtime, table: "(SELECT user_id, COUNT(*) streak, MIN(created_at) created_at FROM (SELECT user_id, created_at, julianday(day) - ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY day) grp FROM daily_signins) GROUP BY user_id, grp) x", userColumn: "x.user_id", metric: "MAX(x.streak)", dateColumn: "x.created_at" },
  { category: "entertainment", key: "signin_reward", title: "签到奖励", description: "累计签到奖励金额", unit: "money", periods: allPeriods, table: "daily_signins x", userColumn: "x.user_id", metric: "SUM(x.reward_units) / 100.0", dateColumn: "x.created_at", detail: "COUNT(*)" },
  { category: "entertainment", key: "video_claims", title: "视频领取次数", description: "服务端验证并成功领取次数", unit: "count", periods: allPeriods, table: "video_reward_sessions x", userColumn: "x.user_id", metric: "COUNT(*)", dateColumn: "x.claimed_at", where: "x.status = 'claimed'" },
  { category: "entertainment", key: "video_watch", title: "视频观看时长", description: "服务端认可的累计观看分钟", unit: "minutes", periods: allPeriods, table: "video_reward_sessions x", userColumn: "x.user_id", metric: "SUM(x.watched_ms) / 60000.0", dateColumn: "x.claimed_at", where: "x.status = 'claimed'" },
  { category: "entertainment", key: "video_reward", title: "视频奖励", description: "成功领取的视频红包金额", unit: "money", periods: allPeriods, table: "video_reward_ledger x", userColumn: "x.user_id", metric: "SUM(x.amount_units) / 1000000.0", dateColumn: "x.created_at", detail: "COUNT(*)" },
  { category: "entertainment", key: "slot_net", title: "老虎机净收益", description: "已结算老虎机税后净变化", unit: "money", periods: allPeriods, table: "checkins x", userColumn: "x.user_id", metric: "SUM(x.delta)", dateColumn: "x.created_at", having: "SUM(x.delta) > 0", detail: "COUNT(*)" },
  { category: "entertainment", key: "slot_rounds", title: "老虎机局数", description: "完成的老虎机结算局数", unit: "count", periods: allPeriods, table: "checkins x", userColumn: "x.user_id", metric: "COUNT(*)", dateColumn: "x.created_at" },
  { category: "entertainment", key: "slot_wins", title: "老虎机胜场", description: "净收益大于零的结算局数", unit: "count", periods: allPeriods, table: "checkins x", userColumn: "x.user_id", metric: "COUNT(*)", dateColumn: "x.created_at", where: "x.delta > 0" },
  { category: "entertainment", key: "duel_wins", title: "决斗赢家", description: "决斗税后净收益", unit: "money", periods: allPeriods, table: "duel_round_results x", userColumn: "x.user_id", metric: "SUM(x.settled_net_units) / 1000000.0", dateColumn: "x.settled_at", where: "x.result = 'win'", detail: "COUNT(*)" },
  { category: "entertainment", key: "duel_losses", title: "决斗逆风", description: "决斗已结算净亏损", unit: "money", periods: allPeriods, table: "duel_round_results x", userColumn: "x.user_id", metric: "SUM(-x.settled_net_units) / 1000000.0", dateColumn: "x.settled_at", where: "x.result = 'loss'", detail: "COUNT(*)" },

  // Perp order PnL and fees are stored in milli-USDT, separate from account balances.
  {
    category: "contracts", key: "liquidation_loss", title: "爆仓亏损榜", description: "累计每笔爆仓实际亏损（含手续费）",
    unit: "sim", periods: allPeriods, table: "perp_orders x", userColumn: "x.user_id", dateColumn: "x.created_at",
    metric: "SUM(MAX(0, x.fee_units - x.pnl_units)) / 1000.0", where: "x.action = 'liquidate'", having: "metric > 0",
  },
  {
    category: "contracts", key: "closed_profit", title: "平仓盈利榜", description: "累计主动平仓净盈利（扣除手续费，盈亏相抵）",
    unit: "sim", periods: allPeriods, table: "perp_orders x", userColumn: "x.user_id", dateColumn: "x.created_at",
    metric: "SUM(x.pnl_units - x.fee_units) / 1000.0", where: "x.action = 'close'", having: "metric > 0",
  },
];

function bounds(period: Period) {
  if (period === "all") return null;
  const db = getDb();
  const day = currentBusinessDay(db);
  if (period === "today") return { start: day.startsAt.getTime(), end: day.endsAt.getTime() };
  const now = Date.now();
  if (period === "week") return { start: day.startsAt.getTime() - 6 * 86_400_000, end: day.endsAt.getTime() };
  const offset = day.timezoneOffsetMinutes * 60_000;
  const local = new Date(now + offset);
  const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1, day.startHour) - offset;
  return { start, end: day.endsAt.getTime() };
}

const queryInput = z.object({
  category: z.enum(categories), board: z.string().min(1).max(64), period: z.enum(periods).default("week"),
  page: z.number().int().min(1).default(1), pageSize: z.number().int().min(5).max(50).default(20),
});

export const rankingsRouter = createRouter({
  catalog: memberQuery.query(() => ({
    categories: [
      { key: "overall" as const, label: "综合" }, { key: "api" as const, label: "API" },
      { key: "finance" as const, label: "金融" }, { key: "entertainment" as const, label: "娱乐" },
      { key: "contracts" as const, label: "合约" },
    ],
    boards: boards.map(({ table: _table, userColumn: _userColumn, metric: _metric, dateColumn: _dateColumn, where: _where, having: _having, order: _order, detail: _detail, joins: _joins, ...board }) => board),
  })),
  query: memberQuery.input(queryInput).query(({ input, ctx }) => {
    const board = boards.find((item) => item.category === input.category && item.key === input.board);
    if (!board) throw new TRPCError({ code: "NOT_FOUND", message: "榜单不存在" });
    const period = board.periods.includes(input.period) ? input.period : board.periods[0];
    const range = bounds(period);
    const conditions = ["u.group_name IS NOT NULL", "trim(u.group_name) != ''", "u.banned = 0", board.where].filter(Boolean) as string[];
    const params: number[] = [];
    if (range && board.dateColumn) {
      conditions.push(`${board.dateColumn} >= ? AND ${board.dateColumn} < ?`);
      params.push(range.start, range.end);
    }
    const detail = board.detail ?? "COUNT(*)";
    const direction = board.order ?? "desc";
    const rankedSql = `
      WITH aggregated AS (
        SELECT ${board.userColumn} user_id, MAX(u.group_name) display_name, MAX(u.avatar_url) avatar_url,
          ${board.metric} metric, ${detail} detail, MIN(${board.dateColumn ?? "u.created_at"}) first_at
        FROM ${board.table} JOIN users u ON u.id = ${board.userColumn}
        WHERE ${conditions.join(" AND ")}
        GROUP BY ${board.userColumn}${board.having ? ` HAVING ${board.having}` : ""}
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (ORDER BY metric ${direction.toUpperCase()}, first_at ASC, user_id ASC) rank FROM aggregated
      ) SELECT * FROM ranked`;
    const db = getDb();
    const client = db.$client;
    const total = Number((client.prepare(`SELECT COUNT(*) total FROM (${rankedSql})`).get(...params) as { total: number }).total);
    const page = Math.min(input.page, Math.max(1, Math.ceil(total / input.pageSize)));
    const rows = client.prepare(`${rankedSql} ORDER BY rank LIMIT ? OFFSET ?`).all(...params, input.pageSize, (page - 1) * input.pageSize) as Array<{ user_id: number; display_name: string; avatar_url: string; metric: number; detail: number; rank: number }>;
    const mine = client.prepare(`${rankedSql} WHERE user_id = ?`).get(...params, ctx.user.id) as typeof rows[number] | undefined;
    const top = client.prepare(`${rankedSql} ORDER BY rank LIMIT 3`).all(...params) as typeof rows;
    const badgeFor = readDisplayBadges(db, [...rows, ...top, ...(mine ? [mine] : [])].map(row => row.user_id));
    const map = (row: typeof rows[number]) => ({ userId: row.user_id, badge: badgeFor(row.user_id), displayName: row.display_name, avatarUrl: row.avatar_url, metric: Number(row.metric), detail: Number(row.detail), rank: Number(row.rank) });
    return {
      board: { category: board.category, key: board.key, title: board.title, description: board.description, unit: board.unit, periods: board.periods },
      period, periodStart: range ? new Date(range.start) : null, periodEnd: range ? new Date(range.end) : null,
      rows: rows.map(map), podium: top.map(map), myRank: mine ? map(mine) : null,
      total, page, pageSize: input.pageSize, totalPages: Math.ceil(total / input.pageSize), updatedAt: new Date(),
    };
  }),
});
