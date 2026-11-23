import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  SevenPickInsufficientFundsError,
  applySevenPickCash,
  readSevenPickCash,
  type SevenPickCashChange,
} from "../seven-pick/wallet";
import { PERP_ENGINE_SCHEMA } from "./schema";
import { changePerpCash } from "./wallet";
import { seedGameBet, seedGameRound } from "./wallet-fixture";
import {
  PERP_WEEKLY_SCHEMA,
  getPerpWeeklyBoard,
  settlePerpWeeks,
  storePerpBoundaryMark,
} from "./weekly";

const start = Date.parse("2026-11-02T00:00:00+08:00");
const week = 7 * 86_400_000;
const end = start + week;
const grace = 300_000;
let db: Database.Database;
function initialize(testDb: Database.Database) {
  testDb.exec(
    "CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,group_name TEXT);" +
      PERP_ENGINE_SCHEMA +
      PERP_WEEKLY_SCHEMA +
      "INSERT INTO users(id,username) VALUES (1,'One'),(2,'Two');"
  );
  seedGameRound(testDb, start);
}
beforeEach(() => {
  db = new Database(":memory:");
  initialize(db);
});
afterEach(() => db.close());

function mutation(
  betId: number,
  deltaUnits: number,
  fields: Partial<SevenPickCashChange> = {}
): SevenPickCashChange {
  return {
    roundId: 1,
    betId,
    userId: 1,
    deltaUnits,
    kind: "stake",
    now: start,
    ...fields,
  };
}
function apply(input: SevenPickCashChange, connection = db) {
  return connection
    .transaction(() => applySevenPickCash(connection, input))
    .immediate();
}
function ledgerCount(db: Database.Database) {
  return db.prepare("SELECT count(*) FROM seven_pick_ledger").pluck().get();
}
function event(
  kind: string,
  delta: number,
  now = start,
  symbol: string | null = null,
  margin = 0,
  basis = 0,
  qty = 0
) {
  db.transaction(() => {
    changePerpCash(db, 1, delta);
    db.prepare(
      `INSERT INTO perp_events(user_id,symbol,kind,cash_delta_units,margin_delta_units,entry_delta_units,qty_delta_atoms,created_at)
      VALUES(1,?,?,?,?,?,?,?)`
    ).run(symbol, kind, delta, margin, basis, qty, now);
  }).immediate();
}

it("requires an outer write transaction and makes a multi-bet debit all-or-nothing", () => {
  event("in", 1500);
  expect(() => applySevenPickCash(db, mutation(1, -1000))).toThrow("写事务");
  expect(() =>
    db
      .transaction(() => {
        seedGameBet(db, 1, 1, 1000, start);
        seedGameBet(db, 2, 1, 1000, start);
        applySevenPickCash(db, mutation(1, -1000));
        applySevenPickCash(db, mutation(2, -1000));
      })
      .immediate()
  ).toThrow(SevenPickInsufficientFundsError);
  expect(readSevenPickCash(db, 1)).toBe(1500);
  expect(ledgerCount(db)).toBe(0);
  expect(db.prepare("SELECT count(*) FROM seven_pick_bets").pluck().get()).toBe(
    0
  );
});

it("keeps refunds exact, idempotent and exclusive with payouts", () => {
  event("in", 3000);
  seedGameBet(db, 1, 1, 1000, start);
  expect(() => apply(mutation(1, 1000, { kind: "refund" }))).toThrow(
    "扣款流水无效"
  );
  expect(() => apply(mutation(1, -1000, { userId: 2 }))).toThrow("投注不存在");
  expect(apply(mutation(1, -1000))).toEqual({ applied: true, cashUnits: 2000 });
  expect(apply(mutation(1, -1000))).toEqual({
    applied: false,
    cashUnits: 2000,
  });
  expect(() => apply(mutation(1, -1001))).toThrow("幂等参数冲突");
  expect(() => apply(mutation(1, 1001, { kind: "refund" }))).toThrow(
    "本金不符"
  );
  const refund = mutation(1, 1000, { kind: "refund" });
  expect(apply(refund)).toEqual({ applied: true, cashUnits: 3000 });
  expect(apply({ ...refund, now: start + 1 })).toEqual({
    applied: false,
    cashUnits: 3000,
  });
  expect(() => apply(mutation(1, 50_000_000, { kind: "payout" }))).toThrow(
    "已完成资金处理"
  );
  expect(ledgerCount(db)).toBe(2);
  expect(db.prepare("SELECT count(*) FROM perp_events").pluck().get()).toBe(1);
});

it("rolls back wallet mutation when ledger insertion fails, even if the caller catches the error", () => {
  event("in", 2000);
  seedGameBet(db, 1, 1, 1000, start);
  db.exec(`CREATE TRIGGER fail_ledger BEFORE INSERT ON seven_pick_ledger
     BEGIN SELECT RAISE(ABORT,'ledger unavailable'); END`);
  db.transaction(() => {
    expect(() => applySevenPickCash(db, mutation(1, -1000))).toThrow(
      "ledger unavailable"
    );
  }).immediate();
  expect(readSevenPickCash(db, 1)).toBe(2000);
  expect(ledgerCount(db)).toBe(0);
});

it("does not permit competing SQLite connections to spend the same shared balance", () => {
  const directory = mkdtempSync(join(tmpdir(), "luckyapi-wallet-"));
  const path = join(directory, "perp.db");
  const first = new Database(path);
  const second = new Database(path, { timeout: 0 });
  try {
    first.pragma("journal_mode=WAL");
    initialize(first);
    first.transaction(() => changePerpCash(first, 1, 1500)).immediate();
    seedGameBet(first, 1, 1, 1000, start);
    first
      .transaction(() => {
        // Model a competing perp debit while a game request obtained the writer lock.
        applySevenPickCash(first, mutation(1, -1000));
        expect(readSevenPickCash(second, 1)).toBe(1500);
        expect(() =>
          second.transaction(() => changePerpCash(second, 1, -1000)).immediate()
        ).toThrow(expect.objectContaining({ code: "SQLITE_BUSY" }));
      })
      .immediate();
    expect(() =>
      second.transaction(() => changePerpCash(second, 1, -1000)).immediate()
    ).toThrow("可用模拟金不足");
    expect(readSevenPickCash(second, 1)).toBe(500);
    expect(ledgerCount(second)).toBe(1);
  } finally {
    second.close();
    first.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

it("rejects a credit that would overflow a shared wallet", () => {
  db.transaction(() => changePerpCash(db, 1, Number.MAX_SAFE_INTEGER)).immediate();
  expect(() =>
    db.transaction(() => changePerpCash(db, 1, 1)).immediate()
  ).toThrow("超出有效范围");
  expect(readSevenPickCash(db, 1)).toBe(Number.MAX_SAFE_INTEGER);
});

it("uses game cash for cross-week equity and redemptions but never attributes it to trading PnL", () => {
  event("in", 100_000);
  event("open", -25_055, start + 1, "BTCUSDT", 25_000, 100_000, 100_000_000);
  seedGameBet(db, 1, 1, 1000, start + 1);
  seedGameBet(db, 2, 1, 1000, start + 1);
  apply(mutation(1, -1000, { now: start + 1 }));
  apply(mutation(2, -1000, { now: start + 1 }));
  const cashAtEnd = readSevenPickCash(db, 1);
  const payout = 50_000_000;
  expect(apply(mutation(1, payout, { kind: "payout", now: end })).applied).toBe(
    true
  );
  expect(apply(mutation(2, 1000, { kind: "refund", now: end })).applied).toBe(
    true
  );
  event("out", -payout, end); // fails replay without the independent payout flow
  storePerpBoundaryMark(db, end, "BTCUSDT", 110_000);
  expect(settlePerpWeeks(db, end + grace).published).toBe(1);
  seedGameBet(db, 3, 1, 1000, end);
  expect(() => apply(mutation(3, -1000, { now: end - 1 }))).toThrow("已发布");
  storePerpBoundaryMark(db, end + week, "BTCUSDT", 105_000);
  expect(settlePerpWeeks(db, end + week + grace).published).toBe(1);
  expect(
    db
      .prepare(
        `SELECT cash_units,opening_units,closing_units,in_units,out_units,pnl_units
    FROM perp_week_results ORDER BY week_start`
      )
      .all()
  ).toEqual([
    {
      cash_units: cashAtEnd,
      opening_units: 0,
      closing_units: cashAtEnd + 35_000,
      in_units: 100_000,
      out_units: 0,
      pnl_units: 9_945,
    },
    {
      cash_units: readSevenPickCash(db, 1),
      opening_units: cashAtEnd + 35_000,
      closing_units: readSevenPickCash(db, 1) + 30_000,
      in_units: 0,
      out_units: payout,
      pnl_units: -5_000,
    },
  ]);
  expect(
    getPerpWeeklyBoard(db, { weekStart: end, side: "loss", userId: 1 })?.mine
  ).toMatchObject({ pnlUnits: -5_000, rank: 1 });
});
