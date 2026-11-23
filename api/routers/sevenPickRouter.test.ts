import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

const beforeMidnight = new Date("2026-11-23T15:59:00.000Z");
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("requires admin control, ignores retired env flags and immediately pauses or resumes new orders", async () => {
  vi.stubEnv("SQLITE_PATH", ":memory:");
  vi.stubEnv("SEVEN_PICK_ENABLED", "0");
  vi.stubEnv("SEVEN_PICK_RFC3161", "1");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(beforeMidnight);
  const [{ appRouter }, { getDb }, { users, sessions, adminSessions }, { createSevenPickRound, openSevenPickRound }] = await Promise.all([
    import("../router"), import("../queries/connection"), import("../../db/schema"), import("../seven-pick/engine"),
  ]);
  const db = getDb();
  const userId = db.insert(users).values({ linuxdoId: randomUUID(), username: "treasure-player", groupName: "treasure-player" }).returning().get().id;
  const memberToken = randomUUID();
  const adminToken = randomUUID();
  const expiresAt = new Date(beforeMidnight.getTime() + 48 * 3600_000);
  db.insert(sessions).values({ token: memberToken, userId, expiresAt }).run();
  const adminRow = db.insert(adminSessions).values({ token: adminToken, expiresAt }).returning().get();
  const caller = (cookie = "") => appRouter.createCaller({
    req: new Request("http://localhost/api/trpc", { headers: { cookie } }), resHeaders: new Headers(),
  });
  const guest = caller();
  const member = caller("ld_session=" + memberToken);
  const admin = caller("ld_admin=" + adminToken);
  await expect(guest.sevenPick.account()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(member.admin.sevenPick.overview()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const initial = await guest.sevenPick.overview();
  expect(initial).toMatchObject({ name: "七星寻宝", round: null, configured: false, paused: false, acceptingOrders: false });
  expect((await admin.admin.sevenPick.overview()).runtime).toEqual({ paused: false, rfc3161Enabled: false });
  await expect(guest.admin.sevenPick.setRuntime({ key: "paused", value: true })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(member.admin.sevenPick.setRuntime({ key: "rfc3161Enabled", value: true })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(await admin.admin.sevenPick.setRuntime({ key: "rfc3161Enabled", value: true })).toEqual({ paused: false, rfc3161Enabled: true });
  expect(initial.preview.items).toHaveLength(32);
  expect(initial.preview.openMinutes).toEqual([780, 840, 900, 960, 1020, 1080, 1140, 1200, 1260]);
  expect(await member.sevenPick.account()).toEqual({ cashUnits: 0, orders: [] });
  const wager = { roundId: 1, requestKey: "launch-gate-test", bets: [{ itemIds: [1, 2, 3, 4, 5, 6, 7], amount: "1.000" }] };
  await expect(guest.sevenPick.place(wager)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(member.admin.sevenPick.audit({ roundId: 1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const input = { expectedVersionId: null, config: { enabled: true, ...initial.preview } };
  await expect(member.admin.sevenPick.save(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const saved = await admin.admin.sevenPick.save(input);
  expect(saved.effectiveAt).toBe(Date.parse("2026-11-23T16:00:00Z"));
  await expect(admin.admin.sevenPick.save(input)).rejects.toMatchObject({ code: "CONFLICT" });
  const audit = db.$client.prepare("SELECT detail FROM admin_logs WHERE action='seven_pick_config_saved'").pluck().all();
  expect(audit).toEqual([JSON.stringify({ versionId: saved.id, effectiveAt: saved.effectiveAt })]);
  expect((await admin.admin.sevenPick.overview()).active.enabled).toBe(false);
  expect((await admin.admin.sevenPick.overview()).manualStartBlock).toBeTruthy();
  await expect(guest.admin.sevenPick.startManualRound({ expectedVersionId: saved.id! })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(member.admin.sevenPick.startManualRound({ expectedVersionId: saved.id! })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(admin.admin.sevenPick.startManualRound({ expectedVersionId: saved.id! })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

  const opensAt = Date.parse("2026-11-24T05:00:00.000Z");
  vi.setSystemTime(opensAt - 1000);
  const round = createSevenPickRound(db.$client, opensAt);
  expect(await guest.sevenPick.history()).toEqual([]);
  db.$client.prepare("INSERT INTO perp_wallets (user_id,cash_units) VALUES (?,?)").run(userId, 250_000_000);
  vi.setSystemTime(opensAt);
  expect(openSevenPickRound(db.$client, round.id).status).toBe("open");
  const overview = await guest.sevenPick.overview();
  expect(overview).toMatchObject({ round: { id: round.id, status: "open" }, configured: true, paused: false, acceptingOrders: true });
  for (const result of [overview.round, await guest.sevenPick.round({ roundId: round.id }), ...(await guest.sevenPick.history())]) {
    expect(result).not.toHaveProperty("riskLimitUnits");
    expect(result).not.toHaveProperty("maxExposureUnits");
  }
  expect((await admin.admin.sevenPick.overview()).rounds[0].riskLimitUnits).toBe("50000000");
  const placed = await member.sevenPick.place({ ...wager, roundId: round.id });
  expect(await admin.admin.sevenPick.setRuntime({ key: "paused", value: true })).toEqual({ paused: true, rfc3161Enabled: true });
  expect(await guest.sevenPick.overview()).toMatchObject({ paused: true, configured: true, acceptingOrders: false });
  await expect(member.sevenPick.place({ ...wager, roundId: round.id, requestKey: "blocked-new-wager" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  expect(await member.sevenPick.place({ ...wager, roundId: round.id })).toEqual(placed);
  expect(await admin.admin.sevenPick.setRuntime({ key: "paused", value: false })).toEqual({ paused: false, rfc3161Enabled: true });
  expect(await guest.sevenPick.overview()).toMatchObject({ paused: false, acceptingOrders: true });
  await expect(admin.admin.sevenPick.reviewRefund({ roundId: round.id, reason: "seal_missed", notes: "仅接口超时" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  expect((await admin.admin.sevenPick.audit({ roundId: round.id })).lifecycle.status).toBe("open");
  const { sevenPickProofApp } = await import("../routes/sevenPickProof");
  expect((await sevenPickProofApp.request("/rounds/" + round.id + "/proof")).status).toBe(404);
  expect((await sevenPickProofApp.request("/rounds/abc/proof")).status).toBe(400);
  expect(await member.sevenPick.account()).toEqual({ cashUnits: 249_999_000, orders: [placed] });
  expect(db.$client.prepare("SELECT count(*) FROM seven_pick_ledger").pluck().get()).toBe(1);
  expect(db.$client.prepare("SELECT detail FROM admin_logs WHERE action='seven_pick_runtime_changed' ORDER BY id").pluck().all()
    .map(detail => JSON.parse(detail as string))).toEqual([
    { adminSessionId: adminRow.id, key: "rfc3161Enabled", before: false, after: true },
    { adminSessionId: adminRow.id, key: "paused", before: false, after: true },
    { adminSessionId: adminRow.id, key: "paused", before: true, after: false },
  ]);

  vi.setSystemTime(round.closesAt + 1);
  const next = await admin.admin.sevenPick.save({
    expectedVersionId: saved.id,
    config: { ...input.config, enabled: false },
  });
  const state = await admin.admin.sevenPick.overview();
  expect(state).toMatchObject({ active: { id: saved.id, enabled: true }, latest: { id: next.id, enabled: false }, manualStartBlock: null });
  await expect(admin.admin.sevenPick.startManualRound({ expectedVersionId: next.id! })).rejects.toMatchObject({ code: "CONFLICT" });
  db.$client.prepare("INSERT INTO settings (key,value) VALUES ('control_maintenance','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  expect((await admin.admin.sevenPick.overview()).manualStartBlock).toContain("维护");
  await expect(admin.admin.sevenPick.startManualRound({ expectedVersionId: saved.id! })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  db.$client.prepare("DELETE FROM settings WHERE key='control_maintenance'").run();
  // Restore sufficient risk budget after the earlier wager reduced free cash.
  db.$client.prepare("UPDATE perp_wallets SET cash_units=250000000 WHERE user_id=?").run(userId);
  const manual = await admin.admin.sevenPick.startManualRound({ expectedVersionId: saved.id! });
  expect(manual).toMatchObject({ status: "open", opensAt: round.closesAt + 1, configVersionId: saved.id });
  expect(await guest.sevenPick.overview()).toMatchObject({ round: { id: manual.id }, acceptingOrders: true });
  await expect(admin.admin.sevenPick.startManualRound({ expectedVersionId: saved.id! })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(db.$client.prepare("SELECT detail FROM admin_logs WHERE action='seven_pick_manual_round_started'").pluck().all().map(detail => JSON.parse(detail as string))).toEqual([
    { adminSessionId: adminRow.id, roundId: manual.id, versionId: saved.id, status: "open", opensAt: manual.opensAt },
  ]);

  // The existing risk limit is authoritative for a manual attempt, too.
  vi.setSystemTime(manual.closesAt + 1);
  db.$client.prepare("UPDATE perp_wallets SET cash_units=0").run();
  const skipped = await admin.admin.sevenPick.startManualRound({ expectedVersionId: saved.id! });
  expect(skipped).toMatchObject({ status: "risk_skipped", riskLimitUnits: "0" });
  expect((await guest.sevenPick.overview()).round?.id).not.toBe(skipped.id);
  expect((await admin.admin.sevenPick.overview()).rounds[0]).toMatchObject({ id: skipped.id, status: "risk_skipped" });

  const activate = { versionId: next.id!, expectedActiveVersionId: saved.id, expectedVersionId: next.id };
  await expect(member.admin.sevenPick.activateRule(activate)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(member.admin.sevenPick.ruleVersions()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(admin.admin.sevenPick.activateRule({ ...activate, versionId: 99999 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  db.$client.prepare("INSERT INTO settings (key,value) VALUES ('control_maintenance','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  expect((await admin.admin.sevenPick.overview()).activationBlocked).toContain("维护");
  await expect(admin.admin.sevenPick.activateRule(activate)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  db.$client.prepare("DELETE FROM settings WHERE key='control_maintenance'").run();
  await admin.admin.sevenPick.setRuntime({ key: "paused", value: true });
  const activated = await admin.admin.sevenPick.activateRule(activate);
  expect(activated).toMatchObject({ enabled: true, effectiveAt: Date.now(), items: next.items });
  expect(activated.id).not.toBe(next.id);
  expect(await admin.admin.sevenPick.overview()).toMatchObject({
    active: { id: activated.id, enabled: true },
    latest: { id: activated.id },
    upcoming: null,
    runtime: { paused: true },
    rounds: expect.arrayContaining([expect.objectContaining({ id: manual.id, configVersionId: saved.id })]),
  });
  await expect(admin.admin.sevenPick.activateRule(activate)).rejects.toMatchObject({ code: "CONFLICT" });
  const pagination = await admin.admin.sevenPick.ruleVersions({ beforeId: activated.id! });
  expect(pagination.items.map(item => item.id)).toEqual([next.id, saved.id]);
  expect(pagination.items[0]).toMatchObject({ id: next.id, canceledAt: activated.effectiveAt });
  expect(pagination.nextBeforeId).toBeNull();
  expect(db.$client.prepare("SELECT detail FROM admin_logs WHERE action='seven_pick_rule_activated'").pluck().all().map(detail => JSON.parse(detail as string))).toEqual([
    { adminSessionId: adminRow.id, sourceVersionId: next.id, previousVersionId: saved.id, versionId: activated.id, effectiveAt: activated.effectiveAt },
  ]);
  vi.setSystemTime(next.effectiveAt);
  expect(await admin.admin.sevenPick.overview()).toMatchObject({ active: { id: activated.id, enabled: true }, upcoming: null });
  const rescheduled = await admin.admin.sevenPick.save({ expectedVersionId: activated.id, config: { ...input.config, enabled: false } });
  expect(await admin.admin.sevenPick.overview()).toMatchObject({ active: { id: activated.id }, upcoming: { id: rescheduled.id } });
  vi.setSystemTime(rescheduled.effectiveAt);
  expect((await guest.sevenPick.overview()).configured).toBe(false);
});
