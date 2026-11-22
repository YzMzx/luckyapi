import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("ranks complete all-position totals before paging and never exposes private identifiers", async () => {
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
  const players = db
    .insert(users)
    .values(
      Array.from({ length: 7 }, (_, i) => ({
        linuxdoId: "live-" + i,
        username: "private-" + i,
        groupName: "玩家" + i,
        balance: 12,
        banned: i === 6,
      }))
    )
    .returning()
    .all();
  const tokens = players.map(() => randomUUID());
  db.insert(sessions)
    .values(
      players.map((p, i) => ({
        userId: p.id,
        token: tokens[i],
        expiresAt: new Date(now + 600_000),
      }))
    )
    .run();
  const query = (i: number) =>
    appRouter.createCaller({
      req: new Request("http://localhost", {
        headers: { cookie: "ld_session=" + (tokens[i] ?? "") },
      }),
      resHeaders: new Headers(),
    }).perps.liveBoard;
  const insert = db.$client.prepare(
    "INSERT INTO perp_positions(user_id,symbol,side,quantity_atoms,entry_units,margin_units,leverage,opened_at,updated_at,next_funding_at) VALUES(?,?,?,100000000,?,20000,5,?,?,?)"
  );
  const pos = (player: number, symbol: string, side: string, entry: number) =>
    insert.run(
      players[player].id,
      symbol,
      side,
      entry,
      now - 1000,
      now - 1000,
      now + 555_555
    );
  // Mark 110: first player's individual BTC winner must be reduced by another position's loss.
  pos(0, "BTCUSDT", "long", 90_000);
  pos(0, "ETHUSDT", "short", 100_000);
  pos(1, "ETHUSDT", "long", 100_000);
  pos(2, "BTCUSDT", "short", 95_000);
  pos(3, "BTCUSDT", "long", 100_000);
  pos(3, "NVDAUSDT", "long", 100_000);
  pos(4, "BTCUSDT", "long", 100_000);
  pos(4, "ETHUSDT", "short", 100_000);
  pos(6, "DOGEUSDT", "long", 1_000);
  const fetchQuote = vi.fn(async (url: URL) => {
    const symbol = url.searchParams.get("symbol")!;
    if (symbol === "NVDAUSDT") return new Response(null, { status: 503 });
    const row = url.pathname.endsWith("/tickers")
      ? {
          symbol,
          bid1Price: "109.99",
          ask1Price: "110.01",
          bid1Size: "1",
          ask1Size: "1",
          markPrice: "110",
          lastPrice: "108",
          fundingRate: "0",
          nextFundingTime: String(now + 555_555),
        }
      : {
          symbol,
          contractType: "LinearPerpetual",
          status: "Trading",
          baseCoin: symbol.slice(0, -4),
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
  await expect(query(-1)({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(fetchQuote).not.toHaveBeenCalled();
  const board = await query(0)({ page: 2, pageSize: 1 });
  expect(board).toMatchObject({
    total: 4,
    page: 2,
    totalPages: 4,
    pendingPlayers: 1,
    mine: { positionCount: 2, rank: 1, pnlUnits: 10_000 },
  });
  expect(board.rows).toEqual([
    {
      nickname: "玩家1",
      pnlUnits: 10_000,
      positionCount: 1,
      rank: 1,
      mine: false,
    },
  ]);
  expect(
    fetchQuote.mock.calls.filter(([u]) => u.pathname.endsWith("/tickers"))
  ).toHaveLength(2);
  expect(
    fetchQuote.mock.calls.some(
      ([u]) => u.searchParams.get("symbol") === "DOGEUSDT"
    )
  ).toBe(false);
  const all = await query(2)({});
  expect(all.rows.map(row => [row.pnlUnits, row.rank])).toEqual([
    [10_000, 1],
    [10_000, 1],
    [0, 3],
    [-15_000, 4],
  ]);
  expect(all.mine).toEqual({ pnlUnits: -15_000, rank: 4, positionCount: 1 });
  expect((await query(3)({})).mine).toEqual({
    pnlUnits: null,
    rank: null,
    positionCount: 2,
  });
  expect((await query(4)({})).mine).toEqual({
    pnlUnits: 0,
    rank: 3,
    positionCount: 2,
  });
  expect((await query(5)({})).mine).toBeNull();
});
