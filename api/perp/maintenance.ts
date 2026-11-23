import type Database from "better-sqlite3";
import { applyPerpFunding, liquidatePerpPositions } from "./engine";
import {
  getBoundaryMark,
  getFundingHistory,
  getPerpInstrument,
  getPerpOrderBook,
  getPerpQuote,
} from "./market";
import { listPendingSymbols, matchPending, pendingForSymbol } from "./pending";
import { SETTING_KEYS } from "../settings";
import { settlePerpWeeks, storePerpBoundaryMark } from "./weekly";

type Db = Database.Database;
const WEEK = 7 * 86_400_000;
const FRESH_MS = 5_000;
export const PERP_MAINTENANCE_INTERVAL_MS = 5_000;
const active = new WeakSet<Db>();
const nextRunAt = new WeakMap<Db, number>();

function freshQuote(quote: Awaited<ReturnType<typeof getPerpQuote>>) {
  if (!quote) return false;
  const age = Date.now() - quote.asOf;
  return (
    age >= 0 &&
    age <= FRESH_MS &&
    quote.bidUnits > 0 &&
    quote.askUnits >= quote.bidUnits &&
    quote.markUnits > 0
  );
}

// Work oldest-first. The position's persisted next_funding_at is the cursor and
// advances in the same transaction as its fee. Never skip a missing rate/mark.
async function settleDueFunding(db: Db, symbol: string, due: number) {
  const now = Date.now();
  const end = Math.min(now, due - 1 + WEEK);
  const records = await getFundingHistory(db, symbol, due - 1, end);
  if (!records?.length || records[0].at !== due) return;
  // Bound each catch-up pass so one long outage cannot starve other symbols.
  for (let i = 0; i < Math.min(records.length, 16); i++) {
    const row = records[i];
    let next = records[i + 1]?.at;
    if (!next) {
      if (end < now) break;
      const q = await getPerpQuote(db, symbol);
      if (!q || !freshQuote(q) || q.nextFundingAt <= Date.now()) break;
      // The history and ticker must describe the same completed settlements.
      if (
        q.asOf > end &&
        Math.floor(q.asOf / 60_000) !== Math.floor(end / 60_000)
      )
        break;
      next = q.nextFundingAt;
    }
    const mark = await getBoundaryMark(db, symbol, row.at);
    if (
      mark === null ||
      !Number.isSafeInteger(mark) ||
      mark <= 0 ||
      next <= row.at
    )
      break;
    applyPerpFunding(db, symbol, {
      asOf: row.at,
      rateE8: row.rateE8,
      markUnits: mark,
      nextFundingAt: next,
    });
  }
}

async function maintainSymbol(
  db: Db,
  symbol: string,
  due: number | undefined,
  hasOrders: boolean
) {
  if (due !== undefined && due <= Date.now())
    await settleDueFunding(db, symbol, due);
  // Settle funding and liquidation before discretionary orders at the same observed quote.
  const q = await getPerpQuote(db, symbol);
  if (!q || q.symbol !== symbol || !freshQuote(q)) return;
  const orderBook = await getPerpOrderBook(db, symbol);
  if (!freshQuote(q)) return;
  if (due !== undefined)
    liquidatePerpPositions(db, { ...q, orderBook: orderBook ?? undefined });
  if (!hasOrders) return;
  const instrument = await getPerpInstrument(db, symbol);
  if (!instrument || instrument.symbol !== symbol || !freshQuote(q)) return;
  const snapshot = {
    ...q,
    orderBook: orderBook ?? undefined,
    tickSizeUnits: instrument.tickSizeUnits,
    qtyStepAtoms: instrument.qtyStepUnits,
    minQtyAtoms: instrument.minQtyUnits,
    maxQtyAtoms: instrument.maxQtyUnits,
    minNotionalUnits: instrument.minNotionalUnits,
    maxLeverage: instrument.maxLeverage,
  };
  const maintenance = db
    .prepare<[string], string>("SELECT value FROM settings WHERE key=?")
    .pluck();
  const eligible = db.prepare<
    [number],
    { banned: number; onboarded: number; frozen: number }
  >(
    `SELECT u.banned, (length(trim(coalesce(u.group_name,'')))>0) AS onboarded,
       (coalesce(p.all_frozen,0) OR coalesce(p.finance_frozen,0) OR coalesce(p.entertainment_frozen,0)) AS frozen
     FROM users u LEFT JOIN user_policies p ON p.user_id=u.id WHERE u.id=?`
  );
  const guard = (id: number) => {
    const player = eligible.get(id);
    if (!player || player.banned || !player.onboarded)
      return "账户已停用或未完成注册，委托失效";
    return player.frozen ? "金融或娱乐权限已被冻结，委托失效" : null;
  };
  const attempt = db.transaction((id: number) => {
    // Hold the write lock through both the maintenance check and the engine's nested
    // transaction, so a concurrent operator update cannot race a fill. Keep orders
    // waiting during global maintenance; user-specific eligibility failures are terminal.
    if (maintenance.get(SETTING_KEYS.maintenanceMode) === "1") return false;
    matchPending(db, id, snapshot, guard);
    return true;
  });
  for (const order of pendingForSymbol(db, symbol)) {
    if (!freshQuote(q) || !attempt.immediate(order.id)) break;
  }
}

export async function refreshPerpMaintenance(db: Db) {
  const now = Date.now();
  if (active.has(db) || now < (nextRunAt.get(db) ?? 0)) return;
  // The timer and request-driven refreshes share a start-to-start interval.
  // Starting the cooldown after completion could skip the next timer tick.
  nextRunAt.set(db, now + PERP_MAINTENANCE_INTERVAL_MS);
  active.add(db);
  try {
    const holdings = db
      .prepare<[], { symbol: string; due: number }>(
        "SELECT symbol,min(next_funding_at) AS due FROM perp_positions WHERE quantity_atoms>0 GROUP BY symbol"
      )
      .all();
    const cursors = new Map(holdings.map(({ symbol, due }) => [symbol, due]));
    const pending = new Set(listPendingSymbols(db));
    const symbols = new Set([...cursors.keys(), ...pending]);
    await Promise.all(
      [...symbols].map(async symbol => {
        try {
          await maintainSymbol(
            db,
            symbol,
            cursors.get(symbol),
            pending.has(symbol)
          );
        } catch (error) {
          console.error("永续合约风险巡检等待重试", symbol, error);
        }
      })
    );
    const week = settlePerpWeeks(db);
    if (week.pendingWeek !== null && week.neededSymbols.length) {
      const boundary = week.pendingWeek + WEEK;
      for (const symbol of week.neededSymbols) {
        const mark = await getBoundaryMark(db, symbol, boundary);
        if (mark !== null) storePerpBoundaryMark(db, boundary, symbol, mark);
      }
      settlePerpWeeks(db);
    }
  } catch (error) {
    console.error("永续合约周榜等待重试", error);
  } finally {
    active.delete(db);
  }
}
