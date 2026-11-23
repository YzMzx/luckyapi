import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  addPerpMargin,
  applyPerpFunding,
  exchangePerp,
  findPerpMarginReplay,
  placePerpOrder,
  previewPerpMargin,
  type PerpMarginQuote,
} from "./engine";
import { replayPending } from "./pending";
import { PERP_ENGINE_SCHEMA } from "./schema";
import {
  getPerpWeeklyBoard,
  PERP_WEEKLY_SCHEMA,
  settlePerpWeeks,
  storePerpBoundaryMark,
} from "./weekly";

const symbol = "BTCUSDT";
const start = Date.parse("2026-11-02T00:00:00+08:00");
const week = 7 * 86_400_000;
const openedAt = start + 10;
const due = start + 3 * week;
const user = 1;
let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start + 1000);
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,group_name TEXT);" +
      PERP_ENGINE_SCHEMA +
      PERP_WEEKLY_SCHEMA +
      "INSERT INTO users VALUES(1,'trader','Trader',NULL);"
  );
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
});

function seed(side: "long" | "short" = "long") {
  db.prepare("INSERT INTO perp_wallets VALUES(1,179940)").run();
  db.prepare(
    "INSERT INTO perp_positions VALUES(1,?,?,100000000,100000,20000,5,?,?,?)"
  ).run(symbol, side, openedAt, openedAt, due);
  db.prepare(
    "INSERT INTO perp_orders VALUES(1,1,?,?,?,100000000,5,100000,100000,60,0,?,'original-open')"
  ).run(symbol, side === "long" ? "openLong" : "openShort", side, openedAt);
  db.prepare(
    "INSERT INTO perp_events VALUES(1,1,NULL,'in',200000,0,0,0,?)"
  ).run(start);
  const sign = side === "long" ? 1 : -1;
  db.prepare(
    "INSERT INTO perp_events VALUES(2,1,?,'open',-20060,20000,?,?,?)"
  ).run(symbol, sign * 100000, sign * 100000000, openedAt);
}
const request = { symbol, openedAt, amountUnits: 10_000, requestKey: "top-up" };
const mark = (markUnits = 100_000, asOf = Date.now()): PerpMarginQuote => ({
  symbol,
  asOf,
  markUnits,
});
const freshMark =
  (price = 100_000) =>
  () => {
    vi.setSystemTime(Date.now() + 1);
    return mark(price);
  };
const confirm = (key = request.requestKey) =>
  addPerpMargin(db, user, { ...request, requestKey: key }, freshMark());
const position = () => db.prepare("SELECT * FROM perp_positions").get();
const wallet = () =>
  db.prepare("SELECT cash_units FROM perp_wallets").pluck().get();
const marginEvents = () =>
  db.prepare("SELECT * FROM perp_events WHERE kind='margin'").all();
const count = (table: string) =>
  db
    .prepare("SELECT count(*) FROM " + table)
    .pluck()
    .get();

it.each([
  ["long", 80_402, 70_351],
  ["short", 119_402, 129_353],
] as const)(
  "adds isolated %s collateral without changing trade fields, fees or equity",
  async (side, previousLiquidationPriceUnits, liquidationPriceUnits) => {
    seed(side);
    const before = position();
    const expected = {
      previousMarginUnits: 20_000,
      marginUnits: 30_000,
      previousLiquidationPriceUnits,
      liquidationPriceUnits,
      availableCashUnits: 169_940,
    };
    expect(previewPerpMargin(db, user, request, mark())).toEqual(expected);
    expect(position()).toEqual(before);
    expect(wallet()).toBe(179_940);
    expect(marginEvents()).toEqual([]);
    expect(await confirm()).toEqual(expected);
    expect(position()).toEqual({
      ...Object(before),
      margin_units: 30_000,
      updated_at: Date.now(),
    });
    expect(wallet()).toBe(169_940);
    expect(marginEvents()).toEqual([
      expect.objectContaining({
        user_id: user,
        symbol,
        cash_delta_units: -10_000,
        margin_delta_units: 10_000,
        qty_delta_atoms: 0,
        entry_delta_units: 0,
        created_at: Date.now(),
      }),
    ]);
    expect(count("perp_orders")).toBe(1);
    expect(count("perp_funding")).toBe(0);
  }
);

it("rejects invalid sizes, timestamps, symbols, missing positions and insufficient cash", async () => {
  expect(() => previewPerpMargin(db, user, request, mark())).toThrow(
    /仓位不存在/
  );
  seed();
  for (const amountUnits of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = { ...request, amountUnits };
    const load = vi.fn(freshMark());
    expect(() => previewPerpMargin(db, user, invalid, mark())).toThrow(
      /超出有效范围/
    );
    await expect(addPerpMargin(db, user, invalid, load)).rejects.toThrow(
      /超出有效范围/
    );
    expect(load).not.toHaveBeenCalled();
  }
  for (const quote of [
    null,
    { ...mark(), symbol: "ETHUSDT" },
    mark(0),
    mark(1.5),
    mark(100_000, Date.now() - 5000),
    mark(100_000, Date.now() + 1),
  ])
    expect(() => previewPerpMargin(db, user, request, quote)).toThrow(
      /实时报价/
    );
  await expect(addPerpMargin(db, user, request, () => mark())).rejects.toThrow(
    /实时报价/
  );
  await expect(
    addPerpMargin(db, user, { ...request, amountUnits: 179_941 }, freshMark())
  ).rejects.toThrow(/可用模拟金不足/);
  expect(wallet()).toBe(179_940);
  expect(marginEvents()).toEqual([]);
});

it("persists a new liquidation lock only at confirm and cannot rescue a locked position", async () => {
  seed();
  // The extra collateral would have rescued this mark; only old collateral counts.
  expect(() => previewPerpMargin(db, user, request, mark(79_000))).toThrow(
    /逐仓强平/
  );
  expect(count("perp_liquidation_locks")).toBe(0);
  await expect(
    addPerpMargin(db, user, request, freshMark(79_000))
  ).rejects.toThrow(/逐仓强平/);
  expect(db.prepare("SELECT * FROM perp_liquidation_locks").get()).toEqual({
    user_id: user,
    symbol,
    triggered_at: Date.now(),
    mark_units: 79_000,
  });
  await expect(confirm()).rejects.toThrow(/逐仓强平/);
  expect(wallet()).toBe(179_940);
  expect(count("perp_margin_additions")).toBe(0);
  expect(marginEvents()).toEqual([]);
});

it("rechecks the position identity and update watermark under the write lock", async () => {
  seed();
  await expect(
    addPerpMargin(db, user, request, () => {
      const q = freshMark()();
      vi.setSystemTime(Date.now() + 1);
      db.prepare("UPDATE perp_positions SET updated_at=?").run(Date.now());
      return q;
    })
  ).rejects.toThrow(/报价早于/);
  await expect(
    addPerpMargin(db, user, request, () => {
      const q = freshMark()();
      db.prepare("UPDATE perp_positions SET opened_at=?,updated_at=?").run(
        q.asOf,
        q.asOf
      );
      return q;
    })
  ).rejects.toThrow(/仓位不存在或已变更/);
  expect(wallet()).toBe(179_940);
  expect(marginEvents()).toEqual([]);
});

it("prevents using a pre-boundary mark after funding becomes due", async () => {
  seed();
  const boundary = Date.now() + 2;
  db.prepare("UPDATE perp_positions SET next_funding_at=?").run(boundary);
  await expect(
    addPerpMargin(db, user, request, () => {
      const q = freshMark()();
      vi.setSystemTime(boundary);
      return q;
    })
  ).rejects.toThrow(/资金费待确认/);
  expect(() => previewPerpMargin(db, user, request, mark())).toThrow(
    /资金费待确认/
  );
  expect(
    applyPerpFunding(db, symbol, {
      asOf: boundary,
      rateE8: 100_000,
      markUnits: 100_000,
      nextFundingAt: due,
    })
  ).toBe(1);
  expect(await confirm()).toMatchObject({
    previousMarginUnits: 19_900,
    marginUnits: 29_900,
  });
  expect(count("perp_funding")).toBe(1);
});

it("replays exactly once before and after quote await, even after position closure or market failure", async () => {
  seed();
  let rejectLoad!: (error: Error) => void;
  const first = addPerpMargin(
    db,
    user,
    request,
    () =>
      new Promise((_resolve, reject) => {
        rejectLoad = reject;
      })
  );
  const result = await confirm();
  rejectLoad(new Error("upstream unavailable"));
  expect(await first).toEqual(result);
  expect(await confirm("next-top-up")).toMatchObject({ marginUnits: 40_000 });
  db.prepare("DELETE FROM perp_positions").run();
  const unnecessaryLoad = vi.fn(() => null);
  expect(await addPerpMargin(db, user, request, unnecessaryLoad)).toEqual(
    result
  );
  expect(findPerpMarginReplay(db, user, request)).toEqual(result);
  await expect(
    addPerpMargin(
      db,
      user,
      { ...request, amountUnits: 20_000 },
      unnecessaryLoad
    )
  ).rejects.toThrow(/请求键/);
  expect(unnecessaryLoad).not.toHaveBeenCalled();
  expect(count("perp_margin_additions")).toBe(2);
  expect(marginEvents()).toHaveLength(2);
  expect(wallet()).toBe(159_940);
});

it("rejects cross-operation key collisions in both directions", async () => {
  seed();
  const load = vi.fn(freshMark());
  await expect(
    addPerpMargin(db, user, { ...request, requestKey: "original-open" }, load)
  ).rejects.toThrow(/请求键/);
  expect(load).not.toHaveBeenCalled();
  await confirm();
  const order = {
    symbol,
    action: "openLong",
    quantityAtoms: 100_000_000,
    requestKey: request.requestKey,
  } as const;
  await expect(placePerpOrder(db, user, order, vi.fn())).rejects.toThrow(
    /请求键/
  );
  expect(() =>
    exchangePerp(db, user, {
      direction: "in",
      amountUnits: 2000,
      requestKey: request.requestKey,
    })
  ).toThrow(/请求键/);
  expect(() =>
    replayPending(db, user, {
      ...order,
      orderType: "limit",
      limitPriceUnits: 100_000,
    })
  ).toThrow(/请求键/);
});

it("rechecks wallet and authorization at confirmation and rolls back a failed receipt write", async () => {
  seed();
  const denied = vi.fn(() => {
    throw new Error("denied");
  });
  await expect(
    addPerpMargin(db, user, request, freshMark(), denied)
  ).rejects.toThrow(/denied/);
  expect(denied).toHaveBeenCalledOnce();
  await expect(
    addPerpMargin(db, user, request, () => {
      db.prepare("UPDATE perp_wallets SET cash_units=9999").run();
      return freshMark()();
    })
  ).rejects.toThrow(/可用模拟金不足/);
  db.prepare("UPDATE perp_wallets SET cash_units=179940").run();
  const before = position();
  db.exec(
    "CREATE TRIGGER fail_margin BEFORE INSERT ON perp_margin_additions BEGIN SELECT RAISE(ABORT,'forced rollback'); END"
  );
  await expect(confirm()).rejects.toThrow(/forced rollback/);
  expect(wallet()).toBe(179_940);
  expect(position()).toEqual(before);
  expect(marginEvents()).toEqual([]);
  expect(findPerpMarginReplay(db, user, request)).toBeUndefined();
  db.exec("DROP TRIGGER fail_margin");
  expect(await confirm()).toMatchObject({ marginUnits: 30_000 });
});

it("replays equal and opposite margin transfers across week boundaries without moving profit or inflows", async () => {
  seed();
  const end = start + week;
  vi.setSystemTime(end - 2);
  await confirm();
  // This fresh mark predates the boundary; the transfer itself does not.
  vi.setSystemTime(end - 1);
  await addPerpMargin(db, user, { ...request, requestKey: "next-week" }, () => {
    vi.setSystemTime(end + 1);
    return mark(100_000, end);
  });
  storePerpBoundaryMark(db, end, symbol, 100_000);
  storePerpBoundaryMark(db, end + week, symbol, 100_000);
  expect(settlePerpWeeks(db, end + week + 300_000).published).toBe(2);
  const weekly = db
    .prepare(
      "SELECT opening_units,closing_units,cash_units,in_units,out_units,pnl_units FROM perp_week_results ORDER BY week_start"
    )
    .all();
  expect(weekly).toEqual([
    {
      opening_units: 0,
      closing_units: 199_940,
      cash_units: 169_940,
      in_units: 200_000,
      out_units: 0,
      pnl_units: -60,
    },
    {
      opening_units: 199_940,
      closing_units: 199_940,
      cash_units: 159_940,
      in_units: 0,
      out_units: 0,
      pnl_units: 0,
    },
  ]);
  expect(
    db
      .prepare(
        "SELECT margin_units FROM perp_week_positions ORDER BY week_start"
      )
      .pluck()
      .all()
  ).toEqual([30_000, 40_000]);
  expect(
    getPerpWeeklyBoard(db, { weekStart: end, userId: user, side: "profit" })
      ?.mine?.pnlUnits
  ).toBe(0);
  expect(count("perp_funding")).toBe(0);
});
