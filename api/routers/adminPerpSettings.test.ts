import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("only lets administrators view and update Bybit perpetual simulation controls", async () => {
  vi.stubEnv("SQLITE_PATH", ":memory:");
  const [{ appRouter }, { getDb }, { users, sessions, adminSessions }] =
    await Promise.all([
      import("../router"),
      import("../queries/connection"),
      import("../../db/schema"),
    ]);
  const db = getDb();
  expect(db.$client.name).toBe(":memory:");
  const id = db
    .insert(users)
    .values({
      linuxdoId: randomUUID(),
      username: "perp-settings",
      groupName: "perp-settings",
    })
    .returning()
    .get().id;
  const member = randomUUID(),
    admin = randomUUID(),
    expiresAt = new Date(Date.now() + 60000);
  db.insert(sessions).values({ token: member, userId: id, expiresAt }).run();
  db.insert(adminSessions).values({ token: admin, expiresAt }).run();
  const caller = (cookie: string) =>
    appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie } }),
      resHeaders: new Headers(),
    }).admin;
  const edit = {
    symbols: ["BTCUSDT" as const],
    depositsEnabled: true,
    tradingEnabled: false,
    exchangeRate: 1500,
    redemptionFeeBps: 123,
    userLimitUnits: 15000,
    platformLimitUnits: 20000,
  };
  for (const cookie of ["", "ld_session=" + member]) {
    await expect(
      caller(cookie).perpSettings.lookup({ symbol: "NVDAUSDT" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller(cookie).perpSettings.get()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      caller(cookie).perpSettings.update(edit)
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  }
  const api = caller("ld_admin=" + admin);
  expect(await api.perpSettings.get()).toMatchObject({
    exchangeRate: 1000,
    redemptionFeeBps: 500,
  });
  await expect(
    api.perpSettings.update({ ...edit, redemptionFeeBps: 10000 })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const result = await api.perpSettings.update(edit);
  expect(result).toEqual(await api.perpSettings.get());
  expect(result).toMatchObject({
    symbols: [{ symbol: "BTCUSDT" }],
    tradingEnabled: false,
    exchangeRate: 1500,
    redemptionFeeBps: 123,
    maintenanceMarginBps: 50,
    takerFeeBps: 6,
  });
  vi.stubGlobal("fetch", async (url: URL) => {
    const symbol = url.searchParams.get("symbol");
    expect(url.origin).toBe("https://api.bybit.com");
    expect(url.pathname).toBe("/v5/market/instruments-info");
    return Response.json({
      retCode: 0,
      time: Date.now(),
      result: {
        category: "linear",
        list:
          symbol === "NVDAUSDT"
            ? [
                {
                  symbol,
                  baseCoin: "NVDA",
                  contractType: "LinearPerpetual",
                  status: "Trading",
                  settleCoin: "USDT",
                  quoteCoin: "USDT",
                  priceFilter: { tickSize: "0.01" },
                  lotSizeFilter: {
                    qtyStep: "0.001",
                    minOrderQty: "0.001",
                    maxMktOrderQty: "100",
                    minNotionalValue: "5",
                  },
                  leverageFilter: { maxLeverage: "10" },
                  fundingInterval: 480,
                },
              ]
            : [],
      },
    });
  });
  expect(await api.perpSettings.lookup({ symbol: "NVDAUSDT" })).toMatchObject({
    symbol: "NVDAUSDT",
    tickSizeUnits: 10,
  });
  await expect(
    api.perpSettings.lookup({ symbol: "NOCOINUSDT" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const before = await api.perpSettings.get();
  await expect(
    api.perpSettings.update({ ...edit, symbols: ["BTCUSDT", "NOCOINUSDT"] })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await api.perpSettings.get()).toEqual(before);
  expect(
    await api.perpSettings.update({
      ...edit,
      symbols: ["BTCUSDT", "NVDAUSDT"],
      closeOnlySymbols: ["NVDAUSDT"],
    })
  ).toMatchObject({
    symbols: [
      { symbol: "BTCUSDT", openEnabled: true },
      { symbol: "NVDAUSDT", openEnabled: false },
    ],
  });
  expect(JSON.stringify(await api.listAdminLogs())).toContain(
    "更新模拟永续合约配置"
  );
});
