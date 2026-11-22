import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@db/schema";
import {
  CREDIT_GRANT_SCALE,
  creditUnitsToDollars,
  debitPermanentBalance,
  expireUserCreditGrants,
} from "../queries/credit-grants";
import { applyPerpCashFlow } from "@contracts/perp-income";
import { recordTx } from "../queries/ledger";
import {
  MAINTENANCE_MARGIN_BPS,
  TAKER_FEE_BPS,
  readPerpConfig,
  perpSymbolSchema,
} from "./config";

export class PerpRuleError extends Error {}
export class PerpExchangeQuoteChanged extends PerpRuleError {}
type Db = Database.Database;
type Side = "long" | "short";
type Action = "openLong" | "openShort" | "close";
type Direction = "in" | "out";
export type PerpOrderInput = {
  symbol: string;
  action: Action;
  quantityAtoms: number;
  leverage?: number;
  requestKey: string;
};
type Mark = {
  symbol: string;
  asOf: number;
  bidUnits: number;
  askUnits: number;
  markUnits: number;
};
export type PerpSnapshot = Mark & {
  qtyStepAtoms: number;
  minQtyAtoms: number;
  maxQtyAtoms?: number;
  minNotionalUnits: number;
  maxLeverage?: number;
  nextFundingAt: number;
};
type Position = {
  userId: number;
  symbol: string;
  side: Side;
  quantityAtoms: number;
  entryNotionalUnits: number;
  marginUnits: number;
  leverage: number;
  openedAt: number;
  updatedAt: number;
  nextFundingAt: number;
};
type Receipt = {
  id: number;
  symbol: string;
  action: Action | "liquidate";
  side: Side;
  quantityAtoms: number;
  leverage: number;
  priceUnits: number;
  markUnits: number;
  feeUnits: number;
  pnlUnits: number;
  createdAt: number;
};
type ExchangeRules = { exchangeRate: number; redemptionFeeBps: number };
type Exchange = ExchangeRules & {
  grossUnits: number;
  id: number;
  direction: Direction;
  amountUnits: number;
  feeUnits: number;
  netUnits: number;
  createdAt: number;
};
type Funding = {
  id: number;
  symbol: string;
  asOf: number;
  markUnits: number;
  rateE8: number;
  amountUnits: number;
};
const ORDER =
  "id,symbol,action,side,quantity_atoms AS quantityAtoms,leverage,price_units AS priceUnits,mark_units AS markUnits,fee_units AS feeUnits,pnl_units AS pnlUnits,created_at AS createdAt";
const POSITION =
  "user_id AS userId,symbol,side,quantity_atoms AS quantityAtoms,entry_units AS entryNotionalUnits,margin_units AS marginUnits,leverage,opened_at AS openedAt,updated_at AS updatedAt,next_funding_at AS nextFundingAt";
const EXCHANGE = `e.id,e.direction,e.amount_units AS amountUnits,e.fee_units AS feeUnits,e.net_units AS netUnits,
  e.created_at AS createdAt,e.net_units+e.fee_units AS grossUnits,
  COALESCE(r.exchange_rate,1000) AS exchangeRate,COALESCE(r.redemption_fee_bps,500) AS redemptionFeeBps`;
const EXCHANGE_FROM =
  " FROM perp_exchanges e LEFT JOIN perp_exchange_rules r ON r.exchange_id=e.id ";
const SCALE = 100_000_000n,
  BPS = 10_000n,
  FEE = BigInt(TAKER_FEE_BPS),
  MM = BigInt(MAINTENANCE_MARGIN_BPS);
function fail(msg: string): never {
  throw new PerpRuleError(msg);
}
function integer(n: number, min = 0) {
  if (!Number.isSafeInteger(n) || n < min) fail("金额、价格或数量超出有效范围");
  return n;
}
function validKey(key: string) {
  if (typeof key !== "string" || !key.trim() || key.length > 128)
    fail("无效的请求键");
}
function num(x: bigint) {
  return integer(Number(x), Number.MIN_SAFE_INTEGER);
}
function ceil(x: bigint, d: bigint) {
  return (x + d - 1n) / d;
}
function notional(q: number, p: number) {
  return num((BigInt(q) * BigInt(p)) / SCALE);
}
function charge(n: number) {
  return num(ceil(BigInt(n) * FEE, BPS));
}
function sign(p: Side) {
  return p === "long" ? 1 : -1;
}
function cash(db: Db, id: number) {
  return Number(
    db
      .prepare("SELECT cash_units FROM perp_wallets WHERE user_id=?")
      .pluck()
      .get(id) ?? 0
  );
}
function changeCash(db: Db, id: number, delta: number) {
  const total = integer(cash(db, id) + delta);
  db.prepare(
    "INSERT INTO perp_wallets VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET cash_units=excluded.cash_units"
  ).run(id, total);
}
function addEvent(
  db: Db,
  user: number,
  symbol: string | null,
  kind: string,
  time: number,
  cashDelta: number,
  marginDelta = 0,
  entryDelta = 0,
  qtyDelta = 0
) {
  db.prepare(
    "INSERT INTO perp_events(user_id,symbol,kind,created_at,cash_delta_units,margin_delta_units,entry_delta_units,qty_delta_atoms) VALUES(?,?,?,?,?,?,?,?)"
  ).run(user, symbol, kind, time, cashDelta, marginDelta, entryDelta, qtyDelta);
}
function orderByKey(db: Db, id: number, key: string) {
  return db
    .prepare(
      "SELECT " + ORDER + " FROM perp_orders WHERE user_id=? AND request_key=?"
    )
    .get(id, key) as Receipt | undefined;
}
function exchangeByKey(db: Db, id: number, key: string) {
  return db
    .prepare(
      "SELECT " +
        EXCHANGE +
        EXCHANGE_FROM +
        " WHERE e.user_id=? AND e.request_key=?"
    )
    .get(id, key) as Exchange | undefined;
}
function pendingKey(db: Db, user: number, key: string) {
  return db
    .prepare(
      "SELECT 1 FROM perp_pending_orders WHERE user_id=? AND request_key=?"
    )
    .get(user, key);
}
function conflict(): never {
  return fail("请求键已用于不同参数");
}
export function previewPerpExchange(
  direction: Direction,
  amountUnits: number,
  rules: ExchangeRules = { exchangeRate: 1000, redemptionFeeBps: 500 }
) {
  const amount = BigInt(integer(amountUnits, 1));
  const rate = BigInt(integer(rules.exchangeRate, 1));
  const bps = BigInt(integer(rules.redemptionFeeBps));
  if (bps > BPS) fail("手续费率无效");
  if (direction !== "out" && direction !== "in") fail("兑换方向无效");
  // Input is micro-credit for deposits and milli-sim for redemptions; all
  // receipt amounts except amountUnits are in units of the destination wallet.
  const grossUnits = num(
    direction === "in" ? (amount * rate) / 1000n : (amount * 1000n) / rate
  );
  if (!grossUnits) fail("兑换金额过小，到账为零");
  const feeUnits =
    direction === "out" ? num(ceil(BigInt(grossUnits) * bps, BPS)) : 0;
  if (feeUnits >= grossUnits) fail("扣除手续费后到账为零");
  return {
    direction,
    amountUnits,
    grossUnits,
    feeUnits,
    netUnits: grossUnits - feeUnits,
    exchangeRate: rules.exchangeRate,
    redemptionFeeBps: rules.redemptionFeeBps,
  };
}
// Called only inside the exchange transaction, after the idempotency check.
function advanceExpBasis(
  db: Db,
  user: number,
  direction: Direction,
  creditUnits: number
) {
  let principal = db
    .prepare<[number], number>(
      "SELECT principal_units FROM perp_exp_basis WHERE user_id=?"
    )
    .pluck()
    .get(user);
  if (principal === undefined) {
    // On upgrade, recover the outstanding principal without issuing retrospective XP.
    principal = 0;
    for (const row of db
      .prepare<[number], { direction: Direction; credit_units: number }>(
        "SELECT direction, CASE direction WHEN 'in' THEN amount_units ELSE net_units END AS credit_units FROM perp_exchanges WHERE user_id=? ORDER BY id"
      )
      .iterate(user))
      principal = applyPerpCashFlow(
        principal,
        row.direction,
        row.credit_units
      ).principal;
  }
  const next = applyPerpCashFlow(principal, direction, creditUnits);
  db.prepare(
    "INSERT INTO perp_exp_basis(user_id,principal_units) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET principal_units=excluded.principal_units"
  ).run(user, next.principal);
  return next.income;
}
export function exchangePerp(
  db: Db,
  user: number,
  input: {
    direction: Direction;
    amountUnits: number;
    requestKey: string;
    expectedExchangeRate?: number;
    expectedRedemptionFeeBps?: number;
  }
) {
  integer(user, 1);
  validKey(input.requestKey);
  return db
    .transaction(() => {
      const prior = exchangeByKey(db, user, input.requestKey);
      if (prior) {
        if (
          prior.direction !== input.direction ||
          prior.amountUnits !== input.amountUnits
        )
          conflict();
        return prior;
      }
      if (
        orderByKey(db, user, input.requestKey) ||
        pendingKey(db, user, input.requestKey)
      )
        conflict();
      const now = Date.now(),
        ledger = drizzle(db, { schema });
      const rules = readPerpConfig(db);
      if (
        (input.expectedExchangeRate !== undefined &&
          input.expectedExchangeRate !== rules.exchangeRate) ||
        (input.expectedRedemptionFeeBps !== undefined &&
          input.expectedRedemptionFeeBps !== rules.redemptionFeeBps)
      ) {
        throw new PerpExchangeQuoteChanged("兑换规则已变更，请重新预览");
      }
      const value = previewPerpExchange(
        input.direction,
        input.amountUnits,
        rules
      );
      const incomeUnits = advanceExpBasis(
        db,
        user,
        value.direction,
        value.direction === "in" ? value.amountUnits : value.netUnits
      );
      const delta =
        value.direction === "in" ? value.netUnits : -value.amountUnits;
      if (value.direction === "in") {
        if (!rules.depositsEnabled) fail("管理员已暂停换入模拟金");
        try {
          debitPermanentBalance(ledger, {
            userId: user,
            amount: creditUnitsToDollars(value.amountUnits),
            kind: "perp_exchange_in",
            note: "换入永续合约模拟金",
            now: new Date(now),
          });
        } catch (e) {
          if (e instanceof Error && e.message.includes("永久额度不足"))
            fail("可兑换的永久额度不足");
          throw e;
        }
      } else {
        if (cash(db, user) < value.amountUnits) fail("可用模拟金不足");
        const { balanceAfter } = expireUserCreditGrants(
          ledger,
          user,
          new Date(now)
        );
        const updated = integer(
          Math.round(balanceAfter * CREDIT_GRANT_SCALE) + value.netUnits,
          Number.MIN_SAFE_INTEGER
        );
        db.prepare("UPDATE users SET balance=? WHERE id=?").run(
          creditUnitsToDollars(updated),
          user
        );
        recordTx(
          ledger,
          user,
          "perp_exchange_out",
          creditUnitsToDollars(value.netUnits),
          `永续合约模拟金兑回永久额度（手续费率 ${value.redemptionFeeBps / 100}%）`,
          creditUnitsToDollars(incomeUnits)
        );
      }
      changeCash(db, user, delta);
      addEvent(db, user, null, value.direction, now, delta);
      const { lastInsertRowid } = db
        .prepare(
          "INSERT INTO perp_exchanges(user_id,direction,amount_units,fee_units,net_units,created_at,request_key) VALUES(?,?,?,?,?,?,?)"
        )
        .run(
          user,
          value.direction,
          value.amountUnits,
          value.feeUnits,
          value.netUnits,
          now,
          input.requestKey
        );
      db.prepare(
        "INSERT INTO perp_exchange_rules(exchange_id,exchange_rate,redemption_fee_bps) VALUES (?,?,?)"
      ).run(lastInsertRowid, value.exchangeRate, value.redemptionFeeBps);
      return { id: Number(lastInsertRowid), ...value, createdAt: now };
    })
    .immediate();
}
function getPosition(db: Db, user: number, symbol: string) {
  return db
    .prepare(
      "SELECT " + POSITION + " FROM perp_positions WHERE user_id=? AND symbol=?"
    )
    .get(user, symbol) as Position | undefined;
}
export function describePosition(p: Position) {
  const buy = p.side === "long";
  const equityBase = BigInt(
    buy
      ? p.entryNotionalUnits - p.marginUnits
      : integer(p.entryNotionalUnits + p.marginUnits)
  );
  const denominator = BigInt(p.quantityAtoms) * (buy ? BPS - MM : BPS + MM);
  const liquidationPriceUnits =
    equityBase <= 0n ? 0 : num((equityBase * SCALE * BPS) / denominator);
  return {
    ...p,
    entryPriceUnits: num(
      (BigInt(p.entryNotionalUnits) * SCALE) / BigInt(p.quantityAtoms)
    ),
    liquidationPriceUnits,
  };
}
export function getPerpAccount(db: Db, user: number) {
  integer(user, 1);
  return db.transaction(() => {
    const row = db.prepare("SELECT balance FROM users WHERE id=?").get(user) as
      { balance: number } | undefined;
    if (!row) fail("用户不存在");
    const timed = Number(
      db
        .prepare(
          "SELECT coalesce(sum(remaining_units),0) FROM credit_grants WHERE user_id=? AND status='active'"
        )
        .pluck()
        .get(user)
    );
    const positions = (
      db
        .prepare(
          "SELECT " +
            POSITION +
            " FROM perp_positions WHERE user_id=? ORDER BY symbol"
        )
        .all(user) as Position[]
    ).map(describePosition);
    const orders = db
      .prepare(
        "SELECT " +
          ORDER +
          " FROM perp_orders WHERE user_id=? ORDER BY id DESC LIMIT 100"
      )
      .all(user) as Receipt[];
    const exchanges = db
      .prepare(
        "SELECT " +
          EXCHANGE +
          EXCHANGE_FROM +
          " WHERE e.user_id=? ORDER BY e.id DESC LIMIT 100"
      )
      .all(user) as Exchange[];
    const funding = db
      .prepare(
        "SELECT id,symbol,as_of AS asOf,rate_e8 AS rateE8,mark_units AS markUnits,amount_units AS amountUnits FROM perp_funding WHERE user_id=? ORDER BY as_of DESC,id DESC LIMIT 100"
      )
      .all(user) as Funding[];
    return {
      cashUnits: cash(db, user),
      availableCashUnits: cash(db, user),
      frozenCashUnits: positions.reduce(
        (a, p) => integer(a + p.marginUnits),
        0
      ),
      permanentCreditUnits: integer(
        Math.round(row.balance * CREDIT_GRANT_SCALE) - timed,
        Number.MIN_SAFE_INTEGER
      ),
      positions,
      orders,
      exchanges,
      funding,
    };
  })();
}
function writePosition(db: Db, p: Position) {
  if (p.quantityAtoms === 0) {
    db.prepare("DELETE FROM perp_positions WHERE user_id=? AND symbol=?").run(
      p.userId,
      p.symbol
    );
    return;
  }
  db.prepare(
    "INSERT INTO perp_positions(user_id,symbol,side,quantity_atoms,entry_units,margin_units,leverage,opened_at,updated_at,next_funding_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,symbol) DO UPDATE SET quantity_atoms=excluded.quantity_atoms,entry_units=excluded.entry_units,margin_units=excluded.margin_units,updated_at=excluded.updated_at,next_funding_at=excluded.next_funding_at"
  ).run(
    p.userId,
    p.symbol,
    p.side,
    integer(p.quantityAtoms, 1),
    integer(p.entryNotionalUnits, 1),
    integer(p.marginUnits),
    p.leverage,
    p.openedAt,
    p.updatedAt,
    p.nextFundingAt
  );
}
function recordOrder(
  db: Db,
  user: number,
  key: string | null,
  r: Omit<Receipt, "id">
): Receipt {
  const res = db
    .prepare(
      "INSERT INTO perp_orders(user_id,request_key,symbol,action,side,quantity_atoms,leverage,price_units,mark_units,fee_units,pnl_units,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
    )
    .run(
      user,
      key,
      r.symbol,
      r.action,
      r.side,
      r.quantityAtoms,
      r.leverage,
      r.priceUnits,
      r.markUnits,
      r.feeUnits,
      r.pnlUnits,
      r.createdAt
    );
  return { id: Number(res.lastInsertRowid), ...r };
}
function replay(db: Db, user: number, input: PerpOrderInput) {
  if (
    exchangeByKey(db, user, input.requestKey) ||
    pendingKey(db, user, input.requestKey)
  )
    conflict();
  const old = orderByKey(db, user, input.requestKey);
  if (
    old &&
    (old.symbol !== input.symbol ||
      old.action !== input.action ||
      old.quantityAtoms !== input.quantityAtoms ||
      (input.action !== "close" && old.leverage !== (input.leverage ?? 1)))
  )
    conflict();
  return old;
}
export function isFresh(q: Mark) {
  const now = Date.now();
  return (
    Number.isSafeInteger(q.asOf) &&
    q.asOf <= now &&
    now - q.asOf < 5000 &&
    [q.bidUnits, q.askUnits, q.markUnits].every(
      n => Number.isSafeInteger(n) && n > 0
    ) &&
    q.bidUnits <= q.askUnits
  );
}
function maintenanceBreached(p: Position, mark: number) {
  const value = notional(p.quantityAtoms, mark);
  const equity =
    BigInt(p.marginUnits) +
    BigInt(sign(p.side)) * (BigInt(value) - BigInt(p.entryNotionalUnits));
  return equity * BPS <= BigInt(value) * MM;
}
function closePosition(
  db: Db,
  p: Position,
  q: Mark,
  quantity: number,
  action: "close" | "liquidate",
  key: string | null
) {
  const size = BigInt(quantity),
    total = BigInt(p.quantityAtoms),
    price = p.side === "long" ? q.bidUnits : q.askUnits;
  const entry = num((BigInt(p.entryNotionalUnits) * size) / total),
    released = num((BigInt(p.marginUnits) * size) / total);
  const value = notional(quantity, price),
    gross = integer(sign(p.side) * (value - entry), Number.MIN_SAFE_INTEGER);
  // A gap can exhaust the isolated position. Never draw on other positions or free wallet cash.
  const equity = Math.max(
    0,
    integer(released + gross, Number.MIN_SAFE_INTEGER)
  );
  const fee = Math.min(equity, charge(value));
  const payout = equity - fee;
  if (quantity < p.quantityAtoms && released + gross <= 0)
    fail("平仓价已耗尽分摊保证金，请全部平仓");
  changeCash(db, p.userId, payout);
  writePosition(db, {
    ...p,
    quantityAtoms: p.quantityAtoms - quantity,
    entryNotionalUnits: p.entryNotionalUnits - entry,
    marginUnits: p.marginUnits - released,
    updatedAt: q.asOf,
  });
  addEvent(
    db,
    p.userId,
    p.symbol,
    action,
    q.asOf,
    payout,
    -released,
    -sign(p.side) * entry,
    -sign(p.side) * quantity
  );
  if (quantity === p.quantityAtoms) {
    // A reduce-only order belongs to this position, not to any subsequent reopen.
    db.prepare(
      "UPDATE perp_pending_orders SET status='cancelled',reason='原仓位已全部平仓',updated_at=? WHERE user_id=? AND symbol=? AND action='close' AND status IN ('pending','triggered') AND request_key IS NOT ?"
    ).run(q.asOf, p.userId, p.symbol, key);
  }
  return recordOrder(db, p.userId, key, {
    symbol: p.symbol,
    action,
    side: p.side,
    quantityAtoms: quantity,
    leverage: p.leverage,
    priceUnits: price,
    markUnits: q.markUnits,
    feeUnits: fee,
    pnlUnits: equity - released,
    createdAt: q.asOf,
  });
}
// Internal execution primitive. Caller owns the immediate transaction and quote validation.
export function fillOrder(
  db: Db,
  user: number,
  input: PerpOrderInput,
  q: PerpSnapshot
) {
  const p = getPosition(db, user, input.symbol),
    qty = input.quantityAtoms;
  if (p && p.nextFundingAt <= q.asOf) fail("该仓位资金费待确认，请稍后重试");
  if (p && q.asOf < p.updatedAt) fail("报价早于仓位最新变动");
  if (p && maintenanceBreached(p, q.markUnits))
    return {
      liquidated: closePosition(
        db,
        p,
        q,
        p.quantityAtoms,
        "liquidate",
        input.requestKey
      ),
    };
  if (
    qty % integer(q.qtyStepAtoms, 1) !== 0 ||
    qty > (q.maxQtyAtoms ?? Number.MAX_SAFE_INTEGER)
  )
    fail("下单数量不符合合约步长或单笔上限");
  if (input.action === "close") {
    if (!p || qty > p.quantityAtoms) fail("可平仓数量不足");
    return { order: closePosition(db, p, q, qty, "close", input.requestKey) };
  }
  const cfg = readPerpConfig(db);
  if (
    !cfg.tradingEnabled ||
    !cfg.symbols.some(s => s.symbol === input.symbol && s.openEnabled)
  )
    fail("当前合约已暂停开仓");
  const side = input.action === "openLong" ? "long" : "short",
    leverage = input.leverage ?? 1;
  if (leverage > (q.maxLeverage ?? 5) || ![1, 2, 5].includes(leverage))
    fail("当前杠杆无效");
  if (p && (p.side !== side || p.leverage !== leverage))
    fail("请先平仓再切换方向或杠杆");
  const price = side === "long" ? q.askUnits : q.bidUnits,
    value = notional(qty, price);
  if (
    qty < integer(q.minQtyAtoms, 1) ||
    value < Math.max(1, integer(q.minNotionalUnits))
  )
    fail("未达到合约最小下单量或名义价值");
  const sums = db
    .prepare(
      "SELECT coalesce(sum(entry_units),0) AS total,coalesce(sum(CASE WHEN user_id=? THEN entry_units ELSE 0 END),0) AS owned FROM perp_positions"
    )
    .get(user) as { total: number; owned: number };
  const entry = integer((p?.entryNotionalUnits ?? 0) + value);
  if (
    integer(sums.owned + value) > cfg.userLimitUnits ||
    integer(sums.total + value) > cfg.platformLimitUnits
  )
    fail("超出模拟合约名义仓位上限");
  const margin = num(ceil(BigInt(value), BigInt(leverage))),
    fee = charge(value),
    debit = integer(margin + fee);
  if (debit > cash(db, user)) fail("可用模拟金不足以支付保证金和手续费");
  const next = {
    userId: user,
    symbol: q.symbol,
    side,
    leverage,
    entryNotionalUnits: entry,
    quantityAtoms: integer((p?.quantityAtoms ?? 0) + qty),
    marginUnits: integer((p?.marginUnits ?? 0) + margin),
    openedAt: p?.openedAt ?? q.asOf,
    updatedAt: q.asOf,
    nextFundingAt: p?.nextFundingAt ?? q.nextFundingAt,
  } satisfies Position;
  if (maintenanceBreached(next, q.markUnits))
    fail("该成交价会触发强平，请稍后重试");
  changeCash(db, user, -debit);
  writePosition(db, next);
  addEvent(
    db,
    user,
    q.symbol,
    "open",
    q.asOf,
    -debit,
    margin,
    sign(side) * value,
    sign(side) * qty
  );
  return {
    order: recordOrder(db, user, input.requestKey, {
      symbol: q.symbol,
      action: input.action,
      side,
      leverage,
      quantityAtoms: qty,
      priceUnits: price,
      markUnits: q.markUnits,
      pnlUnits: 0,
      feeUnits: fee,
      createdAt: q.asOf,
    }),
  };
}
export async function placePerpOrder(
  db: Db,
  user: number,
  input: PerpOrderInput,
  feed: (symbol: string, acceptedAt: number) => Promise<PerpSnapshot | null>
) {
  integer(user, 1);
  integer(input.quantityAtoms, 1);
  validKey(input.requestKey);
  if (
    !["openLong", "openShort", "close"].includes(input.action) ||
    !perpSymbolSchema.safeParse(input.symbol).success
  )
    fail("无效合约或委托方向");
  if (
    input.action === "close"
      ? input.leverage !== undefined
      : ![1, 2, 5].includes(input.leverage ?? 1)
  )
    fail("无效的杠杆参数");
  const existing = replay(db, user, input);
  if (existing) return existing;
  // Never query Bybit on behalf of a member for an unlisted contract.
  const cfg = readPerpConfig(db);
  const listed = cfg.symbols.find(s => s.symbol === input.symbol);
  if (!listed) fail("该合约未开放");
  if (input.action !== "close" && (!cfg.tradingEnabled || !listed.openEnabled))
    fail("当前合约已暂停开仓");
  const accepted = Date.now();
  let q: PerpSnapshot | null;
  try {
    q = await feed(input.symbol, accepted);
  } catch {
    q = null;
  }
  const result = db
    .transaction(() => {
      const prior = replay(db, user, input);
      if (prior) return { order: prior };
      if (
        !q ||
        q.symbol !== input.symbol ||
        !isFresh(q) ||
        q.asOf <= accepted ||
        Date.now() - accepted >= 5000 ||
        !Number.isSafeInteger(q.nextFundingAt) ||
        q.nextFundingAt <= q.asOf
      )
        fail("Bybit 实时报价过期或不可用，请重试");
      return fillOrder(db, user, input, q);
    })
    .immediate();
  if (!result.order) fail("仓位已触发逐仓强平");
  return result.order;
}
export function liquidatePerpPositions(db: Db, q: Mark) {
  if (!isFresh(q)) return 0;
  return db
    .transaction(() => {
      const rows = db
        .prepare(
          "SELECT " +
            POSITION +
            " FROM perp_positions WHERE symbol=? AND updated_at<=? AND next_funding_at>?"
        )
        .all(q.symbol, q.asOf, q.asOf) as Position[];
      let count = 0;
      for (const p of rows) {
        if (maintenanceBreached(p, q.markUnits)) {
          closePosition(db, p, q, p.quantityAtoms, "liquidate", null);
          count++;
        }
      }
      return count;
    })
    .immediate();
}
export function applyPerpFunding(
  db: Db,
  symbol: string,
  f: { asOf: number; rateE8: number; markUnits: number; nextFundingAt: number }
) {
  integer(f.asOf, 1);
  integer(f.nextFundingAt, f.asOf + 1);
  integer(f.markUnits, 1);
  integer(f.rateE8, -100_000_000);
  if (f.asOf > Date.now() || f.rateE8 > 100_000_000) fail("资金费率或时间无效");
  return db
    .transaction(() => {
      const rows = db
        .prepare(
          "SELECT " +
            POSITION +
            " FROM perp_positions WHERE symbol=? AND next_funding_at=? AND opened_at<?"
        )
        .all(symbol, f.asOf, f.asOf) as Position[];
      for (const p of rows) {
        const payment = num(
          (BigInt(notional(p.quantityAtoms, f.markUnits)) *
            BigInt(f.rateE8) *
            BigInt(-sign(p.side))) /
            SCALE
        );
        const delta = Math.max(-p.marginUnits, payment);
        db.prepare(
          "INSERT INTO perp_funding(user_id,symbol,as_of,rate_e8,mark_units,amount_units) VALUES(?,?,?,?,?,?)"
        ).run(p.userId, symbol, f.asOf, f.rateE8, f.markUnits, delta);
        const next = {
          ...p,
          marginUnits: integer(p.marginUnits + delta),
          updatedAt: f.asOf,
          nextFundingAt: f.nextFundingAt,
        };
        writePosition(db, next);
        addEvent(db, p.userId, symbol, "funding", f.asOf, 0, delta);
        // Historical funding mark is an exact boundary valuation, including after a restart.
        if (maintenanceBreached(next, f.markUnits))
          closePosition(
            db,
            next,
            {
              symbol,
              bidUnits: f.markUnits,
              askUnits: f.markUnits,
              markUnits: f.markUnits,
              asOf: f.asOf,
            },
            p.quantityAtoms,
            "liquidate",
            null
          );
      }
      return rows.length;
    })
    .immediate();
}
