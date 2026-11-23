import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  consumePerpDepth,
  isFreshPerpOrderBook,
  observePerpDepth,
  previewPerpDepth,
  quoteObservedPerpDepth,
  walkPerpDepth,
  type PerpOrderBook,
} from "./depth";
import { PERP_ENGINE_SCHEMA } from "./schema";

const Q = 100_000_000;
const level = (priceUnits: number, quantityAtoms: number) => ({
  priceUnits,
  quantityAtoms,
});
function depth(asOf = Date.now()): PerpOrderBook {
  return {
    symbol: "BTCUSDT",
    asOf,
    sequence: 100,
    bids: [level(99_999, Q), level(99_500, Q), level(99_499, Q)],
    asks: [
      level(100_000, (Q * 3) / 2),
      level(100_001, Q * 2),
      level(100_500, Q),
      level(100_501, Q),
    ],
  };
}

it("derives notional from the sum of raw level products, not the rounded VWAP", () => {
  const q = depth();
  expect(walkPerpDepth(q, { side: "buy", quantityAtoms: 3 * Q })).toEqual({
    requestedQuantityAtoms: 3 * Q,
    quantityAtoms: 3 * Q,
    priceUnits: 100_001,
    notionalUnits: 300_001,
    worstPriceUnits: 100_001,
    fills: [level(100_000, (Q * 3) / 2), level(100_001, (Q * 3) / 2)],
  });
  const fractions = {
    ...q,
    asks: [level(100_001, Q / 2), level(100_003, Q / 2)],
  };
  expect(
    walkPerpDepth(fractions, { side: "buy", quantityAtoms: Q })?.notionalUnits
  ).toBe(100_002);
});

it("enforces both sides of exact bps and limit boundaries without resetting the original best", () => {
  const q = depth();
  const input = { side: "buy", quantityAtoms: 5 * Q } as const;
  const consumed = new Map([
    [100_000, (Q * 3) / 2],
    [100_001, 2 * Q],
  ]);
  expect(walkPerpDepth(q, input, consumed)).toMatchObject({
    quantityAtoms: Q,
    worstPriceUnits: 100_500,
  });
  expect(
    walkPerpDepth(q, { ...input, slippageBps: 51 }, consumed)
  ).toMatchObject({ quantityAtoms: 2 * Q, worstPriceUnits: 100_501 });
  expect(
    walkPerpDepth(
      q,
      { ...input, slippageBps: 1000, limitPriceUnits: 100_499 },
      consumed
    )
  ).toMatchObject({ quantityAtoms: 0 });
  expect(
    walkPerpDepth(q, { side: "sell", quantityAtoms: 3 * Q })
  ).toMatchObject({ quantityAtoms: 2 * Q, worstPriceUnits: 99_500 });
  expect(
    walkPerpDepth(q, {
      side: "sell",
      quantityAtoms: 3 * Q,
      limitPriceUnits: 99_501,
    })
  ).toMatchObject({ quantityAtoms: Q });
});

it("rounds partial quantity down to a lot without discarding better price atoms", () => {
  const q = { ...depth(), asks: [level(100_000, 7), level(100_100, 5)] };
  expect(
    walkPerpDepth(q, { side: "buy", quantityAtoms: 20, qtyStepAtoms: 5 })
  ).toMatchObject({
    quantityAtoms: 10,
    fills: [level(100_000, 7), level(100_100, 3)],
  });
});

it("rejects old, invalid, crossed and wrong-symbol books", () => {
  const q = depth();
  expect(isFreshPerpOrderBook(q, q.symbol)).toBe(true);
  for (const invalid of [
    { ...q, asOf: q.asOf - 5000 },
    { ...q, asOf: Date.now() + 1000 },
    { ...q, symbol: "ETHUSDT" },
    { ...q, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...q, bids: [level(100_001, Q)] },
    { ...q, asks: [] },
    { ...q, asks: [...q.asks].reverse() },
    { ...q, asks: [level(100_000, -1)] },
  ])
    expect(isFreshPerpOrderBook(invalid, q.symbol)).toBe(false);
});

it("keeps consumption and sequence identity across connections, including rollback and replay", () => {
  const dir = mkdtempSync(join(tmpdir(), "lucky-perp-depth-"));
  const filename = join(dir, "test.db");
  const writer = new Database(filename);
  const other = new Database(filename);
  try {
    writer.exec(PERP_ENGINE_SCHEMA);
    const q = depth();
    const input = { side: "buy", quantityAtoms: 3 * Q } as const;
    expect(previewPerpDepth(other, q, input)?.quantityAtoms).toBe(3 * Q);
    expect(
      writer.prepare("SELECT COUNT(*) FROM perp_depth_cursors").pluck().get()
    ).toBe(0);
    const execute = (db: Database.Database, fail = false) =>
      db
        .transaction(() => {
          expect(observePerpDepth(db, q)).toBe(true);
          consumePerpDepth(
            db,
            q.symbol,
            input.side,
            quoteObservedPerpDepth(db, q, input)!
          );
          if (fail) throw new Error("rollback");
        })
        .immediate();
    expect(() => execute(writer, true)).toThrow("rollback");
    expect(previewPerpDepth(other, q, input)?.quantityAtoms).toBe(3 * Q);
    execute(writer);
    expect(previewPerpDepth(other, q, input)).toMatchObject({
      quantityAtoms: (Q * 3) / 2,
      fills: [level(100_001, Q / 2), level(100_500, Q)],
    });
    const relabeled = {
      ...q,
      asks: [level(100_000, 9 * Q), ...q.asks.slice(1)],
    };
    expect(previewPerpDepth(other, relabeled, input)).toBeNull();
    const next = { ...q, sequence: q.sequence + 1 };
    other
      .transaction(() => expect(observePerpDepth(other, next)).toBe(true))
      .immediate();
    expect(previewPerpDepth(writer, q, input)).toBeNull();
    expect(previewPerpDepth(writer, next, input)?.quantityAtoms).toBe(3 * Q);
    expect(
      previewPerpDepth(
        writer,
        { ...next, sequence: next.sequence + 1, asOf: q.asOf - 1 },
        input
      )
    ).toBeNull();
  } finally {
    writer.close();
    other.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
