import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PERP_ENGINE_SCHEMA } from "./schema";
import {
  PERP_WEEKLY_SCHEMA,
  getPerpWeeklyBoard,
  listPerpWeeks,
  perpWeekStart,
  settlePerpWeeks,
  storePerpBoundaryMark,
} from "./weekly";

const monday = Date.parse("2026-11-02T00:00:00+08:00"),
  week = 7 * 86400000,
  grace = 300000;
const end = monday + week;
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,group_name TEXT);" +
      PERP_ENGINE_SCHEMA +
      PERP_WEEKLY_SCHEMA
  );
  for (let i = 1; i <= 6; i++)
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      i,
      "user" + i,
      "display" + i,
      "玩家" + i
    );
});
afterEach(() => db.close());
function event(
  user: number,
  at: number,
  kind: string,
  cash: number,
  symbol: string | null = null,
  margin = 0,
  basis = 0,
  quantity = 0
) {
  db.prepare(
    "INSERT INTO perp_events(user_id,created_at,kind,cash_delta_units,symbol,margin_delta_units,entry_delta_units,qty_delta_atoms) VALUES(?,?,?,?,?,?,?,?)"
  ).run(user, at, kind, cash, symbol, margin, basis, quantity);
}
const board = (
  userId: number,
  side: "profit" | "loss" = "profit",
  weekStart = monday,
  page = 1,
  pageSize = 20
) => getPerpWeeklyBoard(db, { userId, weekStart, side, page, pageSize })!;
it("archives isolated mark-to-market equity and trading/funding fees; removes gross wallet flows", () => {
  for (let id = 1; id <= 4; id++) event(id, monday, "in", 500_000);
  // One coin entered at 100 USDT, margin 25, taker fee 0.055.
  for (const id of [1, 2])
    event(
      id,
      monday + 1,
      "open",
      -25_055,
      "BTCUSDT",
      25_000,
      100_000,
      100_000_000
    );
  event(
    3,
    monday + 1,
    "open",
    -25_055,
    "BTCUSDT",
    25_000,
    -100_000,
    -100_000_000
  );
  event(1, end - 1, "funding", 0, "BTCUSDT", -100);
  event(2, end - 1, "funding", 0, "BTCUSDT", -100);
  event(4, end - 1, "out", -500_000); // full gross withdrawal, including 5% site fee
  event(2, end, "funding", 0, "BTCUSDT", -700); // belongs to next week
  expect(perpWeekStart(end - 1)).toBe(monday);
  expect(perpWeekStart(end)).toBe(end);
  expect(settlePerpWeeks(db, end + grace - 1).published).toBe(0);
  expect(settlePerpWeeks(db, end + grace)).toMatchObject({
    published: 0,
    pendingWeek: monday,
    neededSymbols: ["BTCUSDT"],
  });
  expect(listPerpWeeks(db)).toMatchObject({ total: 0, pendingWeek: monday });
  storePerpBoundaryMark(db, end, "BTCUSDT", 110_000);
  expect(settlePerpWeeks(db, end + grace).published).toBe(1);
  expect(board(2, "profit", monday, 2, 1)).toMatchObject({
    total: 2,
    rows: [{ userId: 2, rank: 1, pnlUnits: 9845 }],
    mine: { rank: 1, pnlUnits: 9845 },
  });
  expect(board(3, "loss")).toMatchObject({
    total: 1,
    mine: { rank: 1, pnlUnits: -10055 },
  });
  expect(board(4).mine).toMatchObject({ pnlUnits: 0, rank: null });
  storePerpBoundaryMark(db, end + week, "BTCUSDT", 105_000);
  expect(settlePerpWeeks(db, end + week + grace).published).toBe(1);
  expect(board(1, "loss", end).mine?.pnlUnits).toBe(-5000);
  expect(board(2, "loss", end).mine?.pnlUnits).toBe(-5700);
  expect(board(3, "profit", end).mine?.pnlUnits).toBe(5000);
  db.prepare("UPDATE users SET group_name='新昵称' WHERE id=2").run();
  storePerpBoundaryMark(db, end, "BTCUSDT", 1);
  expect(board(2).mine).toMatchObject({ displayName: "玩家2", pnlUnits: 9845 });
  expect(listPerpWeeks(db, { limit: 1, offset: 1 }).weeks[0].weekStart).toBe(
    monday
  );
});
it("keeps waiting for true funding before publishing a week; a funding deadline at 00:00 belongs to next week", () => {
  event(1, monday, "in", 20_000);
  event(1, monday + 2, "open", -20_000, "ETHUSDT", 20_000, 50_000, 100_000_000);
  db.prepare(
    "INSERT INTO perp_positions VALUES(1,'ETHUSDT','long',100000000,50000,20000,2,?,?,?)"
  ).run(monday + 2, monday + 2, end - 5000);
  storePerpBoundaryMark(db, end, "ETHUSDT", 1000);
  expect(settlePerpWeeks(db, end + grace)).toMatchObject({
    published: 0,
    reason: "等待历史资金费结算",
  });
  event(1, end - 5000, "funding", 0, "ETHUSDT", -10);
  db.prepare("UPDATE perp_positions SET next_funding_at=?").run(end);
  expect(settlePerpWeeks(db, end + grace).published).toBe(1);
  expect(board(1, "loss").mine?.pnlUnits).toBe(-20_000); // collateral lost, no cross-margin debt
});
it("replays a closed position without a weekly mark and pays fees once", () => {
  event(1, monday, "in", 100_000);
  event(1, monday + 1, "open", -10_050, "ETHUSDT", 10_000, 50_000, 20_000_000);
  event(
    1,
    monday + 2,
    "close",
    14_950,
    "ETHUSDT",
    -10_000,
    -50_000,
    -20_000_000
  );
  event(1, monday + 3, "out", -104_900);
  expect(settlePerpWeeks(db, end + grace).published).toBe(1);
  expect(board(1).mine?.pnlUnits).toBe(4900);
  expect(settlePerpWeeks(db, end + grace).published).toBe(0);
});
it("retries failed archive transactions and catches up empty weeks in bounded batches", () => {
  event(1, monday, "in", 5_000);
  db.exec(
    "CREATE TRIGGER interrupt BEFORE INSERT ON perp_week_results BEGIN SELECT RAISE(ABORT,'testing'); END"
  );
  expect(() => settlePerpWeeks(db, end + grace)).toThrow("testing");
  expect(listPerpWeeks(db).total).toBe(0);
  db.exec("DROP TRIGGER interrupt");
  expect(settlePerpWeeks(db, monday + 6 * week + grace).published).toBe(4);
  expect(settlePerpWeeks(db, monday + 6 * week + grace).published).toBe(2);
  expect(listPerpWeeks(db).total).toBe(6);
});
