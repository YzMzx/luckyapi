import { randomUUID } from "node:crypto";
import { afterEach, it, expect, vi } from "vitest";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
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
  await expect(caller("").perps.positionSquare({})).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller("").perps.heartbeat()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
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
    onlineHolders: 0,
  });
});
