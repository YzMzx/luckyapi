import type Database from "better-sqlite3";

export type PerpOrderBookLevel = { priceUnits: number; quantityAtoms: number };
export type PerpOrderBook = {
  symbol: string;
  asOf: number;
  sequence: number;
  bids: readonly PerpOrderBookLevel[];
  asks: readonly PerpOrderBookLevel[];
};
type Side = "buy" | "sell";
type DepthInput = {
  side: Side;
  quantityAtoms: number;
  qtyStepAtoms?: number;
  slippageBps?: number;
  limitPriceUnits?: number;
};
export type PerpDepthFill = {
  requestedQuantityAtoms: number;
  quantityAtoms: number;
  notionalUnits: number;
  priceUnits: number | null;
  worstPriceUnits: number | null;
  fills: PerpOrderBookLevel[];
};

export const DEFAULT_PERP_SLIPPAGE_BPS = 50;
const FRESH_MS = 5000;
const SCALE = 100_000_000n;
const BPS = 10_000n;
const MAX_LEVELS = 50;
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
export function validPerpSlippageBps(value: number) {
  return positive(value) && value <= 1000;
}

export function isFreshPerpOrderBook(
  book: PerpOrderBook | null | undefined,
  symbol: string,
  now = Date.now()
): book is PerpOrderBook {
  if (
    !book ||
    book.symbol !== symbol ||
    !positive(book.asOf) ||
    !positive(book.sequence) ||
    book.asOf > now ||
    now - book.asOf >= FRESH_MS
  )
    return false;
  for (const [levels, buy] of [
    [book.asks, true],
    [book.bids, false],
  ] as const) {
    if (!Array.isArray(levels) || !levels.length || levels.length > MAX_LEVELS)
      return false;
    let prev: number | undefined;
    for (const level of levels) {
      if (
        !level ||
        !positive(level.priceUnits) ||
        !positive(level.quantityAtoms) ||
        (prev !== undefined &&
          (buy ? prev >= level.priceUnits : prev <= level.priceUnits))
      )
        return false;
      prev = level.priceUnits;
    }
  }
  return book.bids[0]!.priceUnits <= book.asks[0]!.priceUnits;
}

// Pure price-time allocation. Reference the *original* best level so consuming
// the best liquidity cannot reset a market order's slippage guard on this book.
export function walkPerpDepth(
  book: PerpOrderBook,
  input: DepthInput,
  consumed: ReadonlyMap<number, number> = new Map(),
  unbounded = false
): PerpDepthFill | null {
  const qty = input.quantityAtoms;
  const step = input.qtyStepAtoms ?? 1;
  const slip = input.slippageBps ?? DEFAULT_PERP_SLIPPAGE_BPS;
  const limit = input.limitPriceUnits;
  if (
    !positive(qty) ||
    !positive(step) ||
    qty % step !== 0 ||
    !validPerpSlippageBps(slip) ||
    (limit !== undefined && !positive(limit)) ||
    !(input.side === "buy" || input.side === "sell")
  )
    return null;
  const buy = input.side === "buy";
  const levels = buy ? book.asks : book.bids;
  const reference = BigInt(levels[0]!.priceUnits);
  const bound = reference * (BPS + BigInt(buy ? slip : -slip));
  const fills: PerpOrderBookLevel[] = [];
  let remaining = qty;
  let raw = 0n;
  for (const { priceUnits, quantityAtoms } of levels) {
    const price = BigInt(priceUnits);
    if (
      limit !== undefined
        ? buy
          ? priceUnits > limit
          : priceUnits < limit
        : !unbounded && (buy ? price * BPS > bound : price * BPS < bound)
    )
      break;
    const available = quantityAtoms - (consumed.get(priceUnits) ?? 0);
    if (available <= 0) continue;
    const take = Math.min(remaining, available);
    fills.push({ priceUnits, quantityAtoms: take });
    raw += price * BigInt(take);
    remaining -= take;
    if (remaining === 0) break;
  }
  // Align the *aggregate* partial fill to the contract lot, not each level.
  // Trim from the tail to preserve priority for every atom at the best prices.
  let trim = (qty - remaining) % step;
  remaining += trim;
  while (trim > 0) {
    const tail = fills[fills.length - 1]!;
    const drop = Math.min(trim, tail.quantityAtoms);
    raw -= BigInt(drop) * BigInt(tail.priceUnits);
    trim -= drop;
    tail.quantityAtoms -= drop;
    if (!tail.quantityAtoms) fills.pop();
  }
  const filled = qty - remaining;
  const notionalUnits = Number(raw / SCALE);
  if (!Number.isSafeInteger(notionalUnits)) return null;
  return {
    requestedQuantityAtoms: qty,
    quantityAtoms: filled,
    notionalUnits,
    priceUnits: filled
      ? Number((raw + BigInt(filled) / 2n) / BigInt(filled))
      : null,
    worstPriceUnits: fills[fills.length - 1]?.priceUnits ?? null,
    fills,
  };
}

type Db = Database.Database;
type Cursor = { sequence: number; asOf: number; contents: string };
function classify(db: Db, book: PerpOrderBook) {
  const prev = db
    .prepare<[string], Cursor>(
      "SELECT sequence,as_of AS asOf,contents FROM perp_depth_cursors WHERE symbol=?"
    )
    .get(book.symbol);
  const contents = JSON.stringify(
    [book.bids, book.asks].map(levels =>
      levels.map(level => [level.priceUnits, level.quantityAtoms])
    )
  );
  if (!prev || (book.sequence > prev.sequence && book.asOf >= prev.asOf))
    return { state: "new", contents } as const;
  if (
    book.sequence === prev.sequence &&
    book.asOf === prev.asOf &&
    contents === prev.contents
  )
    return { state: "same", contents } as const;
  return { state: "old", contents } as const;
}

// Call from an immediate transaction. Keep just the newest valid book and its
// per-side fills (bounded by the external book size), never resurrect depth from
// an older sequence, or trust changed levels relabelled as the same snapshot.
export function observePerpDepth(db: Db, book: PerpOrderBook) {
  if (!db.inTransaction)
    throw new Error("Perp depth requires a write transaction");
  const { state, contents } = classify(db, book);
  if (state === "old") return false;
  if (state === "new") {
    db.prepare("DELETE FROM perp_depth_consumption WHERE symbol=?").run(
      book.symbol
    );
    db.prepare(
      "INSERT INTO perp_depth_cursors(symbol,sequence,as_of,contents) VALUES (?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET sequence=excluded.sequence,as_of=excluded.as_of,contents=excluded.contents"
    ).run(book.symbol, book.sequence, book.asOf, contents);
  }
  return true;
}
function availableFill(
  db: Db,
  book: PerpOrderBook,
  input: DepthInput,
  unbounded = false
) {
  const rows = db
    .prepare<[string, Side], PerpOrderBookLevel>(
      "SELECT price_units AS priceUnits,quantity_atoms AS quantityAtoms FROM perp_depth_consumption WHERE symbol=? AND side=?"
    )
    .all(book.symbol, input.side);
  return walkPerpDepth(
    book,
    input,
    new Map(rows.map(r => [r.priceUnits, r.quantityAtoms])),
    unbounded
  );
}

// Read-only view. A fill must still reprice and recheck inside its own transaction.
export function previewPerpDepth(
  db: Db,
  book: PerpOrderBook,
  input: DepthInput
) {
  if (!isFreshPerpOrderBook(book, book.symbol)) return null;
  return db.transaction(() => {
    const { state } = classify(db, book);
    if (state === "old") return null;
    return state === "new"
      ? walkPerpDepth(book, input)
      : availableFill(db, book, input);
  })();
}

// Only execution calls this, after observing the book in the same transaction.
export function quoteObservedPerpDepth(
  db: Db,
  book: PerpOrderBook,
  input: DepthInput,
  unbounded = false
) {
  return availableFill(db, book, input, unbounded);
}
export function consumePerpDepth(
  db: Db,
  symbol: string,
  side: Side,
  fill: PerpDepthFill
) {
  if (!db.inTransaction)
    throw new Error("Perp depth requires a write transaction");
  const stmt = db.prepare(
    "INSERT INTO perp_depth_consumption(symbol,side,price_units,quantity_atoms) VALUES(?,?,?,?) ON CONFLICT(symbol,side,price_units) DO UPDATE SET quantity_atoms=quantity_atoms+excluded.quantity_atoms"
  );
  for (const { priceUnits, quantityAtoms } of fill.fills)
    stmt.run(symbol, side, priceUnits, quantityAtoms);
}
