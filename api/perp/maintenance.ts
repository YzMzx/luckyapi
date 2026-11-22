import type Database from "better-sqlite3";
import { applyPerpFunding, liquidatePerpPositions } from "./engine";
import { getBoundaryMark, getFundingHistory, getPerpQuote } from "./market";
import { settlePerpWeeks, storePerpBoundaryMark } from "./weekly";

type Db = Database.Database;
const WEEK = 7 * 86_400_000;
const FRESH_MS = 5_000;
const RETRY_MS = 5_000;
const active = new WeakSet<Db>();
const retryAt = new WeakMap<Db, number>();

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

async function maintainSymbol(db: Db, symbol: string, due: number) {
  if (due <= Date.now()) await settleDueFunding(db, symbol, due);
  // The engine checks each position's due cursor again in the liquidation transaction.
  const q = await getPerpQuote(db, symbol);
  if (q && q.symbol === symbol && freshQuote(q)) liquidatePerpPositions(db, q);
}

export async function refreshPerpMaintenance(db: Db) {
  if (active.has(db) || Date.now() < (retryAt.get(db) ?? 0)) return;
  active.add(db);
  try {
    const holdings = db
      .prepare<[], { symbol: string; due: number }>(
        "SELECT symbol,min(next_funding_at) AS due FROM perp_positions WHERE quantity_atoms>0 GROUP BY symbol"
      )
      .all();
    await Promise.all(
      holdings.map(async ({ symbol, due }) => {
        try {
          await maintainSymbol(db, symbol, due);
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
    retryAt.set(db, Date.now() + RETRY_MS);
    active.delete(db);
  }
}
