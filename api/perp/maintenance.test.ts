import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PERP_ENGINE_SCHEMA } from "./schema";
import { PERP_WEEKLY_SCHEMA, listPerpWeeks } from "./weekly";
import { refreshPerpMaintenance } from "./maintenance";
import {
  getPerpInstrument,
  getPerpQuote,
  getFundingHistory,
  getBoundaryMark,
} from "./market";
vi.mock("./market", () => ({
  getPerpInstrument: vi.fn(),
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
    "CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,group_name TEXT,banned INTEGER DEFAULT 0); INSERT INTO users VALUES(1,'trader','','owner',0);" +
      "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE user_policies(user_id INTEGER PRIMARY KEY,all_frozen INTEGER DEFAULT 0,finance_frozen INTEGER DEFAULT 0,entertainment_frozen INTEGER DEFAULT 0);" +
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
  vi.setSystemTime(monday + 14_999);
  await refreshPerpMaintenance(db);
  expect(getPerpQuote).toHaveBeenCalledTimes(1);
  expect(db.prepare("SELECT count(*) FROM perp_orders").pluck().get()).toBe(0);
  vi.setSystemTime(monday + 15_000);
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
  vi.setSystemTime(now + 5_000);
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
  vi.setSystemTime(now + 10_000);
  await refreshPerpMaintenance(db);
  expect(db.prepare("SELECT count(*) FROM perp_funding").pluck().get()).toBe(1);
  expect(listPerpWeeks(db).total).toBe(1);
});
function waitingOrder() {
  const key = "integration-order-key";
  db.prepare(
    "INSERT INTO perp_wallets(user_id,cash_units) VALUES (1,1000000)"
  ).run();
  db.prepare(
    "INSERT INTO perp_pending_orders(user_id,request_key,symbol,action,side,order_type,quantity_atoms,leverage,limit_price_units,created_at,updated_at,last_quote_at,status) VALUES(1,?,?,'openLong','long','limit',100000000,2,101000,?,?,?,'pending')"
  ).run(key, symbol, monday, monday, monday);
  vi.mocked(getPerpInstrument).mockResolvedValue({
    symbol,
    tickSizeUnits: 1,
    qtyStepUnits: 1000,
    minQtyUnits: 1000,
    maxQtyUnits: 1e10,
    minNotionalUnits: 1000,
    maxLeverage: 10,
    fundingIntervalMs: 8 * 3600000,
  });
  vi.mocked(getPerpQuote).mockImplementation(async () =>
    quote(100000, Date.now(), monday + 3600000)
  );
}
function orderStatus() {
  return db.prepare("SELECT status FROM perp_pending_orders").pluck().get();
}
it("matches a stored limit order without a held position only after maintenance ends and a fresh quote arrives", async () => {
  vi.stubEnv("PERP_TRADING_ENABLED", "1");
  try {
    waitingOrder();
    vi.setSystemTime(monday + 1000);
    db.prepare("INSERT INTO settings VALUES('control_maintenance','1')").run();
    await refreshPerpMaintenance(db);
    expect(orderStatus()).toBe("pending");
    db.prepare(
      "UPDATE settings SET value='0' WHERE key='control_maintenance'"
    ).run();
    vi.setSystemTime(monday + 5_999);
    await refreshPerpMaintenance(db);
    expect(getPerpQuote).toHaveBeenCalledTimes(1);
    expect(orderStatus()).toBe("pending");
    vi.setSystemTime(monday + 6_000);
    vi.mocked(getPerpQuote).mockResolvedValueOnce(
      quote(100000, monday + 500, monday + 3600000)
    );
    await refreshPerpMaintenance(db);
    expect(orderStatus()).toBe("pending");
    vi.setSystemTime(monday + 11_000);
    await refreshPerpMaintenance(db);
    expect(orderStatus()).toBe("filled");
    vi.setSystemTime(monday + 16_000);
    await refreshPerpMaintenance(db);
    expect(
      db.prepare("SELECT price_units FROM perp_orders").pluck().all()
    ).toEqual([100001]);
  } finally {
    vi.unstubAllEnvs();
  }
});
it("settles outstanding funding and liquidates before processing a close order on the same position", async () => {
  const due = monday + 10000;
  position(due);
  waitingOrder();
  db.prepare(
    "UPDATE perp_pending_orders SET action='close',side='long',limit_price_units=1"
  ).run();
  // A real reduce-only order carries the identity of the position it was submitted against.
  db.prepare("INSERT INTO perp_pending_position_bindings(pending_id,opened_at) SELECT id,? FROM perp_pending_orders").run(monday);
  vi.setSystemTime(due + 100);
  vi.mocked(getPerpQuote).mockImplementation(async () =>
    quote(1000, Date.now(), monday + 3600000)
  );
  vi.mocked(getFundingHistory).mockResolvedValue(null);
  await refreshPerpMaintenance(db);
  expect(orderStatus()).toBe("pending");
  expect(db.prepare("SELECT count(*) FROM perp_positions").pluck().get()).toBe(
    1
  );
  vi.setSystemTime(due + 5_100);
  vi.mocked(getFundingHistory).mockResolvedValue([{ at: due, rateE8: 100000 }]);
  vi.mocked(getBoundaryMark).mockResolvedValue(100000);
  await refreshPerpMaintenance(db);
  // Fully closing the liquidated position cancels its outstanding reduce-only orders.
  expect(orderStatus()).toBe("cancelled");
  expect(
    db
      .prepare(
        "SELECT kind FROM perp_events WHERE kind IN ('funding','liquidate') ORDER BY id"
      )
      .pluck()
      .all()
  ).toEqual(["funding", "liquidate"]);
  expect(db.prepare("SELECT action FROM perp_orders").pluck().all()).toEqual([
    "liquidate",
  ]);
});
it.each(["close-only", "site-cap"])(
  "reads the current %s limit before allowing a resting order to fill",
  async type => {
    waitingOrder();
    vi.setSystemTime(monday + 10000);
    db.prepare("INSERT INTO settings VALUES('bybit_perp_config_v1',?)").run(
      JSON.stringify({
        symbols: [symbol],
        depositsEnabled: true,
        tradingEnabled: true,
        userLimitUnits: 90000,
        platformLimitUnits: 90000,
        closeOnlySymbols: type === "close-only" ? [symbol] : [],
      })
    );
    await refreshPerpMaintenance(db);
    expect(orderStatus()).toBe("rejected");
    expect(
      db.prepare("SELECT reason FROM perp_pending_orders").pluck().get()
    ).toMatch(type === "close-only" ? /暂停开仓/ : /仓位上限/);
    expect(db.prepare("SELECT count(*) FROM perp_orders").pluck().get()).toBe(
      0
    );
  }
);
it.each(["banned", "incomplete", "all", "finance", "entertainment"])(
  "refuses an executable resting order once the owner becomes %s",
  async state => {
    waitingOrder();
    vi.setSystemTime(monday + 10000);
    if (state === "banned") db.prepare("UPDATE users SET banned=1").run();
    else if (state === "incomplete")
      db.prepare("UPDATE users SET group_name=NULL").run();
    else
      db.prepare(
        "INSERT INTO user_policies(user_id,all_frozen,finance_frozen,entertainment_frozen) VALUES(1,?,?,?)"
      ).run(
        Number(state === "all"),
        Number(state === "finance"),
        Number(state === "entertainment")
      );
    await refreshPerpMaintenance(db);
    expect(orderStatus()).toBe("rejected");
    expect(db.prepare("SELECT count(*) FROM perp_orders").pluck().get()).toBe(
      0
    );
    expect(
      db
        .prepare("SELECT cash_units FROM perp_wallets WHERE user_id=1")
        .pluck()
        .get()
    ).toBe(1000000);
  }
);
