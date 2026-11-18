import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

process.env.SQLITE_PATH = join(
  tmpdir(),
  `lucky-levels-router-${process.pid}-${Date.now()}.db`
);

it("ties profile and badge selection to the signed-in member", async () => {
  const { appRouter } = await import("../router");
  const { getDb } = await import("../queries/connection");
  const { users } = await import("../../db/schema");
  const { createSession } = await import("../auth");
  const { grantExperience } = await import("../queries/levels");
  function caller(token = "") {
    return appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", {
        headers: { cookie: `ld_session=${token}` },
      }),
      resHeaders: new Headers(),
    }).levels;
  }
  await expect(caller().hall()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const [first, second] = await getDb()
    .insert(users)
    .values([
      { username: "first", linuxdoId: "1", groupName: "第一位" },
      { username: "second", linuxdoId: "2", groupName: "第二位" },
    ])
    .returning();
  const winner = caller(await createSession(first.id));
  const other = caller(await createSession(second.id));
  await grantExperience(first.id, "example:1", 7980);
  await winner.equip({ level: 10 });
  expect(await winner.profile()).toMatchObject({
    progress: { level: 10 },
    equippedLevel: 10,
  });
  expect(await other.profile()).toMatchObject({
    progress: { level: 1 },
    equippedLevel: null,
  });
  expect(await other.hall()).toMatchObject([
    { level: 10, rank: 1, userName: "第一位" },
  ]);
  await expect(other.equip({ level: 10 })).rejects.toThrow();
  await expect(winner.equip({ level: 11 })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  await winner.equip({ level: null });
  expect((await winner.profile()).equippedLevel).toBeNull();
});
