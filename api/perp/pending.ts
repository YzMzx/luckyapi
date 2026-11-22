import type Database from "better-sqlite3";
import {
  readPerpConfig,
  perpSymbolSchema,
  TAKER_FEE_BPS,
  openLeverageProblem,
} from "./config";
import { isValidPerpLeverage } from "@contracts/perp-leverage";
import {
  fillOrder,
  isFresh,
  PerpRuleError,
  type PerpOrderInput,
  type PerpSnapshot,
} from "./engine";

type Db = Database.Database;
export type PendingInput = PerpOrderInput & {
  orderType: "limit" | "conditional";
  limitPriceUnits?: number;
  triggerPriceUnits?: number;
  triggerDirection?: "above" | "below";
};
export type PendingSnapshot = PerpSnapshot & { tickSizeUnits: number };
type Status = "pending" | "triggered" | "filled" | "cancelled" | "rejected";
export type PendingReceipt = {
  id: number;
  symbol: string;
  action: PendingInput["action"];
  side: "long" | "short";
  orderType: PendingInput["orderType"];
  quantityAtoms: number;
  leverage: number;
  limitPriceUnits: number | null;
  triggerPriceUnits: number | null;
  triggerDirection: "above" | "below" | null;
  createdAt: number;
  updatedAt: number;
  triggeredAt: number | null;
  status: Status;
  fillOrderId: number | null;
  reason: string | null;
};
const cols =
  "id,symbol,action,side,order_type AS orderType,quantity_atoms AS quantityAtoms,leverage,limit_price_units AS limitPriceUnits,trigger_price_units AS triggerPriceUnits,trigger_direction AS triggerDirection,created_at AS createdAt,updated_at AS updatedAt,triggered_at AS triggeredAt,status,fill_order_id AS fillOrderId,reason";
const table = "perp_pending_orders";
const active = "status IN ('pending','triggered')";
const maxPending = 50;
const fail = (msg: string): never => {
  throw new PerpRuleError(msg);
};
function positive(x: unknown): x is number {
  return typeof x === "number" && Number.isSafeInteger(x) && x > 0;
}
function get(db: Db, id: number) {
  return db
    .prepare("SELECT " + cols + " FROM " + table + " WHERE id=?")
    .get(id) as PendingReceipt;
}
function valid(i: PendingInput) {
  if (
    !perpSymbolSchema.safeParse(i.symbol).success ||
    !["openLong", "openShort", "close"].includes(i.action) ||
    !positive(i.quantityAtoms) ||
    typeof i.requestKey !== "string" ||
    !i.requestKey.trim() ||
    i.requestKey.length > 128
  )
    fail("委托参数无效");
  if (
    i.action === "close"
      ? i.leverage !== undefined
      : !isValidPerpLeverage(i.leverage ?? 1)
  )
    fail("杠杆参数无效");
  if (i.orderType === "limit") {
    if (
      !positive(i.limitPriceUnits) ||
      i.triggerPriceUnits !== undefined ||
      i.triggerDirection !== undefined
    )
      fail("限价单须填写有效限价且不含触发条件");
  } else if (i.orderType === "conditional") {
    if (
      !positive(i.triggerPriceUnits) ||
      !(i.triggerDirection === "above" || i.triggerDirection === "below") ||
      (i.limitPriceUnits !== undefined && !positive(i.limitPriceUnits))
    )
      fail("条件单价格或方向无效");
  } else fail("未知委托类型");
}
export function replayPending(db: Db, user: number, input: PendingInput) {
  valid(input);
  const found = db
    .prepare(
      "SELECT " + cols + " FROM " + table + " WHERE user_id=? AND request_key=?"
    )
    .get(user, input.requestKey) as PendingReceipt | undefined;
  if (found) {
    if (
      found.symbol !== input.symbol ||
      found.action !== input.action ||
      found.orderType !== input.orderType ||
      found.quantityAtoms !== input.quantityAtoms ||
      (input.action !== "close" && found.leverage !== (input.leverage ?? 1)) ||
      found.limitPriceUnits !== (input.limitPriceUnits ?? null) ||
      found.triggerPriceUnits !== (input.triggerPriceUnits ?? null) ||
      found.triggerDirection !== (input.triggerDirection ?? null)
    )
      fail("请求键已用于不同参数");
    return found;
  }
  if (
    db
      .prepare(
        "SELECT 1 FROM perp_orders WHERE user_id=? AND request_key=? UNION ALL SELECT 1 FROM perp_exchanges WHERE user_id=? AND request_key=? LIMIT 1"
      )
      .get(user, input.requestKey, user, input.requestKey)
  )
    fail("请求键已用于其他业务");
}
function usable(
  q: PendingSnapshot | null,
  symbol: string
): q is PendingSnapshot {
  return (
    !!q &&
    q.symbol === symbol &&
    isFresh(q) &&
    positive(q.tickSizeUnits) &&
    positive(q.qtyStepAtoms) &&
    positive(q.minQtyAtoms) &&
    positive(q.nextFundingAt) &&
    q.nextFundingAt > Date.now()
  );
}
function checkLot(i: PendingInput, q: PendingSnapshot) {
  if (
    i.quantityAtoms % q.qtyStepAtoms !== 0 ||
    i.quantityAtoms > (q.maxQtyAtoms ?? Number.MAX_SAFE_INTEGER) ||
    (i.action !== "close" && i.quantityAtoms < q.minQtyAtoms)
  )
    fail("数量不符合当前合约规格");
  for (const p of [i.limitPriceUnits, i.triggerPriceUnits])
    if (p !== undefined && p % q.tickSizeUnits !== 0)
      fail("委托价格不符合报价步长");
}
export function createPending(
  db: Db,
  user: number,
  input: PendingInput,
  snapshot: PendingSnapshot | null
) {
  return db
    .transaction(() => {
      const prior = replayPending(db, user, input);
      if (prior) return prior;
      if (!usable(snapshot, input.symbol))
        return fail("暂无可用于挂单的新鲜行情或合约规格");
      checkLot(input, snapshot);
      const cfg = readPerpConfig(db),
        listed = cfg.symbols.find(s => s.symbol === input.symbol);
      if (
        !listed ||
        (input.action !== "close" &&
          (!cfg.tradingEnabled || !listed.openEnabled))
      )
        fail("当前合约未开放或已暂停开仓");
      if (
        input.orderType === "conditional" &&
        (input.triggerDirection === "above"
          ? input.triggerPriceUnits! <= snapshot.markUnits
          : input.triggerPriceUnits! >= snapshot.markUnits)
      )
        fail("触发价必须位于标记价格的所选方向");
      if (
        Number(
          db
            .prepare(
              "SELECT count(*) FROM " + table + " WHERE user_id=? AND " + active
            )
            .pluck()
            .get(user)
        ) >= maxPending
      )
        fail("活动委托最多 50 笔");
      const position = db
        .prepare(
          "SELECT side,leverage,quantity_atoms AS qty,opened_at AS openedAt FROM perp_positions WHERE user_id=? AND symbol=?"
        )
        .get(user, input.symbol) as
        | {
            side: "long" | "short";
            leverage: number;
            qty: number;
            openedAt: number;
          }
        | undefined;
      const side =
        input.action === "openLong"
          ? "long"
          : input.action === "openShort"
            ? "short"
            : position?.side;
      const leverage =
        input.action === "close" ? position?.leverage : (input.leverage ?? 1);
      if (!side || !leverage) return fail("可平仓数量不足");
      if (input.action === "close") {
        if (!position || input.quantityAtoms > position.qty)
          fail("可平仓数量不足");
      } else {
        if (
          position &&
          (position.side !== side || position.leverage !== leverage)
        )
          fail("请先平仓再切换方向或杠杆");
        const leverageProblem = openLeverageProblem(
          cfg,
          leverage,
          snapshot.maxLeverage
        );
        if (leverageProblem) fail(leverageProblem);
        const price = input.limitPriceUnits ?? input.triggerPriceUnits!;
        const value =
          (BigInt(price) * BigInt(input.quantityAtoms)) / 100000000n;
        if (value < BigInt(snapshot.minNotionalUnits) || value <= 0n)
          fail("未达到最小下单名义价值");
        const lev = BigInt(leverage),
          cost =
            (value + lev - 1n) / lev +
            (value * BigInt(TAKER_FEE_BPS) + 9999n) / 10000n;
        const funds = BigInt(
          Number(
            db
              .prepare("SELECT cash_units FROM perp_wallets WHERE user_id=?")
              .pluck()
              .get(user) ?? 0
          )
        );
        if (cost > funds) fail("预估保证金和手续费超过可用余额");
        const sums = db
          .prepare(
            "SELECT coalesce(sum(entry_units),0) total,coalesce(sum(CASE WHEN user_id=? THEN entry_units ELSE 0 END),0) owned FROM perp_positions"
          )
          .get(user) as { total: number; owned: number };
        if (
          value + BigInt(sums.owned) > BigInt(cfg.userLimitUnits) ||
          value + BigInt(sums.total) > BigInt(cfg.platformLimitUnits)
        )
          fail("超出模拟合约名义仓位上限");
      }
      const now = Date.now();
      const saved = db
        .prepare(
          "INSERT INTO " +
            table +
            " (user_id,request_key,symbol,action,side,order_type,quantity_atoms,leverage,limit_price_units,trigger_price_units,trigger_direction,created_at,updated_at,last_quote_at,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')"
        )
        .run(
          user,
          input.requestKey,
          input.symbol,
          input.action,
          side,
          input.orderType,
          input.quantityAtoms,
          leverage,
          input.limitPriceUnits ?? null,
          input.triggerPriceUnits ?? null,
          input.triggerDirection ?? null,
          now,
          now,
          now
        );
      if (position && input.action === "close")
        db.prepare(
          "INSERT INTO perp_pending_position_bindings(pending_id,opened_at) VALUES (?,?)"
        ).run(saved.lastInsertRowid, position.openedAt);
      return get(db, Number(saved.lastInsertRowid));
    })
    .immediate();
}
export function listPending(db: Db, user: number) {
  const sql = "SELECT " + cols + " FROM " + table + " WHERE user_id=? AND ";
  return [
    ...db.prepare(sql + active + " ORDER BY id DESC").all(user),
    ...db
      .prepare(
        sql +
          "status NOT IN ('pending','triggered') ORDER BY updated_at DESC,id DESC LIMIT 50"
      )
      .all(user),
  ] as PendingReceipt[];
}
export function cancelPending(db: Db, user: number, id: number) {
  return db
    .transaction(() => {
      const row = db
        .prepare("SELECT id FROM " + table + " WHERE user_id=? AND id=?")
        .get(user, id);
      if (!row) return fail("委托不存在");
      db.prepare(
        "UPDATE " +
          table +
          " SET status='cancelled',reason='用户撤单',updated_at=? WHERE id=? AND " +
          active
      ).run(Date.now(), id);
      return get(db, id);
    })
    .immediate();
}
export function listPendingSymbols(db: Db) {
  return db
    .prepare("SELECT DISTINCT symbol FROM " + table + " WHERE " + active)
    .pluck()
    .all() as string[];
}
export function pendingForSymbol(db: Db, symbol: string) {
  return db
    .prepare(
      "SELECT id,user_id AS userId FROM " +
        table +
        " WHERE symbol=? AND " +
        active +
        " ORDER BY id"
    )
    .all(symbol) as { id: number; userId: number }[];
}
function stop(db: Db, id: number, reason: string) {
  db.prepare(
    "UPDATE " +
      table +
      " SET status='rejected',reason=?,updated_at=? WHERE id=?"
  ).run(reason, Date.now(), id);
  return get(db, id);
}
export function matchPending(
  db: Db,
  id: number,
  q: PendingSnapshot,
  guard: (userId: number) => string | null
) {
  return db
    .transaction(() => {
      const r = db
        .prepare(
          "SELECT " +
            cols +
            ",user_id AS userId,request_key AS requestKey,last_quote_at AS lastQuoteAt,(SELECT opened_at FROM perp_pending_position_bindings b WHERE b.pending_id=perp_pending_orders.id) AS positionOpenedAt FROM " +
            table +
            " WHERE id=?"
        )
        .get(id) as
        | (PendingReceipt & {
            userId: number;
            requestKey: string;
            lastQuoteAt: number;
            positionOpenedAt: number | null;
          })
        | undefined;
      if (!r) return null;
      if (
        !["pending", "triggered"].includes(r.status) ||
        !usable(q, r.symbol) ||
        q.asOf <= r.lastQuoteAt
      )
        return get(db, id);
      const reason = guard(r.userId);
      if (reason) return stop(db, id, reason);
      const cfg = readPerpConfig(db),
        listed = cfg.symbols.find(s => s.symbol === r.symbol);
      if (
        !listed ||
        (r.action !== "close" && (!cfg.tradingEnabled || !listed.openEnabled))
      )
        return stop(db, id, "合约未开放或已暂停开仓");
      const position = db
        .prepare(
          "SELECT side,quantity_atoms AS qty,next_funding_at AS due,opened_at AS openedAt FROM perp_positions WHERE user_id=? AND symbol=?"
        )
        .get(r.userId, r.symbol) as
        | { side: string; qty: number; due: number; openedAt: number }
        | undefined;
      if (
        r.action === "close" &&
        (!position ||
          position.side !== r.side ||
          position.openedAt !== r.positionOpenedAt ||
          r.quantityAtoms > position.qty)
      )
        return stop(db, id, "可平仓数量不足或仓位方向已变更");
      if (position && position.due <= q.asOf) return get(db, id); // do not race authoritative funding settlement
      db.prepare("UPDATE " + table + " SET last_quote_at=? WHERE id=?").run(
        q.asOf,
        id
      );
      if (r.orderType === "conditional" && r.status === "pending") {
        if (
          r.triggerDirection === "above"
            ? q.markUnits < r.triggerPriceUnits!
            : q.markUnits > r.triggerPriceUnits!
        )
          return get(db, id);
        db.prepare(
          "UPDATE " +
            table +
            " SET status='triggered',triggered_at=?,updated_at=? WHERE id=?"
        ).run(q.asOf, q.asOf, id);
      }
      const buy =
        r.action === "openLong" || (r.action === "close" && r.side === "short");
      if (
        r.limitPriceUnits !== null &&
        (buy ? q.askUnits > r.limitPriceUnits : q.bidUnits < r.limitPriceUnits)
      )
        return get(db, id);
      const input: PendingInput = {
        action: r.action,
        symbol: r.symbol,
        quantityAtoms: r.quantityAtoms,
        leverage: r.action === "close" ? undefined : r.leverage,
        requestKey: r.requestKey,
        orderType: r.orderType,
        limitPriceUnits: r.limitPriceUnits ?? undefined,
        triggerPriceUnits: r.triggerPriceUnits ?? undefined,
        triggerDirection: r.triggerDirection ?? undefined,
      };
      try {
        // Savepoint ensures a business rejection cannot retain a partial debit/ledger entry.
        const applied = db.transaction(() => {
          checkLot(input, q);
          return fillOrder(db, r.userId, input, q);
        })();
        const fill = applied.order ?? applied.liquidated;
        db.prepare(
          "UPDATE " +
            table +
            " SET status=?,updated_at=?,fill_order_id=?,reason=? WHERE id=?"
        ).run(
          applied.order ? "filled" : "rejected",
          q.asOf,
          fill.id,
          applied.order ? null : "仓位已强平",
          id
        );
      } catch (e) {
        if (e instanceof PerpRuleError) return stop(db, id, e.message);
        throw e;
      }
      return get(db, id);
    })
    .immediate();
}
export function processPerpPending(
  db: Db,
  symbol: string,
  q: PendingSnapshot,
  guard: (userId: number) => string | null
) {
  if (q.symbol !== symbol) return;
  for (const { id } of pendingForSymbol(db, symbol))
    matchPending(db, id, q, guard);
}
