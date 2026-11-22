import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("adds NVDAUSDT, runs a short, closes a close-only position, and archives trading PnL after removing the symbol", async () => {
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
    symbols: ["BTCUSDT", "ETHUSDT", "NVDAUSDT"],
    depositsEnabled: true,
    tradingEnabled: true,
    userLimitUnits: 100_000_000,
    platformLimitUnits: 1_000_000_000,
  };
  let bid = 100_000_000,
    ask = 100_001_000;
  vi.stubGlobal("fetch", async (url: URL) => {
    expect(url.origin).toBe("https://api.bybit.com");
    vi.setSystemTime(Date.now() + 50);
    const symbol = url.searchParams.get("symbol");
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
        }
      : {
          symbol,
          baseCoin: symbol?.slice(0, -4),
          contractType: "LinearPerpetual",
          status: "Trading",
          settleCoin: "USDT",
          quoteCoin: "USDT",
          priceFilter: { tickSize: "0.10" },
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
      symbol: "NVDAUSDT",
      action: "openLong",
      quantityAtoms: 1_000_000,
      requestKey: randomUUID(),
    })
  ).rejects.toThrow("未开放");
  expect(await settings.lookup({ symbol: "NVDAUSDT" })).toMatchObject({
    symbol: "NVDAUSDT",
    qtyStepUnits: 100_000,
  });
  await settings.update(ops);
  expect(await perps.symbols()).toContainEqual(
    expect.objectContaining({ symbol: "NVDAUSDT", openEnabled: true })
  );
  const request = { direction: "in" as const, amountUnits: 5_000_000 };
  const prior = await perps.exchangePreview(request);
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
    symbol: "NVDAUSDT",
    action: "openShort" as const,
    quantityAtoms: 1_000_000,
    leverage: 5 as const,
    requestKey: randomUUID(),
  };
  const fill = await perps.placeOrder(open);
  expect(fill).toMatchObject({ side: "short", priceUnits: bid, feeUnits: 600 });
  expect(await perps.placeOrder(open)).toEqual(fill);
  expect(await perps.account()).toMatchObject({
    availableCashUnits: 9_799_400,
    frozenCashUnits: 200_000,
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
