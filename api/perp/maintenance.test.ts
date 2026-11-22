import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PERP_ENGINE_SCHEMA } from "./schema";
import { PERP_WEEKLY_SCHEMA, listPerpWeeks } from "./weekly";
import { refreshPerpMaintenance } from "./maintenance";
import { getPerpQuote, getFundingHistory, getBoundaryMark } from "./market";
vi.mock("./market", () => ({
  getPerpQuote: vi.fn(),
  getBoundaryMark: vi.fn(),
  getFundingHistory: vi.fn(),
}));
const monday = Date.parse("2026-11-02T00:00:00+08:00"),
  week = 7 * 86400000;
const symbol = "BTCUSDT";
let db: Database.Database;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(monday);
  vi.resetAllMocks();
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,group_name TEXT); INSERT INTO users VALUES(1,'trader','','');" +
      PERP_ENGINE_SCHEMA +
      PERP_WEEKLY_SCHEMA
  );
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
});
function position(next: number) {
  db.prepare(
    "INSERT INTO perp_positions VALUES(1,?,'long',100000000,100000,30000,5,?,?,?)"
  ).run(symbol, monday, monday, next);
  db.prepare(
    "INSERT INTO perp_events(user_id,kind,cash_delta_units,margin_delta_units,entry_delta_units,qty_delta_atoms,created_at) VALUES(1,'in',100000,0,0,0,?)"
  ).run(monday);
  db.prepare(
    "INSERT INTO perp_events(user_id,symbol,kind,cash_delta_units,margin_delta_units,entry_delta_units,qty_delta_atoms,created_at) VALUES(1,?,'open',-30055,30000,100000,100000000,?)"
  ).run(symbol, monday + 1);
}
function quote(mark: number, asOf: number, nextFundingAt: number) {
  return {
    symbol,
    bidUnits: mark - 1,
    askUnits: mark + 1,
    markUnits: mark,
    lastUnits: mark,
    asOf,
    fundingRateE8: 100000,
    nextFundingAt,
  };
}
it("requires valid and fresh mark prices for forced closure", async () => {
  position(monday + 3600000);
  vi.setSystemTime(monday + 10000);
  vi.mocked(getPerpQuote).mockResolvedValue(
    quote(1000, monday, monday + 3600000)
  );
  await refreshPerpMaintenance(db);
  expect(db.prepare("SELECT count(*) FROM perp_orders").pluck().get()).toBe(0);
  vi.setSystemTime(monday + 20000);
  vi.mocked(getPerpQuote).mockResolvedValue(
    quote(1000, Date.now(), monday + 3600000)
  );
  await refreshPerpMaintenance(db);
  expect(db.prepare("SELECT action FROM perp_orders").pluck().all()).toEqual([
    "liquidate",
  ]);
  expect(db.prepare("SELECT count(*) FROM perp_positions").pluck().get()).toBe(
    0
  );
});
it("publishes after confirming the week mark and overdue funding, with retry on missing rates", async () => {
  const end = monday + week,
    due = end - 60000,
    now = end + 6 * 60000;
  position(due);
  vi.setSystemTime(now);
  vi.mocked(getPerpQuote).mockImplementation(async () =>
    quote(103000, Date.now(), end + 3600000)
  );
  vi.mocked(getFundingHistory).mockResolvedValue(null);
  await refreshPerpMaintenance(db);
  expect(listPerpWeeks(db)).toMatchObject({ total: 0, pendingWeek: monday });
  vi.setSystemTime(now + 10000);
  vi.mocked(getFundingHistory).mockResolvedValue([{ at: due, rateE8: 100000 }]);
  vi.mocked(getBoundaryMark).mockImplementation(async (_db, _symbol, at) =>
    at === due ? 100000 : at === end ? 103000 : null
  );
  await refreshPerpMaintenance(db);
  expect(
    db.prepare("SELECT amount_units FROM perp_funding").pluck().all()
  ).toEqual([-100]);
  expect(
    db.prepare("SELECT pnl_units FROM perp_week_results").pluck().all()
  ).toEqual([2845]);
  vi.setSystemTime(now + 20000);
  await refreshPerpMaintenance(db);
  expect(db.prepare("SELECT count(*) FROM perp_funding").pluck().get()).toBe(1);
  expect(listPerpWeeks(db).total).toBe(1);
});
