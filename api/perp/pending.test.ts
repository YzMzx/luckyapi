import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERP_ENGINE_SCHEMA } from "./schema";
import { exchangePerp, placePerpOrder } from "./engine";
import {
  createPending,
  cancelPending,
  listPending,
  matchPending,
  replayPending,
  type PendingInput,
  type PendingSnapshot,
} from "./pending";
let db: Database.Database;
const symbol = "BTCUSDT",
  now = Date.UTC(2027, 0, 1),
  quantityAtoms = 100_000_000;
const order = (more: Partial<PendingInput> = {}): PendingInput => ({
  action: "openLong",
  symbol,
  orderType: "limit",
  quantityAtoms,
  leverage: 5,
  requestKey: randomUUID(),
  limitPriceUnits: 99_000,
  ...more,
});
function quote(
  bidUnits = 99900,
  askUnits = 100000,
  markUnits = 100000,
  extra: Partial<PendingSnapshot> = {}
): PendingSnapshot {
  return {
    symbol,
    bidUnits,
    askUnits,
    markUnits,
    asOf: Date.now(),
    nextFundingAt: now + 3600_000,
    tickSizeUnits: 100,
    qtyStepAtoms: 10000,
    minQtyAtoms: 10000,
    maxQtyAtoms: 200_000_000,
    minNotionalUnits: 10_000,
    maxLeverage: 10,
    ...extra,
  };
}
function advance() {
  vi.setSystemTime(Date.now() + 100);
}
function match(id: number, q: PendingSnapshot) {
  return matchPending(db, id, q, () => null);
}
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE users(id INTEGER PRIMARY KEY);INSERT INTO users(id) VALUES(1),(2);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);" +
      PERP_ENGINE_SCHEMA +
      "INSERT INTO perp_wallets VALUES(1,100000),(2,100000);"
  );
  vi.stubEnv("PERP_TRADING_ENABLED", "1");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe("durable simulated pending orders", () => {
  it("validates a custom leverage at submission and checks the updated range again before filling", () => {
    const rules = db.prepare(
      "INSERT OR REPLACE INTO settings VALUES('bybit_perp_config_v1', ?)"
    );
    const setRange = (minLeverage: number, maxLeverage: number) =>
      rules.run(
        JSON.stringify({
          symbols: [symbol],
          tradingEnabled: true,
          depositsEnabled: true,
          userLimitUnits: 1_000_000,
          platformLimitUnits: 1_000_000,
          minLeverage,
          maxLeverage,
        })
      );
    setRange(3, 100);
    const tick = () => quote(98_000, 98_500, 98_500, { maxLeverage: 50 });
    expect(() => createPending(db, 1, order({ leverage: 51 }), tick())).toThrow(
      "3× 至 50×"
    );
    const first = createPending(db, 1, order({ leverage: 25 }), tick());
    expect(first.leverage).toBe(25);
    setRange(3, 20);
    advance();
    expect(match(first.id, tick())).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("3× 至 20×"),
    });
    expect(
      db.prepare("SELECT count(*) FROM perp_positions").pluck().get()
    ).toBe(0);
    setRange(3, 100);
    const second = createPending(db, 1, order({ leverage: 25 }), tick());
    advance();
    expect(match(second.id, tick())).toMatchObject({
      status: "filled",
      leverage: 25,
    });
  });
  it("fills at a qualifying ask, preserves idempotency, and rejects cross-operation reuse", async () => {
    const i = order(),
      r = createPending(db, 1, i, quote());
    expect(createPending(db, 1, i, null)).toEqual(r);
    expect(() =>
      replayPending(db, 1, { ...i, limitPriceUnits: 98000 })
    ).toThrow("请求键");
    expect(() =>
      exchangePerp(db, 1, {
        direction: "in",
        amountUnits: 100,
        requestKey: i.requestKey,
      })
    ).toThrow("请求键");
    await expect(placePerpOrder(db, 1, i, async () => null)).rejects.toThrow(
      "请求键"
    );
    expect(match(r.id, quote(98000, 98100, 98000))?.status).toBe("pending");
    advance();
    expect(match(r.id, quote(98000, 99500, 98900))?.status).toBe("pending");
    advance();
    expect(match(r.id, quote(98000, 98500, 98500))?.status).toBe("filled");
    expect(match(r.id, quote(98000, 98500, 98500))?.status).toBe("filled");
    expect(cancelPending(db, 1, r.id).status).toBe("filled");
    expect(
      db.prepare("SELECT count(*),price_units FROM perp_orders").raw().get()
    ).toEqual([1, 98500]);
    expect(
      db
        .prepare("SELECT cash_units FROM perp_wallets WHERE user_id=1")
        .pluck()
        .get()
    ).toBe(100000 - 19700 - 60);
  });
  it("triggers on mark (not last/bid), keeps triggered state even when mark recedes, then fills a limit", () => {
    const r = createPending(
      db,
      1,
      order({
        orderType: "conditional",
        triggerDirection: "above",
        triggerPriceUnits: 105000,
        limitPriceUnits: 104000,
      }),
      quote()
    );
    advance();
    expect(match(r.id, quote(110000, 110100, 104900))?.status).toBe("pending");
    advance();
    const activated = match(r.id, quote(110000, 110100, 105000));
    expect(activated?.status).toBe("triggered");
    advance();
    const done = match(r.id, quote(104000, 104000, 104000));
    expect(done).toMatchObject({
      status: "filled",
      triggeredAt: activated?.triggeredAt,
    });
  });
  it("executes a downward conditional short against the bid after a fresh eligible mark", () => {
    const r = createPending(
      db,
      1,
      order({
        action: "openShort",
        orderType: "conditional",
        triggerDirection: "below",
        triggerPriceUnits: 95000,
        limitPriceUnits: undefined,
      }),
      quote()
    );
    advance();
    expect(
      match(r.id, quote(94000, 94100, 94900, { asOf: now - 6000 }))?.status
    ).toBe("pending");
    expect(match(r.id, quote(94000, 94100, 94900))?.status).toBe("filled");
    expect(
      db.prepare("SELECT price_units FROM perp_orders").pluck().get()
    ).toBe(94000);
  });
  it("never debits an unfunded trigger and never alters a cancelled order", () => {
    const r = createPending(db, 1, order(), quote());
    expect(() => cancelPending(db, 2, r.id)).toThrow("不存在");
    db.prepare("UPDATE perp_wallets SET cash_units=0 WHERE user_id=1").run();
    advance();
    expect(match(r.id, quote(98000, 98500, 98500))).toMatchObject({
      status: "rejected",
    });
    expect(listPending(db, 2)).toEqual([]);
    const s = createPending(db, 2, order(), quote());
    expect(cancelPending(db, 2, s.id).status).toBe("cancelled");
    advance();
    expect(match(s.id, quote(98000, 98500, 98500))?.status).toBe("cancelled");
    expect(db.prepare("SELECT count(*) FROM perp_orders").pluck().get()).toBe(
      0
    );
  });
  it("cancels all original reduce-only intents when the underlying position is closed", async () => {
    const long = createPending(
      db,
      1,
      order({ limitPriceUnits: 101000 }),
      quote()
    );
    advance();
    expect(match(long.id, quote())?.status).toBe("filled");
    const close = order({
        action: "close",
        leverage: undefined,
        limitPriceUnits: 110000,
      }),
      protective = createPending(db, 1, close, quote());
    advance();
    await placePerpOrder(
      db,
      1,
      { ...close, requestKey: randomUUID() },
      async () => {
        advance();
        return quote();
      }
    );
    expect(cancelPending(db, 1, protective.id)).toMatchObject({
      status: "cancelled",
      reason: "原仓位已全部平仓",
    });
  });
  it("defers a due funding position and never closes a replacement position in the same direction", () => {
    const long = createPending(
      db,
      1,
      order({ limitPriceUnits: 101000 }),
      quote()
    );
    advance();
    expect(match(long.id, quote())?.status).toBe("filled");
    const i = order({
      action: "close",
      leverage: undefined,
      limitPriceUnits: 100000,
    });
    const deferred = createPending(db, 1, i, quote());
    advance();
    db.prepare(
      "UPDATE perp_positions SET next_funding_at=? WHERE user_id=1"
    ).run(Date.now());
    expect(match(deferred.id, quote(101000, 101100, 101000))?.status).toBe(
      "pending"
    );
    db.prepare(
      "UPDATE perp_positions SET next_funding_at=?,opened_at=? WHERE user_id=1"
    ).run(Date.now() + 3600000, Date.now());
    advance();
    expect(match(deferred.id, quote(101000, 101100, 101000))).toMatchObject({
      status: "rejected",
    });
    expect(
      db
        .prepare("SELECT quantity_atoms FROM perp_positions WHERE user_id=1")
        .pluck()
        .get()
    ).toBe(quantityAtoms);
  });
  it("enforces the standing order cap per account, releasing a slot on cancellation", () => {
    for (let n = 0; n < 50; n++) createPending(db, 1, order(), quote());
    expect(() => createPending(db, 1, order(), quote())).toThrow("最多 50");
    expect(createPending(db, 2, order(), quote()).status).toBe("pending");
    cancelPending(db, 1, listPending(db, 1)[0].id);
    expect(createPending(db, 1, order(), quote()).status).toBe("pending");
  });
  it("prevents malformed price ticks, impossible triggers and revoked trading access", () => {
    expect(() =>
      createPending(db, 1, order({ limitPriceUnits: 99001 }), quote())
    ).toThrow("步长");
    expect(() =>
      createPending(
        db,
        1,
        order({
          orderType: "conditional",
          triggerDirection: "above",
          triggerPriceUnits: 100000,
        }),
        quote()
      )
    ).toThrow("触发价");
    const r = createPending(db, 1, order(), quote());
    advance();
    expect(
      matchPending(db, r.id, quote(98000, 98500, 98500), () => "账户已冻结")
    ).toMatchObject({ status: "rejected", reason: "账户已冻结" });
    expect(db.prepare("SELECT count(*) FROM perp_events").pluck().get()).toBe(
      0
    );
  });
});
