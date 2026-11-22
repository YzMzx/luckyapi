import Database from "better-sqlite3";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  getBoundaryMark,
  getFundingHistory,
  getPerpInstrument,
  lookupPerpInstrument,
  getPerpMarket,
  getPerpQuote,
  PERP_MARKET_SCHEMA,
} from "./market";
const symbol = "BTCUSDT",
  hour = 3_600_000,
  min = 60_000;
// Sunday, during the continuous trading session.
const now = Date.parse("2026-11-22T12:01:01Z"),
  start = Math.floor(now / (15 * min)) * 15 * min;
const instrument = {
  symbol,
  status: "Trading",
  contractType: "LinearPerpetual",
  baseCoin: "BTC",
  quoteCoin: "USDT",
  settleCoin: "USDT",
  priceFilter: { tickSize: "0.10" },
  lotSizeFilter: {
    qtyStep: "0.001",
    minOrderQty: "0.001",
    maxMktOrderQty: "18.50",
    minNotionalValue: "5",
  },
  leverageFilter: { maxLeverage: "100.00" },
  fundingInterval: 480,
};
const ticker = {
  symbol,
  bid1Price: "100000.2",
  ask1Price: "100000.30",
  bid1Size: "1.003",
  ask1Size: "0.007",
  curPreListingPhase: "",
  markPrice: "100000.001",
  lastPrice: "100000.1",
  fundingRate: "-0.00005123",
  nextFundingTime: String(now + 4 * hour),
};
const bar = [
  String(start),
  "100000.1",
  "100100.2",
  "99500.3",
  "100015.50",
  "0.12345678",
  "12365.147",
];
const boundary = Math.floor(now / (8 * hour)) * 8 * hour;
const mark = [
  String(boundary - min),
  "70000.1",
  "70001.2",
  "69990.3",
  "70000.450",
];
const reply = (list: unknown[], extra: object = {}, time = Date.now()) =>
  Response.json({
    retCode: 0,
    time,
    result: { category: "linear", symbol, list, ...extra },
  });
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);" +
      PERP_MARKET_SCHEMA
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function feed(fn: (url: URL) => Response) {
  const mock = vi.fn(async (input: URL, init: RequestInit) => {
    expect(input.origin).toBe("https://api.bybit.com");
    expect(input.pathname).toMatch(/^[/]v5[/]market[/]/);
    expect(input.searchParams.get("category")).toBe("linear");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ Accept: "application/json" });
    expect(init.redirect).toBe("error");
    return fn(input);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
it("coalesces chart, ticker and instrument pulls and parses exact USDT and contract units", async () => {
  const mock = feed(u =>
    u.pathname.endsWith("tickers")
      ? reply([ticker])
      : u.pathname.endsWith("instruments-info")
        ? reply([instrument])
        : reply([bar, [String(start - 15 * min), ...bar.slice(1)]])
  );
  const [a, b] = await Promise.all([
    getPerpMarket(db, symbol, 15),
    getPerpMarket(db, symbol, 15),
  ]);
  expect(mock).toHaveBeenCalledTimes(3);
  expect(a).toEqual(b);
  expect(a.instrument).toMatchObject({
    qtyStepUnits: 100000,
    minQtyUnits: 100000,
    maxQtyUnits: 1850000000,
    tickSizeUnits: 100,
    minNotionalUnits: 5000,
    maxLeverage: 100,
    fundingIntervalMs: 8 * hour,
  });
  expect(a.quote).toMatchObject({
    asOf: now,
    bidUnits: 100000200,
    askUnits: 100000300,
    markUnits: 100000001,
    fundingRateE8: -5123,
  });
  expect(a.bars.map(r => [r.endAt, r.complete])).toEqual([
    [start, true],
    [start + 15 * min, false],
  ]);
  expect(a.bars[1]).toMatchObject({
    open: 100000.1,
    close: 100015.5,
    volume: 0.12345678,
  });
  vi.setSystemTime(now + 90_000);
  feed(() => new Response("Down", { status: 503 }));
  const offline = await getPerpMarket(db, symbol, 15);
  expect(offline.bars).toEqual(a.bars);
  expect(offline.source).toContain("缓存");
  expect(offline.quote).toBeNull();
  expect(offline.readOnlyReason).toBeTruthy();
});
it("fetches 1m by default and keeps periods separate in memory and on disk", async () => {
  const periods = [1, 3, 5, 15] as const;
  const calls: number[] = [];
  feed(url => {
    if (!url.pathname.endsWith("/kline"))
      return reply(url.pathname.endsWith("/tickers") ? [ticker] : [instrument]);
    const interval = Number(url.searchParams.get("interval"));
    calls.push(interval);
    const step = interval * min,
      current = Math.floor(now / step) * step;
    return reply(
      [current, current - step].map(t => [String(t), ...bar.slice(1)])
    );
  });
  const snapshots = await Promise.all(
    periods.map(p =>
      p === 1 ? getPerpMarket(db, symbol) : getPerpMarket(db, symbol, p)
    )
  );
  expect(calls.sort((a, b) => a - b)).toEqual(periods);
  for (const [index, p] of periods.entries()) {
    const latestStart = Math.floor(now / (p * min)) * p * min;
    expect(snapshots[index]).toMatchObject({
      interval: p,
      bars: [
        { endAt: latestStart, complete: true },
        { endAt: latestStart + p * min, complete: false },
      ],
    });
  }
  vi.setSystemTime(now + 90_000);
  feed(() => new Response("Offline", { status: 503 }));
  for (const [index, p] of periods.entries()) {
    const cached = await getPerpMarket(db, symbol, p);
    expect(cached).toMatchObject({
      interval: p,
      source: "Bybit 历史缓存",
      bars: snapshots[index].bars,
    });
  }
});
it("serves old bare-symbol chart rows only for 15m during an outage", async () => {
  const legacy = [
    {
      endAt: start,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
      complete: true,
    },
  ];
  db.prepare("INSERT INTO perp_chart_cache VALUES (?,?,?)").run(
    symbol,
    now - min,
    JSON.stringify(legacy)
  );
  feed(() => new Response("Offline", { status: 503 }));
  for (const p of [1, 3, 5] as const) {
    expect(await getPerpMarket(db, symbol, p)).toMatchObject({
      interval: p,
      bars: [],
      source: "Bybit 行情暂不可用",
    });
  }
  expect(await getPerpMarket(db, symbol, 15)).toMatchObject({
    bars: legacy,
    source: "Bybit 历史缓存",
  });
});
it.each([
  ["stale age", { time: now - 5000 }],
  ["future time", { time: now + 1 }],
  ["stale funding", { tick: { nextFundingTime: String(now) } }],
  ["crossed spread", { tick: { ask1Price: "1" } }],
  ["zero mark", { tick: { markPrice: "0" } }],
  ["empty bid", { tick: { bid1Price: "" } }],
  ["zero bid", { tick: { bid1Price: "0" } }],
  ["zero ask", { tick: { ask1Price: "0" } }],
  ["no bid liquidity", { tick: { bid1Size: "0" } }],
  ["no ask liquidity", { tick: { ask1Size: "0" } }],
  [
    "suspended prelisting auction",
    { tick: { curPreListingPhase: "CallAuction" } },
  ],
  ["bad price precision", { tick: { bid1Price: "100.12345" } }],
  ["mismatched contract", { tick: { symbol: "ETHUSDT" } }],
] as const)("rejects %s for execution", async (_, invalid) => {
  feed(url =>
    url.pathname.endsWith("instruments-info")
      ? reply([instrument])
      : reply(
          [{ ...ticker, ...("tick" in invalid ? invalid.tick : {}) }],
          {},
          "time" in invalid ? invalid.time : now
        )
  );
  expect(await getPerpQuote(db, symbol)).toBeNull();
});
const nvda = "NVDAUSDT";
const nvdaInstrument = {
  ...instrument,
  symbol: nvda,
  baseCoin: "NVDA",
  marketRegion: "US",
  underlyingTicker: "NVDA",
  fundingInterval: 60,
};
it("inspects exact off-list NVDA specs and preserves historical marks and funding without exposing it to players", async () => {
  const fetch = feed(url => {
    expect(url.searchParams.get("symbol")).toBe(nvda);
    if (url.pathname.endsWith("instruments-info"))
      return reply([nvdaInstrument], { symbol: nvda });
    if (url.pathname.endsWith("mark-price-kline"))
      return reply([mark], { symbol: nvda });
    return reply(
      [
        {
          symbol: nvda,
          fundingRate: "0.0001",
          fundingRateTimestamp: String(boundary),
        },
      ],
      { symbol: nvda }
    );
  });
  await expect(getPerpMarket(db, nvda)).rejects.toThrow("合约未开放");
  expect(fetch).not.toHaveBeenCalled();
  expect(await lookupPerpInstrument(db, nvda)).toMatchObject({
    symbol: nvda,
    tickSizeUnits: 100,
    qtyStepUnits: 100000,
  });
  expect(await getBoundaryMark(db, nvda, boundary)).toBe(70000450);
  expect(await getFundingHistory(db, nvda, boundary - hour, boundary)).toEqual([
    { at: boundary, rateE8: 10000 },
  ]);
});
it.each([
  ["suspended", { status: "Settling" }],
  ["symbol mismatch", { symbol: "AAPLUSDT" }],
  ["underlying mismatch", { baseCoin: "META" }],
  ["other collateral", { settleCoin: "USDC" }],
  ["other quote currency", { quoteCoin: "USD" }],
  ["inverse", { contractType: "InversePerpetual" }],
  ["pre-market", { isPreListing: true }],
  ["delivery", { contractType: "LinearFutures" }],
  ["bad funding interval", { fundingInterval: 0 }],
])(
  "blocks %s instrument even when the ticker still has a nonzero price",
  async (_, patch) => {
    feed(url =>
      url.pathname.endsWith("instruments-info")
        ? reply([{ ...nvdaInstrument, ...patch }], { symbol: nvda })
        : reply([{ ...ticker, symbol: nvda }], { symbol: nvda })
    );
    expect(await getPerpInstrument(db, nvda)).toBeNull();
    expect(await getPerpQuote(db, nvda)).toBeNull();
  }
);
it.each([
  { priceFilter: { tickSize: "0.0001" } },
  { priceFilter: { tickSize: "0.0015" } },
  { lotSizeFilter: { ...instrument.lotSizeFilter, qtyStep: "0.000000001" } },
  { lotSizeFilter: { ...instrument.lotSizeFilter, minNotionalValue: "0" } },
])(
  "provides a precision/range diagnostic without rounding an unsupported contract",
  async patch => {
    feed(() => reply([{ ...nvdaInstrument, ...patch }], { symbol: nvda }));
    await expect(lookupPerpInstrument(db, nvda)).rejects.toThrow(
      "交易规格不受支持"
    );
    expect(await getPerpInstrument(db, nvda)).toBeNull();
  }
);
it("only accepts snapshots strictly later than the order timestamp", async () => {
  feed(url =>
    url.pathname.endsWith("instruments-info")
      ? reply([instrument])
      : reply([ticker], {}, now - 10)
  );
  expect(await getPerpQuote(db, symbol, now - 10)).toBeNull();
  expect(await getPerpQuote(db, symbol, now - 11)).toMatchObject({
    asOf: now - 10,
  });
});
it("filters unauthorized instruments and applies a common rate limit backoff", async () => {
  const calls = feed(
    () =>
      new Response("Blocked", { status: 429, headers: { "Retry-After": "60" } })
  );
  expect(await getPerpQuote(db, symbol)).toBeNull();
  vi.setSystemTime(now + 55_000);
  expect(await getPerpInstrument(db, "ETHUSDT")).toBeNull();
  expect(calls).toHaveBeenCalledTimes(1);
  await expect(getPerpQuote(db, "BTCUSD")).rejects.toThrow("无效永续合约");
});
it("reads historical marks from the fully closed minute preceding exactly the requested boundary", async () => {
  const f = feed(u => {
    expect(u.searchParams.get("interval")).toBe("1");
    expect(u.searchParams.get("start")).toBe(String(boundary - min));
    expect(u.searchParams.get("end")).toBe(String(boundary - 1));
    return reply([mark]);
  });
  expect(await getBoundaryMark(db, symbol, boundary)).toBe(70000450);
  expect(await getBoundaryMark(db, symbol, boundary)).toBe(70000450);
  expect(f).toHaveBeenCalledTimes(1);
});
it.each([
  ["future boundary", now + min, mark],
  ["adjacent minute", boundary, [String(boundary), ...mark.slice(1)]],
  ["invalid range", boundary, [mark[0], "2", "1", "3", "4"]],
])("never uses %s for archived marks", async (_, cut, raw) => {
  feed(() => reply([raw]));
  expect(await getBoundaryMark(db, symbol, Number(cut))).toBeNull();
});
const funding = (at: number) => ({
  symbol,
  fundingRate: "-0.00000001",
  fundingRateTimestamp: String(at),
});
it("requires all funding periods in the half-open requested window", async () => {
  const f = feed(u =>
    u.pathname.endsWith("instruments-info")
      ? reply([instrument])
      : reply([funding(boundary), funding(boundary - 8 * hour)])
  );
  expect(
    await getFundingHistory(db, symbol, boundary - 16 * hour, boundary)
  ).toEqual([
    { at: boundary - 8 * hour, rateE8: -1 },
    { at: boundary, rateE8: -1 },
  ]);
  expect(f).toHaveBeenCalledTimes(2);
});
it.each([
  ["missing final", [funding(boundary - 8 * hour)]],
  ["duplicated", [funding(boundary), funding(boundary)]],
  [
    "unconfirmed schedule",
    [funding(boundary + min), funding(boundary - 8 * hour)],
  ],
  [
    "wrong pair",
    [funding(boundary), { ...funding(boundary - 8 * hour), symbol: "ETHUSDT" }],
  ],
])("keeps %s funding history pending", async (_, raw) => {
  feed(u =>
    u.pathname.endsWith("instruments-info")
      ? reply([instrument])
      : reply(raw as unknown[])
  );
  expect(
    await getFundingHistory(db, symbol, boundary - 16 * hour, boundary)
  ).toBeNull();
});
