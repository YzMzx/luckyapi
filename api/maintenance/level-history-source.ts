import type { Database } from "better-sqlite3";
import { applyPerpCashFlow } from "@contracts/perp-income";
import { unitsFromMoney } from "@contracts/finance";
import { DAILY_CHECKIN_EXP } from "@contracts/levels";

export type HistoryEvent = {
  userId: number;
  key: string;
  at: number;
  fixedExp?: number;
  usdUnits?: number;
  source?: "income" | "api_usage";
};

type LedgerRow = {
  id: number;
  user_id: number;
  kind: string;
  amount: number;
  balance_after: number;
  note: string;
  created_at: number;
};

function timestamp(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8.64e15)
    throw new Error("无效的事件时间");
  // Native columns store milliseconds. Some older exports contain unixepoch() seconds.
  return value >= 946684800 && value < 10_000_000_000 ? value * 1000 : value;
}
function signedUnits(amount: number) {
  return Math.sign(amount) * unitsFromMoney(Math.abs(amount));
}
function positiveId(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error("无效的记录或用户 ID");
  return id;
}
function validDay(day: string) {
  const date = new Date(day + "T00:00:00Z");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== day
  )
    throw new Error("无效的签到业务日");
  return day;
}

// Mixed payments have no foreign key from transactions. Match the account, amount,
// post-payment balance, business operation and recorded second. Reject ambiguity.
function mixedIncome(db: Database) {
  const statements = new Map<string, ReturnType<Database["prepare"]>>();
  const consumed = new Set<string>();
  function match(
    sql: string,
    ref: string,
    at: number,
    ...params: (string | number)[]
  ) {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    const rows = statement.all(params) as {
      id: number;
      created_at: number;
      net: number;
      valid: number;
    }[];
    // Do not match a different settlement just because it has the same rounded amount.
    const candidates = rows.filter(
      row =>
        Math.floor(timestamp(row.created_at) / 1000) === Math.floor(at / 1000)
    );
    if (candidates.length !== 1)
      throw new Error(
        "无法唯一关联结算明细（同秒候选 " + candidates.length + "）"
      );
    const row = candidates[0];
    if (row.valid !== 1 || !Number.isSafeInteger(row.net))
      throw new Error("结算明细金额不一致");
    const key = ref + ":" + row.id;
    if (consumed.has(key)) throw new Error("多个流水引用同一结算明细");
    consumed.add(key);
    return Math.max(0, row.net);
  }
  return (row: LedgerRow, units: number, at: number): number => {
    const { kind, user_id: user, note } = row;
    const after = signedUnits(row.balance_after);
    if (kind === "loan_repayment") {
      const loan = /^借贷 #(\d+) (提前还款|到期回收|后续回收)$/.exec(note);
      if (!loan) throw new Error("无法确认借贷合同及归还类型");
      const type = {
        提前还款: "early_repayment",
        到期回收: "due_collection",
        后续回收: "income_interception",
      }[loan[2]]!;
      return match(
        `SELECT d.id, d.created_at, d.interest_units - d.tax_units AS net,
          (d.principal_units >= 0 AND d.interest_units >= d.tax_units AND d.tax_units >= 0
           AND d.amount_units = d.principal_units + d.interest_units) AS valid
         FROM peer_loan_ledger d JOIN peer_loans l ON l.id = d.loan_id
         WHERE d.loan_id = ? AND l.lender_id = ? AND d.type = ?
           AND d.amount_units - d.tax_units = ? AND d.lender_balance_after_units = ?`,
        kind,
        at,
        Number(loan[1]),
        user,
        type,
        units,
        after
      );
    }
    if (kind === "duel") {
      if (/^决斗房 \S+ 全员爆牌退款$/.test(note)) return 0;
      const payout = /^决斗房 (\S+) 结算入账$/.exec(note);
      if (!payout) throw new Error("无法区分决斗退款与派彩");
      // The room bet is immutable. Each player posts that amount once per round.
      return match(
        `SELECT d.id, d.created_at, d.amount_units - r.bet_units AS net, (r.bet_units > 0) AS valid
        FROM duel_ledger d JOIN duel_rooms r ON r.id = d.room_id
        WHERE r.code = ? AND d.user_id = ? AND d.type = 'payout' AND d.note = ?
          AND d.amount_units = ? AND d.user_balance_after_units = ?`,
        kind,
        at,
        payout[1],
        user,
        note,
        units,
        after
      );
    }
    if (/^战队房 \S+ 争议作废退款$/.test(note)) return 0;
    if (/^战队房 \S+ 选手税分成$/.test(note)) return units;
    const battle = /^战队房 (\S+) 胜方本金及分成$/.exec(note);
    if (!battle) throw new Error("无法区分战队本金、分成与退款");
    // The retired game aggregated all winning bets by member into a single payout.
    return match(
      `SELECT d.id, d.created_at, d.amount_units - SUM(b.amount_units) AS net,
        (MIN(b.amount_units) > 0 AND MIN(b.status IN ('won','lost')) = 1 AND SUM(b.payout_units) = d.amount_units) AS valid
       FROM team_battle_ledger d JOIN team_battle_rooms r ON r.id = d.room_id
       JOIN team_battle_bets b ON b.room_id = d.room_id AND b.user_id = d.user_id
       WHERE r.code = ? AND d.user_id = ? AND d.type = 'winner_payout' AND d.note = ?
         AND d.amount_units = ? AND d.user_balance_after_units = ? GROUP BY d.id`,
      kind,
      at,
      battle[1],
      user,
      note,
      units,
      after
    );
  };
}

function adminIncome(row: LedgerRow, units: number) {
  if (/^玩法下线退还未结投注（.+）$/.test(row.note)) return 0;
  if (row.note === "管理员调整") return units;
  const adjustment =
    /^管理员调整（请求 ([^，]+)，余额下限 0，实际 ([^）]+)）$/.exec(row.note);
  if (!adjustment) throw new Error("无法确认管理员主动授予金额");
  const requested = Math.round(Number(adjustment[1]) * 1_000_000);
  if (
    !Number.isSafeInteger(requested) ||
    signedUnits(Number(adjustment[2])) !== units
  )
    throw new Error("管理员调整记录的金额不一致");
  return Math.max(0, Math.min(units, requested));
}

/** Read only persisted business events. Warnings identify incomplete history and must block applying it. */
export function readHistory(db: Database): {
  events: HistoryEvent[];
  warnings: string[];
} {
  const events: HistoryEvent[] = [],
    warnings: string[] = [];
  const has = (table: string) =>
    !!db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?")
      .get(table);
  const seenDays = new Set<string>();
  const pendingReceipts = new Map<string, { id: number; units: number }>();
  const receiptDays = new Set<string>();
  const pushDay = (userId: number, day: string, at: number) => {
    const key = "signin:" + validDay(day);
    const identity = userId + "/" + key;
    if (seenDays.has(identity)) return false;
    seenDays.add(identity);
    events.push({ userId, key, at, fixedExp: DAILY_CHECKIN_EXP });
    return true;
  };
  if (has("daily_signins")) {
    const columns = db.prepare("PRAGMA table_info(daily_signins)").all() as {
      name: string;
    }[];
    const reward = columns.some(column => column.name === "reward_units")
      ? "reward_units"
      : "NULL";
    const rows = db
      .prepare(
        `SELECT id, user_id, day, created_at, ${reward} AS cents FROM daily_signins ORDER BY created_at, id`
      )
      .iterate() as Iterable<{
      id: number;
      user_id: number;
      day: string;
      cents: number | null;
      created_at: number;
    }>;
    for (const row of rows) {
      try {
        if (
          !pushDay(positiveId(row.user_id), row.day, timestamp(row.created_at))
        )
          throw new Error("重复签到业务日");
        if (row.cents !== null) {
          const units = row.cents * 10_000; // daily_signins rewards are in cents
          if (
            !Number.isSafeInteger(row.cents) ||
            !Number.isSafeInteger(units) ||
            units < 0
          )
            throw new Error("无效的签到美元奖励");
          if (units > 0)
            pendingReceipts.set(row.user_id + "/" + row.day, {
              id: row.id,
              units,
            });
        }
      } catch (error) {
        warnings.push(
          "daily_signins #" + row.id + "：" + (error as Error).message
        );
      }
    }
  }
  if (!has("transactions"))
    return {
      events,
      warnings: [...warnings, "缺少 transactions 表，无法重建实时流水事件键"],
    };
  const netIncome = mixedIncome(db);
  const perpPrincipal = new Map<number, number>();
  for (const row of db
    .prepare(
      "SELECT id, user_id, kind, amount, balance_after, note, created_at FROM transactions ORDER BY id"
    )
    .iterate() as Iterable<LedgerRow>) {
    try {
      const at = timestamp(row.created_at),
        userId = positiveId(row.user_id);
      positiveId(row.id);
      if (!Number.isFinite(row.amount)) throw new Error("无效的流水金额");
      if (row.kind === "checkin") {
        const signin = /^每日签到（业务日 ([^）]+)）$/.exec(row.note);
        if (signin) {
          const receipt = userId + "/" + signin[1];
          if (receiptDays.has(receipt))
            throw new Error("同一业务日多笔签到入账");
          receiptDays.add(receipt);
          pushDay(userId, signin[1], at);
          const expected = pendingReceipts.get(receipt);
          if (expected && unitsFromMoney(row.amount) !== expected.units)
            throw new Error("签到奖励与入账流水金额不一致");
          pendingReceipts.delete(receipt);
        }
      }
      let units = 0,
        source: "income" | "api_usage" = "income";
      if (row.kind === "perp_exchange_in" || row.kind === "perp_exchange_out") {
        const deposit = row.kind === "perp_exchange_in";
        const flow = applyPerpCashFlow(perpPrincipal.get(userId) ?? 0, deposit ? "in" : "out", unitsFromMoney(deposit ? -row.amount : row.amount));
        perpPrincipal.set(userId, flow.principal);
        units = flow.income;
      } else if (row.kind === "usage" && row.amount < 0) {
        source = "api_usage";
        units = unitsFromMoney(-row.amount);
      } else if (row.amount > 0) {
        switch (row.kind) {
          case "draw":
          case "video_reward":
          case "checkin":
          case "redeem":
          case "report":
            units = unitsFromMoney(row.amount);
            break;
          case "loan_repayment":
          case "duel":
          case "team_battle":
            units = netIncome(row, unitsFromMoney(row.amount), at);
            break;
          case "adjust":
            units = adminIncome(row, unitsFromMoney(row.amount));
            break;
          case "loan_disbursement":
          case "loan_offer_refund":
          case "transfer_in":
            break;
          default:
            throw new Error("无法确认正向流水类型 " + row.kind);
        }
      }
      if (units > 0)
        events.push({
          userId,
          key: source + ":ledger:" + row.id,
          at,
          usdUnits: units,
          source,
        });
    } catch (error) {
      warnings.push(
        "transactions #" + row.id + "：" + (error as Error).message
      );
    }
  }
  for (const { id } of pendingReceipts.values())
    warnings.push("daily_signins #" + id + "：无法确认对应的美元奖励流水");
  return { events: events.sort((a, b) => a.at - b.at), warnings };
}
