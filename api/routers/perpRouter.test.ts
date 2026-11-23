import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("adds ANTUSDT, runs a short, closes a close-only position, and archives trading PnL after removing the symbol", async () => {
  vi.stubEnv("SQLITE_PATH", ":memory:");
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.parse("2026-11-21T17:00:00+08:00");
  vi.setSystemTime(start);
  const [{ appRouter }, { getDb }, { users, sessions, adminSessions }, weeks] =
    await Promise.all([
      import("../router"),
      import("../queries/connection"),
      import("../../db/schema"),
      import("../perp/weekly"),
    ]);
  const db = getDb();
  expect(db.$client.name).toBe(":memory:");
  const [u] = db
    .insert(users)
    .values({
      linuxdoId: "perp-test",
      username: "合约玩家",
      groupName: "测试账号",
      balance: 10,
    })
    .returning()
    .all();
  const member = randomUUID(),
    admin = randomUUID(),
    expiresAt = new Date(start + 30 * 86400000);
  db.insert(sessions).values({ token: member, userId: u.id, expiresAt }).run();
  db.insert(adminSessions).values({ token: admin, expiresAt }).run();
  const caller = (cookie: string) =>
    appRouter.createCaller({
      req: new Request("http://localhost", { headers: { cookie } }),
      resHeaders: new Headers(),
    });
  const perps = caller("ld_session=" + member).perps,
    settings = caller("ld_admin=" + admin).admin.perpSettings;
  await expect(caller("").perps.account()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  const ops = {
    symbols: ["BTCUSDT", "ETHUSDT", "ANTUSDT"],
    depositsEnabled: true,
    tradingEnabled: true,
    minLeverage: 1,
    maxLeverage: 100,
    userLimitUnits: 100_000_000,
    platformLimitUnits: 1_000_000_000,
  };
  let bid = 100_000_000,
    ask = 100_001_000;
  let antPhase = "Finished";
  vi.stubGlobal("fetch", async (url: URL) => {
    expect(url.origin).toBe("https://api.bybit.com");
    vi.setSystemTime(Date.now() + 50);
    const symbol = url.searchParams.get("symbol");
    if (url.pathname.endsWith("/orderbook")) {
      const ts = Date.now();
      return Response.json({
        retCode: 0,
        time: ts,
        result: {
          s: symbol,
          ts,
          cts: ts,
          u: ts,
          seq: ts,
          b: [[String(bid / 1000), "10"]],
          a: [[String(ask / 1000), "10"]],
        },
      });
    }
    if (url.pathname.endsWith("/kline")) {
      const ms = Number(url.searchParams.get("interval")) * 60_000;
      return Response.json({
        retCode: 0,
        time: Date.now(),
        result: {
          category: "linear",
          symbol,
          list: [
            [
              String(Math.floor(Date.now() / ms) * ms),
              "100",
              "101",
              "99",
              "100",
              "1",
              "100",
            ],
          ],
        },
      });
    }
    const row = url.pathname.endsWith("/tickers")
      ? {
          symbol,
          bid1Size: "100",
          ask1Size: "100",
          bid1Price: String(bid / 1000),
          ask1Price: String(ask / 1000),
          markPrice: String(bid / 1000),
          lastPrice: String(bid / 1000),
          fundingRate: "0.0001",
          nextFundingTime: String(start + 3600000),
          curPreListingPhase: symbol === "ANTUSDT" ? antPhase : "",
        }
      : {
          symbol,
          baseCoin: symbol?.slice(0, -4),
          contractType: "LinearPerpetual",
          status: "Trading",
          settleCoin: "USDT",
          quoteCoin: "USDT",
          isPreListing: false,
          priceFilter: { tickSize: symbol === "ANTUSDT" ? "0.01" : "0.10" },
          lotSizeFilter: {
            qtyStep: "0.001",
            minOrderQty: "0.001",
            maxMktOrderQty: "1",
            minNotionalValue: "5",
          },
          leverageFilter: { maxLeverage: "100.00" },
          fundingInterval: 480,
        };
    return Response.json({
      retCode: 0,
      time: Date.now(),
      result: { category: "linear", list: [row] },
    });
  });
  await expect(
    perps.placeOrder({
      symbol: "ANTUSDT",
      action: "openLong",
      quantityAtoms: 1_000_000,
      requestKey: randomUUID(),
    })
  ).rejects.toThrow("未开放");
  expect(await settings.lookup({ symbol: "ANTUSDT" })).toMatchObject({
    symbol: "ANTUSDT",
    qtyStepUnits: 100_000,
  });
  await settings.update(ops);
  expect(await perps.symbols()).toContainEqual(
    expect.objectContaining({ symbol: "ANTUSDT", openEnabled: true })
  );
  const defaultMarket = await perps.market({ symbol: "ANTUSDT" });
  expect(defaultMarket).toMatchObject({
    interval: 1,
    bars: [{ complete: false }],
    quote: null,
    readOnlyReason: expect.stringContaining("Finished"),
  });
  const wider = await perps.market({ symbol: "ANTUSDT", interval: 5 });
  expect(wider.interval).toBe(5);
  expect(wider.bars[0].endAt - defaultMarket.bars[0].endAt).toBe(4 * 60_000);
  await expect(
    perps.market({ symbol: "ANTUSDT", interval: 2 as 1 })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  vi.setSystemTime(Date.now() + 1100);
  const request = { direction: "in" as const, amountUnits: 5_000_000 };
  const prior = await perps.exchangePreview(request);
  expect(prior.estimatedExp).toBe(0);
  const deposit = {
    ...request,
    expectedExchangeRate: 2000,
    expectedRedemptionFeeBps: 250,
    requestKey: randomUUID(),
  };
  await settings.update({ ...ops, exchangeRate: 2000, redemptionFeeBps: 250 });
  await expect(
    perps.exchange({
      ...deposit,
      expectedExchangeRate: prior.exchangeRate,
      expectedRedemptionFeeBps: prior.redemptionFeeBps,
    })
  ).rejects.toMatchObject({
    code: "CONFLICT",
    message: expect.stringContaining("重新预览"),
  });
  expect((await perps.account()).permanentCreditUnits).toBe(10_000_000);
  expect(await perps.exchangePreview(request)).toMatchObject({
    netUnits: 10_000_000,
    exchangeRate: 2000,
    redemptionFeeBps: 250,
  });
  await perps.exchange(deposit);
  await perps.exchange(deposit);
  const open = {
    symbol: "ANTUSDT",
    action: "openShort" as const,
    quantityAtoms: 1_000_000,
    leverage: 25,
    requestKey: randomUUID(),
  };
  // A limit order belongs to its submitting member and does not place an immediate market order.
  const limit = {
    ...open,
    kind: "limit" as const,
    limitPriceUnits: bid + 1_000,
    requestKey: randomUUID(),
  };
  const rejection = {
    code: "BAD_REQUEST",
    message: expect.stringContaining("Finished"),
  };
  await expect(perps.placeOrder(open)).rejects.toMatchObject(rejection);
  await expect(perps.createPending(limit)).rejects.toMatchObject(rejection);
  expect((await perps.account()).availableCashUnits).toBe(10_000_000);
  expect(await perps.pendingOrders()).toHaveLength(0);
  antPhase = "";
  vi.setSystemTime(Date.now() + 1100);
  const receipt = await perps.createPending(limit);
  expect(receipt).toMatchObject({ status: "pending", orderType: "limit" });
  expect(await perps.createPending(limit)).toMatchObject({ id: receipt.id });
  expect((await perps.pendingOrders()).map(p => p.id)).toContain(receipt.id);
  await expect(caller("").perps.pendingOrders()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  const other = db
    .insert(users)
    .values({
      linuxdoId: "other-perp",
      username: "other",
      groupName: "其他玩家",
    })
    .returning()
    .get();
  const otherToken = randomUUID();
  db.insert(sessions)
    .values({ token: otherToken, userId: other.id, expiresAt })
    .run();
  const otherPerps = caller("ld_session=" + otherToken).perps;
  expect(await otherPerps.pendingOrders()).toHaveLength(0);
  antPhase = "Finished";
  vi.setSystemTime(Date.now() + 1100);
  expect(await perps.market({ symbol: "ANTUSDT" })).toMatchObject({
    quote: null,
    readOnlyReason: expect.stringContaining("Finished"),
  });
  await expect(otherPerps.cancelPending({ id: receipt.id })).rejects.toThrow();
  expect(await perps.cancelPending({ id: receipt.id })).toMatchObject({
    status: "cancelled",
  });
  expect((await perps.account()).availableCashUnits).toBe(10_000_000);
  vi.setSystemTime(Date.now() + 1100);
  antPhase = "";
  const fill = await perps.placeOrder(open);
  expect(fill).toMatchObject({
    side: "short",
    leverage: 25,
    priceUnits: bid,
    feeUnits: 600,
  });
  expect(await perps.placeOrder(open)).toEqual(fill);
  expect(await perps.account()).toMatchObject({
    availableCashUnits: 9_959_400,
    frozenCashUnits: 40_000,
  });
  const [position] = (await perps.account()).positions;
  const topUp = {
    symbol: open.symbol,
    openedAt: position.openedAt,
    amountUnits: 25_000,
  };
  await expect(otherPerps.previewMargin(topUp)).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  vi.setSystemTime(Date.now() + 350);
  const preview = await perps.previewMargin(topUp);
  expect(preview).toMatchObject({
    previousMarginUnits: 40_000,
    marginUnits: 65_000,
    availableCashUnits: 9_934_400,
  });
  expect(preview.liquidationPriceUnits).toBeGreaterThan(
    preview.previousLiquidationPriceUnits!
  );
  expect((await perps.account()).availableCashUnits).toBe(9_959_400);
  const topUpRequest = { ...topUp, requestKey: randomUUID() };
  vi.setSystemTime(Date.now() + 350);
  expect(await perps.addMargin(topUpRequest)).toEqual(preview);
  expect(await perps.addMargin(topUpRequest)).toEqual(preview);
  await expect(
    perps.addMargin({ ...topUpRequest, amountUnits: 1 })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const topped = await perps.account();
  expect(topped).toMatchObject({
    availableCashUnits: 9_934_400,
    frozenCashUnits: 65_000,
    orders: [fill],
  });
  expect(topped.positions[0]).toMatchObject({
    marginUnits: 65_000,
    quantityAtoms: position.quantityAtoms,
    entryNotionalUnits: position.entryNotionalUnits,
    leverage: position.leverage,
    liquidationPriceUnits: preview.liquidationPriceUnits,
  });
  await expect(
    settings.update({ ...ops, symbols: ["BTCUSDT", "ETHUSDT"] })
  ).rejects.toThrow(/持仓/);
  await settings.update({
    ...ops,
    closeOnlySymbols: [open.symbol],
    tradingEnabled: true,
    depositsEnabled: false,
    exchangeRate: 2000,
    redemptionFeeBps: 250,
  });
  vi.setSystemTime(Date.now() + 1000);
  await expect(
    perps.placeOrder({ ...open, requestKey: randomUUID() })
  ).rejects.toThrow(/暂停开仓/);
  vi.setSystemTime(Date.now() + 1000);
  ask = 90_000_000;
  bid = 89_999_000;
  const close = await perps.placeOrder({
    symbol: open.symbol,
    action: "close",
    quantityAtoms: open.quantityAtoms,
    requestKey: randomUUID(),
  });
  expect(close).toMatchObject({
    priceUnits: ask,
    pnlUnits: 100_000,
    feeUnits: 540,
  });
  const wallet = await perps.account();
  expect(wallet.availableCashUnits).toBe(10_098_860);
  expect(wallet.positions).toHaveLength(0);
  expect(
    await perps.exchange({
      direction: "out",
      amountUnits: wallet.availableCashUnits,
      expectedExchangeRate: 2000,
      expectedRedemptionFeeBps: 250,
      requestKey: randomUUID(),
    })
  ).toMatchObject({
    grossUnits: 5_049_430,
    feeUnits: 126_236,
    netUnits: 4_923_194,
  });
  await settings.update({ ...ops, symbols: ["BTCUSDT", "ETHUSDT"] });
  expect((await perps.symbols()).some(s => s.symbol === open.symbol)).toBe(
    false
  );
  const weekStart = weeks.perpWeekStart(start);
  vi.setSystemTime(weekStart + 7 * 86400000 + 300_001);
  expect(weeks.settlePerpWeeks(db.$client).published).toBe(1);
  expect(await perps.weekBoard({ weekStart, side: "profit" })).toMatchObject({
    total: 1,
    mine: { rank: 1, pnlUnits: 98_860 },
  });
  expect((await perps.weeks()).weeks[0].weekStart).toBe(weekStart);
});
