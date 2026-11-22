import { randomUUID } from "node:crypto";
import { afterEach, it, expect, vi } from "vitest";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("shares only member-facing open positions and expires visible-tab presence", async () => {
  vi.stubEnv("SQLITE_PATH", ":memory:");
  const [{ appRouter }, { getDb }, { users, sessions }] = await Promise.all([
    import("../router"),
    import("../queries/connection"),
    import("../../db/schema"),
  ]);
  const db = getDb();
  expect(db.$client.name).toBe(":memory:");
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = Date.now();
  const [a, b] = db
    .insert(users)
    .values([
      { linuxdoId: "square1", username: "private1", groupName: "甲" },
      { linuxdoId: "square2", username: "private2", groupName: "乙" },
    ])
    .returning()
    .all();
  const ta = randomUUID(),
    tb = randomUUID();
  db.insert(sessions)
    .values(
      [a, b].map((u, i) => ({
        userId: u.id,
        token: [ta, tb][i],
        expiresAt: new Date(now + 600000),
      }))
    )
    .run();
  const caller = (token: string) =>
    appRouter.createCaller({
      req: new Request("http://localhost", {
        headers: { cookie: "ld_session=" + token },
      }),
      resHeaders: new Headers(),
    });
  const insert = db.$client.prepare(
    "INSERT INTO perp_positions(user_id,symbol,side,quantity_atoms,entry_units,margin_units,leverage,opened_at,updated_at,next_funding_at) VALUES(?,?,'long',100000000,100000,20000,5,?,?,?)"
  );
  insert.run(a.id, "BTCUSDT", now, now, now + 555555);
  insert.run(a.id, "NVDAUSDT", now, now, now + 555555);
  insert.run(b.id, "ETHUSDT", now, now, now + 555555);
  let markPrice = "110";
  let offline = false;
  const bybit = vi.fn(async (url: URL) => {
    const symbol = url.searchParams.get("symbol");
    if (offline || symbol !== "BTCUSDT")
      return new Response(null, { status: 503 });
    const row = url.pathname.endsWith("/tickers")
      ? {
          symbol,
          bid1Price: "109.99",
          ask1Price: "110.01",
          bid1Size: "1",
          ask1Size: "1",
          markPrice,
          lastPrice: "108",
          fundingRate: "0",
          nextFundingTime: String(now + 999999),
        }
      : {
          symbol,
          contractType: "LinearPerpetual",
          status: "Trading",
          baseCoin: "BTC",
          settleCoin: "USDT",
          quoteCoin: "USDT",
          priceFilter: { tickSize: "0.01" },
          lotSizeFilter: {
            qtyStep: "0.01",
            minOrderQty: "0.01",
            maxMktOrderQty: "100",
            minNotionalValue: "5",
          },
          leverageFilter: { maxLeverage: "10" },
          fundingInterval: 480,
        };
    return Response.json({
      retCode: 0,
      time: Date.now(),
      result: { category: "linear", list: [row] },
    });
  });
  vi.stubGlobal("fetch", bybit);
  await expect(caller("").perps.positionSquare({})).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller("").perps.heartbeat()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  expect(bybit).not.toHaveBeenCalled();
  const viewer = caller(tb);
  await expect(viewer.admin.listPerpPositions({})).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await caller(ta).perps.heartbeat();
  const first = await viewer.perps.positionSquare({
    pageSize: 1,
    onlineOnly: true,
  });
  expect(first).toMatchObject({ total: 2, totalPages: 2, onlineHolders: 1 });
  expect(first.items[0]).toEqual({
    nickname: "甲",
    symbol: "BTCUSDT",
    side: "long",
    quantityAtoms: 100000000,
    entryPriceUnits: 100000,
    markPriceUnits: 110000,
    pnlUnits: 10000,
    leverage: 5,
    online: true,
    mine: false,
  });
  expect(
    (
      await viewer.perps.positionSquare({
        page: 2,
        pageSize: 1,
        onlineOnly: true,
      })
    ).items[0].symbol
  ).toBe("NVDAUSDT");
  const categories = [
    { symbol: "BTCUSDT", total: 1 },
    { symbol: "ETHUSDT", total: 1 },
    { symbol: "NVDAUSDT", total: 1 },
  ];
  expect(
    await viewer.perps.positionSquare({
      symbol: "NVDAUSDT",
      page: 2,
      pageSize: 1,
    })
  ).toMatchObject({
    categories,
    total: 1,
    page: 1,
    onlineHolders: 1,
    items: [{ symbol: "NVDAUSDT" }],
  });
  expect(
    await viewer.perps.positionSquare({ symbol: "ETHUSDT", onlineOnly: true })
  ).toMatchObject({
    categories,
    total: 0,
    onlineHolders: 0,
    items: [],
  });
  expect(
    await viewer.perps.positionSquare({ symbol: "DOGEUSDT" })
  ).toMatchObject({
    categories,
    total: 0,
    items: [],
  });
  await expect(
    viewer.perps.positionSquare({ symbol: "invalid" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  // Only price the rows requested, and reuse a single quote when users hold the same symbol.
  insert.run(b.id, "BTCUSDT", now, now + 1, now + 555555);
  db.$client
    .prepare("UPDATE perp_positions SET side=? WHERE user_id=? AND symbol=?")
    .run("short", b.id, "BTCUSDT");
  expect(
    (await viewer.perps.positionSquare({ symbol: "BTCUSDT" })).items
  ).toMatchObject([
    { nickname: "乙", side: "short", markPriceUnits: null, pnlUnits: null },
    { nickname: "甲", side: "long", markPriceUnits: 110_000, pnlUnits: 10_000 },
  ]);
  bybit.mockClear();
  vi.setSystemTime(now + 5_000);
  markPrice = "95";
  expect(
    (await viewer.perps.positionSquare({ symbol: "BTCUSDT" })).items
  ).toMatchObject([
    { nickname: "乙", side: "short", markPriceUnits: 95_000, pnlUnits: 5_000 },
    { nickname: "甲", side: "long", markPriceUnits: 95_000, pnlUnits: -5_000 },
  ]);
  expect(bybit).toHaveBeenCalledTimes(1);
  expect(bybit.mock.calls[0][0].pathname).toBe("/v5/market/tickers");
  offline = true;
  vi.setSystemTime(now + 10_000);
  expect(
    await viewer.perps.positionSquare({ symbol: "BTCUSDT" })
  ).toMatchObject({
    total: 2,
    items: [
      { markPriceUnits: null, pnlUnits: null },
      { markPriceUnits: null, pnlUnits: null },
    ],
  });
  db.$client
    .prepare("DELETE FROM perp_positions WHERE user_id=? AND symbol=?")
    .run(b.id, "BTCUSDT");
  vi.setSystemTime(now + 90000);
  expect((await viewer.perps.positionSquare({ onlineOnly: true })).total).toBe(
    0
  );
  expect(
    (await viewer.perps.positionSquare({})).items.find(r => r.mine)?.nickname
  ).toBe("乙");
  await caller(ta).perps.heartbeat();
  expect((await viewer.perps.positionSquare({ onlineOnly: true })).total).toBe(
    2
  );
  db.$client.prepare("DELETE FROM perp_positions WHERE user_id=?").run(a.id);
  expect(await viewer.perps.positionSquare({})).toMatchObject({
    total: 1,
    categories: [{ symbol: "ETHUSDT", total: 1 }],
    onlineHolders: 0,
  });
});
