import type Database from "better-sqlite3";
import { getPerpQuote, type PerpQuote } from "./market";

const QUANTITY_SCALE = 100_000_000n;
export type PositionForValuation = {
  symbol: string;
  side: "long" | "short";
  quantityAtoms: number;
  entryUnits: number;
  updatedAt: number;
};

export async function loadPositionQuotes(
  db: Database.Database,
  rows: readonly PositionForValuation[]
) {
  return new Map(
    await Promise.all(
      [...new Set(rows.map(row => row.symbol))].map(
        async symbol =>
          [symbol, await getPerpQuote(db, symbol).catch(() => null)] as const
      )
    )
  );
}

export function valueOpenPosition(
  row: PositionForValuation,
  quote: PerpQuote | null | undefined,
  now: number
) {
  if (
    !quote ||
    quote.asOf < row.updatedAt ||
    quote.asOf > now ||
    now - quote.asOf >= 5_000
  )
    return null;
  const value =
    (BigInt(row.quantityAtoms) * BigInt(quote.markUnits)) / QUANTITY_SCALE;
  const pnl =
    (value - BigInt(row.entryUnits)) * (row.side === "long" ? 1n : -1n);
  return { markPriceUnits: quote.markUnits, pnl };
}
