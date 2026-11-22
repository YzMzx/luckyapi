import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { PERP_ENGINE_SCHEMA } from "./schema";
import { savePerpConfig } from "./config";
import {
  exchangePerp,
  getPerpAccount,
  previewPerpExchange,
  placePerpOrder,
  liquidatePerpPositions,
  applyPerpFunding,
  type PerpOrderInput,
  type PerpSnapshot,
} from "./engine";
import { getDb } from "../queries/connection";
let db: Database.Database;
const symbol = "BTCUSDT",
  qty = 100_000_000,
  start = Date.parse("2026-11-22T10:00:00Z"),
  due = start + 100000;
const open = (): PerpOrderInput => ({
  action: "openLong",
  symbol,
  leverage: 5,
  quantityAtoms: qty,
  requestKey: randomUUID(),
});
const close = (size = qty): PerpOrderInput => ({
  action: "close",
  symbol,
  quantityAtoms: size,
  requestKey: randomUUID(),
});
function feed(price = 100_000, overrides: Partial<PerpSnapshot> = {}) {
  return async (ticker: string, acceptedAt: number) => {
    vi.setSystemTime(Math.max(Date.now() + 1, acceptedAt + 1));
    return {
      symbol: ticker,
      bidUnits: price,
      askUnits: price,
      markUnits: price,
      asOf: Date.now(),
      minQtyAtoms: 10000,
      qtyStepAtoms: 10000,
      minNotionalUnits: 1000,
      maxQtyAtoms: 1e10,
      nextFundingAt: Math.max(due, Date.now() + 1000),
      ...overrides,
    };
  };
}
const order = (i: PerpOrderInput, price = 100000, user = 1) =>
  placePerpOrder(db, user, i, feed(price));
const convert = (
  user: number,
  direction: "in" | "out",
  amountUnits: number,
  requestKey: string = randomUUID()
) => exchangePerp(db, user, { direction, amountUnits, requestKey });
const config = {
  symbols: ["BTCUSDT", "ETHUSDT"] as ("BTCUSDT" | "ETHUSDT")[],
  depositsEnabled: true,
  tradingEnabled: true,
  userLimitUnits: 1000000,
  platformLimitUnits: 2000000,
};
beforeEach(() => {
  vi.stubEnv("SQLITE_PATH", ":memory:");
  vi.stubEnv("PERP_DEPOSITS_ENABLED", "1");
  vi.stubEnv("PERP_TRADING_ENABLED", "1");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
  // Copy only the app's DDL. All mutable records live in a fresh independent database per test.
  const source = getDb().$client;
  expect(source.name).toBe(":memory:");
  db = new Database(":memory:");
  for (const r of source
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid"
    )
    .all() as { sql: string }[])
    db.exec(r.sql);
  db.exec(PERP_ENGINE_SCHEMA);
  // The experience ledger uses named unique indexes for idempotent awards.
  for (const r of source
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"
    )
    .all() as { sql: string }[]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE sql=?").get(r.sql))
      db.exec(r.sql);
  }
  for (const id of [1, 2])
    db.prepare(
      "INSERT INTO users(id,linuxdo_id,username,group_name,balance) VALUES(?,?,?,?,?)"
    ).run(id, "account-" + id, "tester", "group-" + id, 10);
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
it("redeems free cash and charges the exact fee without doubling a retried exchange", () => {
  expect(getPerpAccount(db, 1).cashUnits).toBe(0);
  const key = randomUUID();
  convert(1, "in", 10000, key);
  convert(1, "in", 10000, key);
  expect(() => convert(1, "in", 10001, key)).toThrow("请求键");
  expect(previewPerpExchange("out", 10001).feeUnits).toBe(501);
  expect(() => convert(1, "out", 10001)).toThrow("可用");
  convert(1, "out", 10000);
  expect(getPerpAccount(db, 1)).toMatchObject({
    availableCashUnits: 0,
    permanentCreditUnits: 9999500,
  });
  expect(db.prepare("SELECT count(*) FROM transactions").pluck().get()).toBe(2);
});
it("quotes integer destination units, flooring conversion and rounding only redemption fees upward", () => {
  const rules = { exchangeRate: 1500, redemptionFeeBps: 333 };
  expect(previewPerpExchange("in", 11, rules)).toEqual({
    direction: "in",
    amountUnits: 11,
    grossUnits: 16,
    feeUnits: 0,
    netUnits: 16,
    ...rules,
  });
  expect(previewPerpExchange("out", 16, rules)).toEqual({
    direction: "out",
    amountUnits: 16,
    grossUnits: 10,
    feeUnits: 1,
    netUnits: 9,
    ...rules,
  });
  expect(() => previewPerpExchange("out", 1, rules)).toThrow("到账为零");
  expect(() => previewPerpExchange("out", 2, rules)).toThrow("到账为零");
  expect(() =>
    previewPerpExchange("in", 1, { ...rules, exchangeRate: 1 })
  ).toThrow("到账为零");
  expect(() =>
    previewPerpExchange("in", Number.MAX_SAFE_INTEGER, rules)
  ).toThrow("有效范围");
  expect(() =>
    previewPerpExchange("out", Number.MAX_SAFE_INTEGER, {
      ...rules,
      exchangeRate: 1,
    })
  ).toThrow("有效范围");
});
it("snapshots financial terms and replays original receipts after edits, while rejecting stale new orders", () => {
  const input = {
    direction: "in" as const,
    amountUnits: 10001,
    requestKey: randomUUID(),
    expectedExchangeRate: 1000,
    expectedRedemptionFeeBps: 500,
  };
  const old = exchangePerp(db, 1, input);
  db.prepare("DELETE FROM perp_exchange_rules WHERE exchange_id=?").run(old.id); // A pre-upgrade record
  savePerpConfig(db, { ...config, exchangeRate: 1500, redemptionFeeBps: 0 });
  expect(exchangePerp(db, 1, input)).toEqual(old);
  expect(() =>
    exchangePerp(db, 1, { ...input, requestKey: randomUUID() })
  ).toThrow("兑换规则已变更，请重新预览");
  expect(() =>
    exchangePerp(db, 1, {
      ...input,
      expectedExchangeRate: 1500,
      requestKey: randomUUID(),
    })
  ).toThrow("兑换规则已变更，请重新预览");
  const current = {
    ...input,
    requestKey: randomUUID(),
    expectedExchangeRate: 1500,
    expectedRedemptionFeeBps: 0,
  };
  const deposit = exchangePerp(db, 1, current);
  expect(deposit).toMatchObject({
    netUnits: 15001,
    exchangeRate: 1500,
    redemptionFeeBps: 0,
  });
  savePerpConfig(db, {
    ...config,
    depositsEnabled: false,
    exchangeRate: 500,
    redemptionFeeBps: 10,
  });
  expect(
    exchangePerp(db, 1, {
      ...current,
      expectedExchangeRate: 500,
      expectedRedemptionFeeBps: 10,
    })
  ).toEqual(deposit);
  const account = getPerpAccount(db, 1);
  expect(account.cashUnits).toBe(25002);
  expect(account.exchanges).toEqual([deposit, old]);
});
it("separates site-credit XP basis from simulated weekly cash flows across a rate and fee change", async () => {
  savePerpConfig(db, { ...config, exchangeRate: 2000, redemptionFeeBps: 0 });
  convert(1, "in", 1_000_000);
  await order(open(), 100_000);
  await order(close(), 400_000);
  convert(1, "out", 2_000_000);
  expect(
    db.prepare("SELECT count(*) FROM experience_events").pluck().get()
  ).toBe(0);
  db.prepare("DELETE FROM perp_exp_basis WHERE user_id=1").run();
  savePerpConfig(db, { ...config, exchangeRate: 1500, redemptionFeeBps: 333 });
  const key = randomUUID();
  const payout = convert(1, "out", 150_004, key);
  expect(payout).toMatchObject({
    grossUnits: 100_002,
    netUnits: 96_671,
    feeUnits: 3331,
  });
  expect(convert(1, "out", 150_004, key)).toEqual(payout);
  expect(
    db
      .prepare("SELECT usd_units FROM experience_events WHERE user_id=1")
      .pluck()
      .all()
  ).toEqual([96_671]);
  expect(
    db
      .prepare(
        "SELECT cash_delta_units FROM perp_events WHERE kind IN ('in','out') ORDER BY id"
      )
      .pluck()
      .all()
  ).toEqual([2_000_000, -2_000_000, -150_004]);
  expect(getPerpAccount(db, 1).permanentCreditUnits).toBe(10_096_671);
});
it("awards income XP only on net redemptions above outstanding principal", async () => {
  convert(1, "in", 1_000_000);
  await order(open(), 100_000);
  await order(close(), 400_000);
  convert(1, "out", 1_000_000); // net 950,000, still short of principal
  const events = () =>
    db
      .prepare(
        "SELECT usd_units FROM experience_events WHERE user_id=1 ORDER BY id"
      )
      .pluck()
      .all();
  expect(events()).toEqual([]);
  // Simulate the first exchange after upgrading an account with existing history.
  db.prepare("DELETE FROM perp_exp_basis WHERE user_id=1").run();
  const key = randomUUID();
  convert(1, "out", 200_000, key); // net 190,000: 50,000 principal and 140,000 income
  convert(1, "out", 200_000, key);
  expect(events()).toEqual([140_000]);
  expect(
    db
      .prepare("SELECT total_exp FROM level_profiles WHERE user_id=1")
      .pluck()
      .get()
  ).toBe(14);
  convert(1, "in", 100_000); // new deposit cannot be counted as previously earned profit
  convert(1, "out", 100_000);
  expect(events()).toEqual([140_000]);
});
it("never converts temporary credit and rolls back a failed dual-ledger write", () => {
  db.prepare(
    "INSERT INTO credit_grants(user_id,redemption_id,code_id,code,remaining_units,original_units,expires_at) VALUES(1,1,1,'TEST',9000000,9000000,?)"
  ).run(due);
  expect(getPerpAccount(db, 1).permanentCreditUnits).toBe(1000000);
  expect(() => convert(1, "in", 1000001)).toThrow("永久额度不足");
  db.exec(
    "CREATE TRIGGER fail_event BEFORE INSERT ON perp_events BEGIN SELECT RAISE(ABORT,'injected'); END"
  );
  expect(() => convert(1, "in", 1000000)).toThrow("injected");
  expect(getPerpAccount(db, 1)).toMatchObject({
    permanentCreditUnits: 1000000,
    availableCashUnits: 0,
    exchanges: [],
  });
  expect(db.prepare("SELECT count(*) FROM transactions").pluck().get()).toBe(0);
});
it("locks only isolated margin, charges both sides, and closes longs against bids in pieces", async () => {
  convert(1, "in", 100000);
  const input = open();
  const first = await placePerpOrder(
    db,
    1,
    input,
    feed(100000, { bidUnits: 99990 })
  );
  expect(first).toMatchObject({
    priceUnits: 100000,
    feeUnits: 60,
    side: "long",
  });
  expect(await placePerpOrder(db, 1, input, async () => null)).toEqual(first);
  const account = () => getPerpAccount(db, 1);
  expect(account()).toMatchObject({
    availableCashUnits: 79940,
    frozenCashUnits: 20000,
  });
  expect(() => convert(1, "out", 80000)).toThrow("可用");
  await expect(order({ ...open(), action: "openShort" })).rejects.toThrow(
    "先平仓"
  );
  const half = await order(close(qty / 2), 110000);
  expect(half).toMatchObject({ pnlUnits: 5000, feeUnits: 33 });
  expect(account().positions[0]).toMatchObject({
    quantityAtoms: qty / 2,
    marginUnits: 10000,
    entryNotionalUnits: 50000,
  });
  await order(close(qty / 2), 110000);
  expect(account().availableCashUnits).toBe(109874);
  expect(account().positions).toHaveLength(0);
  expect(
    db
      .prepare("SELECT sum(cash_delta_units) FROM perp_events WHERE user_id=1")
      .pluck()
      .get()
  ).toBe(109874);
});
it("rejects a pending open when its contract becomes close-only before the price arrives", async () => {
  convert(1, "in", 200_000);
  const before = getPerpAccount(db, 1);
  await expect(placePerpOrder(db, 1, open(), async (ticker, at) => {
    savePerpConfig(db, {...config, closeOnlySymbols:[ticker]});
    return feed()(ticker, at);
  })).rejects.toThrow("暂停开仓");
  expect(getPerpAccount(db, 1)).toEqual(before);
});
it("rechecks aggregate user/platform risk and open switch inside settlement, permits reduce-only exits", async () => {
  for (const user of [1, 2]) convert(user, "in", 200000);
  savePerpConfig(db, {
    ...config,
    userLimitUnits: 150000,
    platformLimitUnits: 175000,
  });
  await order(open());
  await expect(order({ ...open(), symbol: "ETHUSDT" })).rejects.toThrow(
    "仓位上限"
  );
  await expect(order(open(), 100000, 2)).rejects.toThrow("仓位上限");
  await expect(
    placePerpOrder(
      db,
      2,
      { ...open(), quantityAtoms: qty / 10 },
      async (s, t) => {
        savePerpConfig(db, { ...config, tradingEnabled: false });
        return feed()(s, t);
      }
    )
  ).rejects.toThrow("暂停开仓");
  expect((await order(close())).action).toBe("close");
});
it("refuses disconnected, pre-acceptance, expired, future or crossed quotes and invalid lots", async () => {
  convert(1, "in", 100000);
  for (const asOf of [start, start - 5000, start + 99999])
    await expect(
      placePerpOrder(db, 1, open(), feed(100000, { asOf }))
    ).rejects.toThrow("报价");
  await expect(placePerpOrder(db, 1, open(), async () => null)).rejects.toThrow(
    "报价"
  );
  await expect(
    placePerpOrder(db, 1, open(), feed(100000, { bidUnits: 100001 }))
  ).rejects.toThrow("报价");
  await expect(order({ ...open(), quantityAtoms: qty + 1 })).rejects.toThrow(
    "步长"
  );
  expect(getPerpAccount(db, 1).availableCashUnits).toBe(100000);
});
it("settles short funding once, prohibits evading a due interval, covers short at the ask", async () => {
  convert(1, "in", 100000);
  await placePerpOrder(
    db,
    1,
    { ...open(), action: "openShort" },
    feed(100000, { askUnits: 100100 })
  );
  vi.setSystemTime(due);
  await expect(order(close(), 90000)).rejects.toThrow("资金费待确认");
  const f = {
    asOf: due,
    rateE8: 1000000,
    markUnits: 100000,
    nextFundingAt: due + 86400000,
  };
  expect(applyPerpFunding(db, symbol, f)).toBe(1);
  expect(applyPerpFunding(db, symbol, f)).toBe(0);
  expect(getPerpAccount(db, 1).funding[0].amountUnits).toBe(1000);
  const receipt = await placePerpOrder(
    db,
    1,
    close(),
    feed(90000, { bidUnits: 89900 })
  );
  expect(receipt).toMatchObject({
    priceUnits: 90000,
    pnlUnits: 10000,
    feeUnits: 54,
  });
  expect(getPerpAccount(db, 1).availableCashUnits).toBe(110886);
});
it("liquidates at fresh mark only and caps gap loss at isolated collateral", async () => {
  convert(1, "in", 100000);
  await order(open());
  const q = {
    symbol,
    bidUnits: 70000,
    askUnits: 70100,
    markUnits: 75000,
    asOf: Date.now(),
  };
  expect(liquidatePerpPositions(db, { ...q, asOf: q.asOf - 5001 })).toBe(0);
  expect(liquidatePerpPositions(db, q)).toBe(1);
  expect(liquidatePerpPositions(db, q)).toBe(0);
  expect(getPerpAccount(db, 1)).toMatchObject({
    availableCashUnits: 79940,
    frozenCashUnits: 0,
    positions: [],
    orders: [
      { action: "liquidate", pnlUnits: -20000, feeUnits: 0 },
      { action: "openLong" },
    ],
  });
});
it("commits the liquidation even when the triggering user order is refused", async () => {
  convert(1, "in", 100000);
  await order(open());
  const trigger = open();
  await expect(order(trigger, 75000)).rejects.toThrow("强平");
  await expect(order(trigger)).rejects.toThrow("请求键");
  expect(getPerpAccount(db, 1).positions).toHaveLength(0);
});
it("isolates concurrent debits and replays identical simultaneous open requests once", async () => {
  convert(1, "in", 30000);
  const i = open();
  const result = await Promise.all([order(i), order(i)]);
  expect(result[0]).toEqual(result[1]);
  await expect(order(open())).rejects.toThrow("可用模拟金");
  expect(getPerpAccount(db, 1).orders).toHaveLength(1);
});
