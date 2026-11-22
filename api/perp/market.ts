import type Database from "better-sqlite3";
import { z } from "zod";
import type { PerpKlineInterval } from "@contracts/perp-kline";
import { perpSymbolSchema, readPerpConfig } from "./config";

export const PERP_MARKET_SCHEMA = `
CREATE TABLE IF NOT EXISTS perp_chart_cache(symbol TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, bars_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS perp_boundary_marks(symbol TEXT NOT NULL, boundary_at INTEGER NOT NULL, price_units INTEGER NOT NULL CHECK(price_units>0), PRIMARY KEY(symbol,boundary_at));`;
type Db = Database.Database;
const minute = 60_000,
  day = 24 * 60 * minute;
export type PerpBar = {
  endAt: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  complete: boolean;
};
export type PerpQuote = {
  symbol: string;
  asOf: number;
  bidUnits: number;
  askUnits: number;
  markUnits: number;
  lastUnits: number;
  fundingRateE8: number;
  nextFundingAt: number;
};
export type PerpInstrument = {
  symbol: string;
  tickSizeUnits: number;
  qtyStepUnits: number;
  minQtyUnits: number;
  maxQtyUnits: number;
  minNotionalUnits: number;
  maxLeverage: number;
  fundingIntervalMs: number;
};
export type PerpFunding = { at: number; rateE8: number };
export function listPerpSymbols(db?: Db) {
  return readPerpConfig(db).symbols;
}
function requireSymbol(symbol: string) {
  const parsed = perpSymbolSchema.safeParse(symbol);
  if (!parsed.success || parsed.data !== symbol)
    throw new Error("无效永续合约");
}
function requireData(condition: unknown): asserts condition {
  if (!condition) throw new Error("Bybit 行情数据无效");
}
const decimals = /^-?[0-9]{1,17}(?:[.][0-9]{1,18})?$/;
function units(raw: string, places: number, signed = false) {
  requireData(decimals.test(raw));
  const negative = raw.startsWith("-");
  const [whole, fraction = ""] = (negative ? raw.slice(1) : raw).split(".");
  requireData((signed || !negative) && !/[1-9]/.test(fraction.slice(places)));
  const n = Number(
    BigInt(whole + fraction.slice(0, places).padEnd(places, "0")) *
      (negative ? -1n : 1n)
  );
  requireData(Number.isSafeInteger(n));
  return n;
}
function timestamp(raw: string) {
  const n = units(raw, 0);
  requireData(n > 0);
  return n;
}
const header = z.object({
  retCode: z.literal(0),
  time: z.number().int().positive(),
  result: z.object({
    category: z.literal("linear"),
    symbol: z.string().optional(),
    list: z.array(z.unknown()).max(200),
  }),
});
type Endpoint =
  | "kline"
  | "tickers"
  | "instruments-info"
  | "funding/history"
  | "mark-price-kline";
async function request(
  db: Db,
  endpoint: Endpoint,
  symbol: string,
  params: Record<string, string> = {}
) {
  const state = cacheFor(db);
  requireData(Date.now() >= state.blockedUntil);
  const url = new URL("https://api.bybit.com/v5/market/" + endpoint);
  url.search = new URLSearchParams({
    category: "linear",
    symbol,
    ...params,
  }).toString();
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(2_500),
  });
  if (response.status === 429 || response.status === 403) {
    const seconds = Number(response.headers.get("retry-after"));
    state.blockedUntil =
      Date.now() +
      Math.max(
        response.status === 403 ? 60_000 : 10_000,
        Math.min(300_000, Number.isFinite(seconds) ? seconds * 1000 : 0)
      );
  }
  requireData(response.ok && response.body);
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 256_000) {
      await reader.cancel();
      throw new Error("行情响应过大");
    }
    chunks.push(value);
  }
  const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (raw?.retCode === 10006) state.blockedUntil = Date.now() + 10_000;
  const { time, result } = header.parse(raw);
  requireData(result.symbol === undefined || result.symbol === symbol);
  return { time, result };
}
type CacheState = {
  flights: Map<string, Promise<unknown>>;
  responses: Map<string, { until: number; value: unknown }>;
  blockedUntil: number;
};
const cache = new WeakMap<Db, CacheState>();
function cacheFor(db: Db) {
  let state = cache.get(db);
  if (!state) {
    state = { flights: new Map(), responses: new Map(), blockedUntil: 0 };
    cache.set(db, state);
  }
  return state;
}
async function shared<T>(
  db: Db,
  key: string,
  ttl: number,
  load: () => Promise<T>
): Promise<T | null> {
  const state = cacheFor(db),
    previous = state.responses.get(key),
    now = Date.now();
  if (previous && now < previous.until) return previous.value as T | null;
  const flight = state.flights.get(key);
  if (flight) return flight as Promise<T | null>;
  const job = (async () => {
    let result: T | null;
    try {
      result = await load();
    } catch {
      result = null;
    }
    if (state.responses.size >= 128)
      state.responses.delete(state.responses.keys().next().value!);
    state.responses.set(key, {
      value: result,
      until: Date.now() + (result === null ? 1500 : ttl),
    });
    return result;
  })().finally(() => state.flights.delete(key));
  state.flights.set(key, job);
  return job;
}

const tickerPhaseSchema = z.object({
  symbol: z.string(),
  curPreListingPhase: z.string().optional(),
});
const tickerSchema = z.object({
  symbol: z.string(),
  bid1Price: z.string(),
  ask1Price: z.string(),
  bid1Size: z.string(),
  ask1Size: z.string(),
  curPreListingPhase: z.string().optional(),
  lastPrice: z.string(),
  markPrice: z.string(),
  nextFundingTime: z.string(),
  fundingRate: z.string(),
});
function fresh(time: number) {
  return time <= Date.now() && Date.now() - time < 5_000;
}
const phaseFinishedReason =
  "Bybit 公共行情显示该合约盘前阶段已结束（Finished），本站暂不支持下单。";
type QuoteStatus = { quote: PerpQuote | null; readOnlyReason: string | null };
const unavailableQuote = { quote: null, readOnlyReason: null };

export async function getPerpQuoteStatus(
  db: Db,
  symbol: string,
  afterMs?: number
): Promise<QuoteStatus> {
  requireSymbol(symbol);
  if (
    afterMs !== undefined &&
    (!Number.isSafeInteger(afterMs) || !fresh(afterMs))
  )
    return unavailableQuote;
  const load = () =>
    shared(db, "ticker:" + symbol, 350, async (): Promise<QuoteStatus> => {
      const { time, result } = await request(db, "tickers", symbol);
      requireData(result.list.length === 1 && fresh(time));
      const phase = tickerPhaseSchema.parse(result.list[0]);
      requireData(phase.symbol === symbol);
      if (phase.curPreListingPhase === "Finished")
        return { quote: null, readOnlyReason: phaseFinishedReason };
      requireData(!phase.curPreListingPhase);
      const row = tickerSchema.parse(result.list[0]);
      requireData(units(row.bid1Size, 8) > 0 && units(row.ask1Size, 8) > 0);
      const q = {
        symbol,
        asOf: time,
        bidUnits: units(row.bid1Price, 3),
        askUnits: units(row.ask1Price, 3),
        lastUnits: units(row.lastPrice, 3),
        markUnits: units(row.markPrice, 3),
        nextFundingAt: timestamp(row.nextFundingTime),
        fundingRateE8: units(row.fundingRate, 8, true),
      };
      requireData(
        q.bidUnits > 0 &&
          q.bidUnits <= q.askUnits &&
          q.markUnits > 0 &&
          q.lastUnits > 0 &&
          q.nextFundingAt > time &&
          Math.abs(q.fundingRateE8) < 1e8
      );
      return { quote: q, readOnlyReason: null };
    });
  // A fresh ticker alone cannot make a non-trading or pre-launch instrument executable.
  if (!(await getPerpInstrument(db, symbol))) return unavailableQuote;
  let result = await load();
  if (afterMs !== undefined && result?.quote && result.quote.asOf <= afterMs) {
    // Coalesce post-acceptance snapshots too, respecting the per-symbol pull interval.
    await new Promise(resolve => setTimeout(resolve, 360));
    result = await load();
  }
  if (result?.readOnlyReason) return result;
  const quote = result?.quote;
  return quote &&
    fresh(quote.asOf) &&
    quote.nextFundingAt > Date.now() &&
    (afterMs === undefined || quote.asOf > afterMs)
    ? { quote, readOnlyReason: null }
    : unavailableQuote;
}

export async function getPerpQuote(db: Db, symbol: string, afterMs?: number) {
  return (await getPerpQuoteStatus(db, symbol, afterMs)).quote;
}
const instrumentSchema = z.object({
  symbol: z.string(),
  contractType: z.literal("LinearPerpetual"),
  status: z.literal("Trading"),
  baseCoin: z.string().min(1),
  isPreListing: z.literal(false).optional(),
  settleCoin: z.literal("USDT"),
  quoteCoin: z.literal("USDT"),
  priceFilter: z.object({ tickSize: z.string() }),
  lotSizeFilter: z.object({
    qtyStep: z.string(),
    minOrderQty: z.string(),
    maxMktOrderQty: z.string(),
    minNotionalValue: z.string(),
  }),
  leverageFilter: z.object({ maxLeverage: z.string() }),
  fundingInterval: z.number().int().min(1).max(1440),
});
// Resolve exact provider symbols independently of the site's allowed list: admins must be
// able to inspect new listings, and accounting still needs marks/funding after removal.
async function inspectInstrument(db: Db, symbol: string) {
  requireSymbol(symbol);
  return shared(db, "instrument:" + symbol, 60_000, async () => {
    const { time, result } = await request(db, "instruments-info", symbol);
    requireData(fresh(time));
    const parsed = instrumentSchema.safeParse(
      result.list.length === 1 ? result.list[0] : null
    );
    if (
      !parsed.success ||
      parsed.data.symbol !== symbol ||
      parsed.data.baseCoin + "USDT" !== symbol
    )
      return {
        error: "未找到与代码匹配、正在交易的 USDT 线性永续合约",
      } as const;
    const i = parsed.data;
    try {
      const out: PerpInstrument = {
        symbol,
        tickSizeUnits: units(i.priceFilter.tickSize, 3),
        qtyStepUnits: units(i.lotSizeFilter.qtyStep, 8),
        minQtyUnits: units(i.lotSizeFilter.minOrderQty, 8),
        maxQtyUnits: units(i.lotSizeFilter.maxMktOrderQty, 8),
        minNotionalUnits: units(i.lotSizeFilter.minNotionalValue, 3),
        maxLeverage: units(i.leverageFilter.maxLeverage, 0),
        fundingIntervalMs: i.fundingInterval * minute,
      };
      requireData(
        out.tickSizeUnits > 0 &&
          out.qtyStepUnits > 0 &&
          out.minQtyUnits >= out.qtyStepUnits &&
          out.minQtyUnits % out.qtyStepUnits === 0 &&
          out.maxQtyUnits >= out.minQtyUnits &&
          out.maxLeverage >= 1 &&
          out.minNotionalUnits > 0
      );
      return { instrument: out } as const;
    } catch {
      return {
        error:
          "该合约的交易规格不受支持：价格和名义金额最多 3 位小数、数量最多 8 位小数，且下单范围必须有效",
      } as const;
    }
  });
}

export class PerpInstrumentLookupError extends Error {}

export async function lookupPerpInstrument(
  db: Db,
  symbol: string
): Promise<PerpInstrument> {
  const result = await inspectInstrument(db, symbol);
  if (!result?.instrument)
    throw new PerpInstrumentLookupError(
      result?.error ?? "Bybit 暂未提供可验证的合约规格，请稍后重试"
    );
  return result.instrument;
}

export async function getPerpInstrument(
  db: Db,
  symbol: string
): Promise<PerpInstrument | null> {
  return (await inspectInstrument(db, symbol))?.instrument ?? null;
}
const ohlcSchema = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
]);
const barSchema = ohlcSchema.rest(z.string()).refine(row => row.length === 7);
function prices(row: readonly string[]) {
  const [open, high, low, close] = row.slice(1, 5).map(p => units(p, 3));
  requireData(
    low > 0 && low <= Math.min(open, close) && high >= Math.max(open, close)
  );
  return { open, high, low, close };
}
async function getBars(db: Db, symbol: string, interval: PerpKlineInterval) {
  const intervalMs = interval * minute;
  // Legacy rows keyed by bare symbol exclusively contain 15m candles. Symbol
  // validation excludes colons, so shorter periods cannot collide with them.
  const cacheKey = interval === 15 ? symbol : `${symbol}:${interval}`;
  const bars = await shared(db, "bars:" + cacheKey, 15_000, async () => {
    const { time, result } = await request(db, "kline", symbol, {
      interval: String(interval),
      limit: "200",
    });
    requireData(
      result.symbol === symbol && result.list.length > 0 && fresh(time)
    );
    const parsed: PerpBar[] = result.list
      .map(raw => {
        const row = barSchema.parse(raw);
        const start = timestamp(row[0]);
        requireData(start % intervalMs === 0 && start <= time);
        const { open, high, low, close } = prices(row);
        return {
          endAt: start + intervalMs,
          open: open / 1000,
          high: high / 1000,
          low: low / 1000,
          close: close / 1000,
          volume: units(row[5], 8) / 1e8,
          complete: start + intervalMs <= time,
        };
      })
      .reverse();
    requireData(
      parsed.every((b, i) => !i || b.endAt === parsed[i - 1].endAt + intervalMs)
    );
    db.prepare("INSERT OR REPLACE INTO perp_chart_cache VALUES(?,?,?)").run(
      cacheKey,
      time,
      JSON.stringify(parsed)
    );
    return parsed;
  });
  if (bars) return { bars, source: "Bybit 公共行情" };
  const saved = db
    .prepare("SELECT bars_json FROM perp_chart_cache WHERE symbol=?")
    .get(cacheKey) as { bars_json: string } | undefined;
  return {
    bars: saved ? (JSON.parse(saved.bars_json) as PerpBar[]) : [],
    source: saved ? "Bybit 历史缓存" : "Bybit 行情暂不可用",
  };
}
export async function getPerpMarket(
  db: Db,
  symbol: string,
  interval: PerpKlineInterval = 1
) {
  const stock = listPerpSymbols(db).find(s => s.symbol === symbol);
  if (!stock) throw new Error("合约未开放");
  const [history, raw, instrument] = await Promise.all([
    getBars(db, symbol, interval),
    getPerpQuoteStatus(db, symbol),
    getPerpInstrument(db, symbol),
  ]);
  const quote =
    raw.quote && fresh(raw.quote.asOf) && raw.quote.nextFundingAt > Date.now()
      ? raw.quote
      : null;
  return {
    ...stock,
    ...history,
    interval,
    instrument,
    quote,
    readOnlyReason:
      quote && instrument
        ? null
        : (raw.readOnlyReason ?? "暂无已确认的 Bybit 实时报价或合约规格"),
  };
}
export async function getBoundaryMark(
  db: Db,
  symbol: string,
  boundaryMs: number
): Promise<number | null> {
  requireSymbol(symbol);
  if (
    !Number.isSafeInteger(boundaryMs) ||
    boundaryMs < minute ||
    boundaryMs % minute !== 0 ||
    boundaryMs > Date.now()
  )
    return null;
  const existing = db
    .prepare(
      "SELECT price_units FROM perp_boundary_marks WHERE symbol=? AND boundary_at=?"
    )
    .pluck()
    .get(symbol, boundaryMs) as number | undefined;
  if (existing !== undefined) return existing;
  return shared(db, "mark:" + symbol + ":" + boundaryMs, day, async () => {
    const start = boundaryMs - minute;
    const { time, result } = await request(db, "mark-price-kline", symbol, {
      interval: "1",
      start: String(start),
      end: String(boundaryMs - 1),
      limit: "1",
    });
    requireData(
      result.symbol === symbol && time >= boundaryMs && result.list.length === 1
    );
    const row = ohlcSchema.parse(result.list[0]);
    requireData(timestamp(row[0]) === start);
    const price = prices(row).close;
    db.prepare("INSERT OR IGNORE INTO perp_boundary_marks VALUES(?,?,?)").run(
      symbol,
      boundaryMs,
      price
    );
    return db
      .prepare(
        "SELECT price_units FROM perp_boundary_marks WHERE symbol=? AND boundary_at=?"
      )
      .pluck()
      .get(symbol, boundaryMs) as number;
  });
}
const fundingSchema = z.object({
  symbol: z.string(),
  fundingRate: z.string(),
  fundingRateTimestamp: z.string(),
});
export async function getFundingHistory(
  db: Db,
  symbol: string,
  fromExclusive: number,
  toInclusive: number
): Promise<PerpFunding[] | null> {
  requireSymbol(symbol);
  if (
    !Number.isSafeInteger(fromExclusive) ||
    !Number.isSafeInteger(toInclusive) ||
    fromExclusive <= 0 ||
    toInclusive < fromExclusive ||
    toInclusive - fromExclusive > 7 * day ||
    toInclusive > Date.now()
  )
    return null;
  if (fromExclusive === toInclusive) return [];
  return shared(
    db,
    "fund:" + symbol + ":" + fromExclusive + ":" + toInclusive,
    60_000,
    async () => {
      const instrument = await getPerpInstrument(db, symbol);
      requireData(instrument);
      const interval = instrument.fundingIntervalMs;
      const first = (Math.floor(fromExclusive / interval) + 1) * interval;
      const count = Math.max(
        0,
        Math.floor((toInclusive - first) / interval) + 1
      );
      requireData(count < 200);
      const { time, result } = await request(db, "funding/history", symbol, {
        startTime: String(fromExclusive + 1),
        endTime: String(toInclusive),
        limit: "200",
      });
      requireData(time >= toInclusive && result.list.length === count);
      const events = result.list
        .map(raw => {
          const row = fundingSchema.parse(raw);
          const at = timestamp(row.fundingRateTimestamp),
            rateE8 = units(row.fundingRate, 8, true);
          requireData(row.symbol === symbol && Math.abs(rateE8) < 1e8);
          return { at, rateE8 };
        })
        .reverse();
      requireData(events.every((e, i) => e.at === first + i * interval));
      return events;
    }
  );
}
