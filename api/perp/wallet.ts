import type Database from "better-sqlite3";

type Db = Database.Database;
const MAX_CASH = BigInt(Number.MAX_SAFE_INTEGER);

export class PerpCashRangeError extends Error {}
export class PerpInsufficientCashError extends PerpCashRangeError {}

function cashUnits(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_CASH)
    throw new PerpCashRangeError("金额、价格或数量超出有效范围");
  return value;
}

export function readPerpCash(db: Db, userId: number): number {
  const row = db
    .prepare<[number], bigint>(
      "SELECT cash_units FROM perp_wallets WHERE user_id=?"
    )
    .safeIntegers()
    .pluck()
    .get(userId);
  return Number(cashUnits(row ?? 0n));
}

// The caller records the source-specific event in the same write transaction.
export function changePerpCash(
  db: Db,
  userId: number,
  deltaUnits: number
): number {
  if (!db.inTransaction) throw new Error("模拟金余额只能在写事务中变更");
  if (!Number.isSafeInteger(deltaUnits))
    throw new PerpCashRangeError("金额、价格或数量超出有效范围");
  const balance = BigInt(readPerpCash(db, userId)) + BigInt(deltaUnits);
  if (balance < 0n) throw new PerpInsufficientCashError("可用模拟金不足");
  const next = cashUnits(balance);
  db.prepare(
    "INSERT INTO perp_wallets(user_id,cash_units) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET cash_units=excluded.cash_units"
  ).run(userId, next);
  return Number(next);
}
