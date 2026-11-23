import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

const beforeMidnight = new Date("2026-11-23T15:59:00.000Z");
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("keeps preview non-financial, scopes admin configuration and hides wallet risk data", async () => {
  vi.stubEnv("SQLITE_PATH", ":memory:");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(beforeMidnight);
  const [{ appRouter }, { getDb }, { users, sessions, adminSessions }, { createSevenPickRound, openSevenPickRound }] = await Promise.all([
    import("../router"), import("../queries/connection"), import("../../db/schema"), import("../seven-pick/engine"),
  ]);
  const db = getDb();
  const userId = db.insert(users).values({ linuxdoId: randomUUID(), username: "treasure-player", groupName: "treasure-player" }).returning().get().id;
  const memberToken = randomUUID();
  const adminToken = randomUUID();
  const expiresAt = new Date(beforeMidnight.getTime() + 24 * 3600_000);
  db.insert(sessions).values({ token: memberToken, userId, expiresAt }).run();
  db.insert(adminSessions).values({ token: adminToken, expiresAt }).run();
  const caller = (cookie = "") => appRouter.createCaller({
    req: new Request("http://localhost/api/trpc", { headers: { cookie } }), resHeaders: new Headers(),
  });
  const guest = caller();
  const member = caller("ld_session=" + memberToken);
  const admin = caller("ld_admin=" + adminToken);
  await expect(guest.sevenPick.account()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(member.admin.sevenPick.overview()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const initial = await guest.sevenPick.overview();
  expect(initial).toMatchObject({ name: "七星寻宝", round: null, acceptingOrders: false });
  expect(initial.preview.items).toHaveLength(32);
  expect(initial.preview.openMinutes).toEqual([780, 840, 900, 960, 1020, 1080, 1140, 1200, 1260]);
  expect(await member.sevenPick.account()).toEqual({ cashUnits: 0, orders: [] });
  const input = { expectedVersionId: null, config: { enabled: true, ...initial.preview } };
  await expect(member.admin.sevenPick.save(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const saved = await admin.admin.sevenPick.save(input);
  expect(saved.effectiveAt).toBe(Date.parse("2026-11-23T16:00:00Z"));
  await expect(admin.admin.sevenPick.save(input)).rejects.toMatchObject({ code: "CONFLICT" });
  const audit = db.$client.prepare("SELECT detail FROM admin_logs WHERE action='seven_pick_config_saved'").pluck().all();
  expect(audit).toEqual([JSON.stringify({ versionId: saved.id, effectiveAt: saved.effectiveAt })]);
  expect((await admin.admin.sevenPick.overview()).active.enabled).toBe(false);

  const opensAt = Date.parse("2026-11-24T05:00:00.000Z");
  vi.setSystemTime(opensAt - 1000);
  const round = createSevenPickRound(db.$client, opensAt);
  expect(await guest.sevenPick.history()).toEqual([]);
  db.$client.prepare("INSERT INTO perp_wallets (user_id,cash_units) VALUES (?,?)").run(userId, 250_000_000);
  vi.setSystemTime(opensAt);
  expect(openSevenPickRound(db.$client, round.id).status).toBe("open");
  const overview = await guest.sevenPick.overview();
  expect(overview).toMatchObject({ round: { id: round.id, status: "open" }, acceptingOrders: false });
  for (const result of [overview.round, await guest.sevenPick.round({ roundId: round.id }), ...(await guest.sevenPick.history())]) {
    expect(result).not.toHaveProperty("riskLimitUnits");
    expect(result).not.toHaveProperty("maxExposureUnits");
  }
  expect((await admin.admin.sevenPick.overview()).rounds[0].riskLimitUnits).toBe("50000000");
  expect(await member.sevenPick.account()).toEqual({ cashUnits: 250_000_000, orders: [] });
  expect(db.$client.prepare("SELECT count(*) FROM seven_pick_ledger").pluck().get()).toBe(0);
});
