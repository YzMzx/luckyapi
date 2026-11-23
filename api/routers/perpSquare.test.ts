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
  const square = viewer.perps.positionSquare;
  const first = await square({});
  expect(first.onlineHolders).toBe(1);
  expect(first.groups.map(g => [g.symbol, g.total, g.page])).toEqual([
    ["BTCUSDT", 1, 1],
    ["ETHUSDT", 1, 1],
    ["NVDAUSDT", 1, 1],
  ]);
  expect(first.groups[0].items[0]).toEqual({
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
  expect(first.groups[1].items[0]).toMatchObject({
    nickname: "乙",
    online: false,
    mine: true,
  });
  await expect(square({ pages: { invalid: 1 } })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  // Pagination never omits other contracts, and a now-empty last page is clamped.
  const extra = db
    .insert(users)
    .values(
      Array.from({ length: 21 }, (_, i) => ({
        linuxdoId: "square-paging-" + i,
        username: "paging-" + i,
        groupName: "持仓玩家" + i,
      }))
    )
    .returning()
    .all();
  for (const player of extra)
    insert.run(player.id, "BTCUSDT", now, now, now + 555555);
  const paged = await square({ pages: { BTCUSDT: 2 } });
  expect(
    paged.groups.map(g => [g.symbol, g.page, g.totalPages, g.items.length])
  ).toEqual([
    ["BTCUSDT", 2, 2, 2],
    ["ETHUSDT", 1, 1, 1],
    ["NVDAUSDT", 1, 1, 1],
  ]);
  const erase = db.$client.prepare(
    "DELETE FROM perp_positions WHERE user_id=?"
  );
  for (const player of extra) erase.run(player.id);
  expect((await square({ pages: { BTCUSDT: 2 } })).groups[0].page).toBe(1);

  // Two users with the same contract reuse a quote; an old quote will not value a newer position.
  insert.run(b.id, "BTCUSDT", now, now + 1, now + 555555);
  db.$client
    .prepare("UPDATE perp_positions SET side=? WHERE user_id=? AND symbol=?")
    .run("short", b.id, "BTCUSDT");
  expect((await square({})).groups[0].items).toMatchObject([
    { nickname: "乙", side: "short", markPriceUnits: null, pnlUnits: null },
    { nickname: "甲", side: "long", markPriceUnits: 110_000, pnlUnits: 10_000 },
  ]);
  bybit.mockClear();
  vi.setSystemTime(now + 5_000);
  markPrice = "95";
  expect((await square({})).groups[0].items).toMatchObject([
    { nickname: "乙", side: "short", markPriceUnits: 95_000, pnlUnits: 5_000 },
    { nickname: "甲", side: "long", markPriceUnits: 95_000, pnlUnits: -5_000 },
  ]);
  expect(
    bybit.mock.calls.filter(([url]) => url.pathname.endsWith("/tickers"))
  ).toHaveLength(1);
  offline = true;
  vi.setSystemTime(now + 10_000);
  expect((await square({})).groups[0]).toMatchObject({
    total: 2,
    items: [
      { markPriceUnits: null, pnlUnits: null },
      { markPriceUnits: null, pnlUnits: null },
    ],
  });
  vi.setSystemTime(now + 90_000);
  expect((await square({})).onlineHolders).toBe(0);
  await caller(ta).perps.heartbeat();
  expect((await square({})).onlineHolders).toBe(1);
  erase.run(a.id);
  expect((await square({})).groups.map(g => g.symbol)).toEqual([
    "BTCUSDT",
    "ETHUSDT",
  ]);
  erase.run(b.id);
  expect(await square({})).toEqual({ groups: [], onlineHolders: 0 });
});
