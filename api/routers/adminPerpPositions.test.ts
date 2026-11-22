import { randomUUID } from "node:crypto";
import { afterEach, it, expect, vi } from "vitest";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("restricts all-account positions to admins and keeps position rows when quotes are unavailable", async () => {
  vi.stubEnv("SQLITE_PATH", ":memory:");
  const [{ getDb }, { appRouter }, { users, sessions, adminSessions }] =
    await Promise.all([
      import("../queries/connection"),
      import("../router"),
      import("../../db/schema"),
    ]);
  const db = getDb();
  expect(db.$client.name).toBe(":memory:");
  const [alice, bob] = db
    .insert(users)
    .values([
      { linuxdoId: "77101", username: "Alice", groupName: "一号" },
      { linuxdoId: "77102", username: "Bob", groupName: "二号" },
    ])
    .returning()
    .all();
  const member = randomUUID(),
    admin = randomUUID(),
    expiresAt = new Date(Date.now() + 60000);
  db.insert(sessions)
    .values({ token: member, userId: alice.id, expiresAt })
    .run();
  db.insert(adminSessions).values({ token: admin, expiresAt }).run();
  const call = (cookie: string) =>
    appRouter.createCaller({
      req: new Request("http://localhost", { headers: { cookie } }),
      resHeaders: new Headers(),
    }).admin.listPerpPositions;
  for (const cookie of ["", "ld_session=" + member])
    await expect(call(cookie)({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

  const list = call("ld_admin=" + admin);
  expect((await list({})).total).toBe(0);
  const now = Date.now() - 10000;
  const insert = db.$client.prepare(
    "INSERT INTO perp_positions(user_id,symbol,side,quantity_atoms,entry_units,margin_units,leverage,opened_at,updated_at,next_funding_at) VALUES(?,?,?,100000000,100000,20000,5,?,?,?)"
  );
  insert.run(alice.id, "NVDAUSDT", "long", now, now, now + 999999);
  insert.run(bob.id, "NVDAUSDT", "short", now, now, now + 999999);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now + 10000);
  const fetchQuote = vi.fn(async (url: URL) => {
    const symbol = "NVDAUSDT";
    const row = url.pathname.endsWith("tickers")
      ? {
          symbol,
          bid1Price: "109.99",
          ask1Price: "110.01",
          bid1Size: "10",
          ask1Size: "10",
          markPrice: "110",
          lastPrice: "110",
          fundingRate: "0",
          nextFundingTime: String(now + 999999),
        }
      : {
          symbol,
          contractType: "LinearPerpetual",
          status: "Trading",
          baseCoin: "NVDA",
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
  vi.stubGlobal("fetch", fetchQuote);
  const result = await list({});
  expect(result.total).toBe(2);
  expect(result.items.map(r => [r.userId, r.pnlUnits])).toEqual([
    [alice.id, 10000],
    [bob.id, -10000],
  ]);
  expect(
    fetchQuote.mock.calls.filter(([url]) => url.pathname.endsWith("tickers"))
  ).toHaveLength(1);
  expect(
    (await list({ user: "alice", symbol: "NVDAUSDT", side: "short" })).total
  ).toBe(0);
  expect((await list({ user: "二号" })).items[0].userId).toBe(bob.id);
  expect((await list({ user: "77101" })).items[0].userId).toBe(alice.id);
  vi.setSystemTime(Date.now() + 10000);
  fetchQuote.mockRejectedValue(Error("offline"));
  const last = await list({ pageSize: 1, page: 100 });
  expect(last).toMatchObject({
    page: 2,
    total: 2,
    items: [
      {
        userId: bob.id,
        markPriceUnits: null,
        pnlUnits: null,
        entryPriceUnits: 100000,
        leverage: 5,
      },
    ],
  });
  expect(
    db.$client.prepare("SELECT count(*) FROM perp_positions").pluck().get()
  ).toBe(2);
});
