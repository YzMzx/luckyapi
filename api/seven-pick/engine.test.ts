import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERP_ENGINE_SCHEMA } from "../perp/schema";
import {
  MINUTE_MS,
  activateSevenPickConfig,
  getLatestSevenPickConfig,
  getNextSevenPickConfig,
  getSevenPickConfig,
  listSevenPickConfigVersions,
  saveSevenPickConfig,
  sevenPickConfigInput,
} from "./config";
import { QUICKNET, quicknetRoundAtOrAfter } from "./drand";
import {
  createSevenPickRound,
  getSevenPickManualStartBlock,
  getSevenPickRound,
  getSevenPickSnapshot,
  listSevenPickOrders,
  openSevenPickRound,
  placeSevenPickOrder,
  placeSevenPickOrderForTest,
  startManualSevenPickRound,
} from "./engine";
import { ensureSevenPickLifecycleSchema } from "./lifecycle-schema";
import { tickSevenPickMaintenance } from "./maintenance";
import { sevenPickItemMask } from "./risk";
import { setSevenPickRuntime } from "./release";
import { ensureSevenPickSchema, SEVEN_PICK_SCHEMA } from "./schema";
import { applySevenPickCash, readSevenPickCash } from "./wallet";

const NOW = Date.UTC(2026, 10, 23, 15, 59, 59); // 23:59:59 Beijing
const EFFECTIVE = NOW + 1000;
const HOUR = 3_600_000;
const OPENS = EFFECTIVE + 13 * HOUR;
const MIN_LIMIT = 50_000_000;
const A = [1, 2, 3, 4, 5, 6, 7];
const B = [1, 2, 3, 4, 5, 6, 32];
const group = (id: number) => [1, 2, 3, 4, 5, 6, id];
const bet = (itemIds = A, amount = "1") => ({ itemIds, amount });

function init(db: Database.Database) {
  db.pragma("foreign_keys = ON");
  db.exec(
    "CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2),(3); " +
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT); " +
      "CREATE TABLE IF NOT EXISTS admin_logs (action TEXT, detail TEXT);"
  );
  db.exec(PERP_ENGINE_SCHEMA);
  ensureSevenPickSchema(db);
}

function config(db: Database.Database) {
  const {
    openMinutes,
    closeAfterMinutes,
    drawAfterMinutes,
    minStakeUnits,
    maxStakeUnits,
    multipliers,
    items,
  } = getSevenPickConfig(db, NOW);
  return {
    enabled: true,
    openMinutes,
    closeAfterMinutes,
    drawAfterMinutes,
    minStakeUnits,
    maxStakeUnits,
    multipliers,
    items,
  };
}

function setCash(db: Database.Database, userId: number, units: number) {
  db.prepare(
    "INSERT INTO perp_wallets (user_id,cash_units) VALUES (?,?) ON CONFLICT DO UPDATE SET cash_units=excluded.cash_units"
  ).run(userId, units);
}

function makeRound(db: Database.Database, limit = 20 * MIN_LIMIT, open = true) {
  saveSevenPickConfig(db, config(db), NOW);
  setCash(db, 1, 1_000_000);
  setCash(db, 2, 1_000_000);
  setCash(db, 3, limit * 5 - 2_000_000);
  const round = createSevenPickRound(db, OPENS, OPENS - 1);
  return open ? openSevenPickRound(db, round.id, OPENS) : round;
}

function count(db: Database.Database, kind: "orders" | "bets" | "ledger") {
  return db
    .prepare<[], number>("SELECT count(*) FROM seven_pick_" + kind)
    .pluck()
    .get();
}

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  init(db);
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

describe("七星寻宝 configuration and locked snapshot", () => {
  it("ensures the schema repeatedly without affecting existing game or wallet rows", () => {
    const round = makeRound(db);
    ensureSevenPickSchema(db);
    ensureSevenPickSchema(db);
    expect(getSevenPickRound(db, round.id)).toEqual(round);
    expect(readSevenPickCash(db, 1)).toBe(1_000_000);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("selects next Beijing midnight versions and preserves already-created snapshots", () => {
    const input = config(db);
    expect(getSevenPickConfig(db, NOW).enabled).toBe(false);
    const first = saveSevenPickConfig(db, input, NOW - 100);
    expect(first.effectiveAt).toBe(EFFECTIVE);
    expect(getSevenPickConfig(db, NOW).id).toBeNull();
    expect(getSevenPickConfig(db, EFFECTIVE).id).toBe(first.id);
    const round = createSevenPickRound(db, OPENS, NOW - 50);
    input.items[0].name = "新宝物";
    input.openMinutes = [14 * 60];
    input.drawAfterMinutes = 25;
    input.maxStakeUnits = 25_000;
    input.multipliers[7] = 75_000;
    const nextVersion = saveSevenPickConfig(db, input, NOW);
    expect(getLatestSevenPickConfig(db)).toEqual(nextVersion);
    expect(listSevenPickConfigVersions(db).map(x => x.id)).toEqual([
      nextVersion.id,
      first.id,
    ]);
    expect(getSevenPickConfig(db, EFFECTIVE).id).toBe(nextVersion.id);
    expect(createSevenPickRound(db, OPENS, NOW)).toEqual(round);
    const next = createSevenPickRound(db, OPENS + HOUR, OPENS);
    expect(next.items[0].name).toBe("新宝物");
    expect(next.maxStakeUnits).toBe(25_000);
    expect(next.drawAt).toBe(OPENS + HOUR + 25 * 60_000);
    expect(next.multipliers[7]).toBe(75_000);
    expect(round.items[0].name).not.toBe("新宝物");
    expect(round.configVersionId).toBe(first.id);
    expect(round.closesAt).toBe(OPENS + 600_000);
    expect(round.quicknetNetwork).toBe("quicknet");
    expect(round.quicknetChainHash).toBe(QUICKNET.chainHash);
    expect(round.quicknetPublicKey).toBe(QUICKNET.publicKey);
    expect(round.quicknetScheduledAt).toBeGreaterThanOrEqual(round.drawAt);
    expect(round.quicknetScheduledAt - round.drawAt).toBeLessThan(
      QUICKNET.periodMs
    );
    expect(round.algorithmVersion).toBe("sha256-fy32-v1");
  });

  it("resolves the earliest future effective time, latest ID on ties, and supports a strict ID cursor", () => {
    expect(getNextSevenPickConfig(db, NOW)).toBeNull();
    const far = saveSevenPickConfig(db, config(db), EFFECTIVE);
    const first = saveSevenPickConfig(db, config(db), NOW - 1);
    const tied = saveSevenPickConfig(db, { ...config(db), enabled: false }, NOW);
    expect(getNextSevenPickConfig(db, NOW)).toEqual(tied);
    expect(getNextSevenPickConfig(db, EFFECTIVE)).toEqual(far);
    expect(getNextSevenPickConfig(db, far.effectiveAt)).toBeNull();
    expect(listSevenPickConfigVersions(db, 2)).toEqual([tied, first]);
    expect(listSevenPickConfigVersions(db, 2, first.id!)).toEqual([far]);
    expect(listSevenPickConfigVersions(db, 2, far.id!)).toEqual([]);
  });

  it("activates enabled clones of pending and historical rules and cancels pending schedules atomically", () => {
    const previous = saveSevenPickConfig(db, config(db), NOW);
    const input = config(db);
    input.items[0] = { ...input.items[0], name: "曾排期宝物", description: "旧版本规则" };
    input.multipliers[7] = 75_000;
    const selected = saveSevenPickConfig(db, { ...input, enabled: false }, EFFECTIVE);
    const other = saveSevenPickConfig(db, config(db), EFFECTIVE + 1);
    const activateAt = EFFECTIVE + 2;
    expect(activateSevenPickConfig(db, 400_000, activateAt)).toBeNull();
    expect(getNextSevenPickConfig(db, activateAt)).toEqual(other);
    expect(listSevenPickConfigVersions(db)).toEqual([other, selected, previous]);

    const active = activateSevenPickConfig(db, selected.id!, activateAt)!;
    expect(active.id).toBeGreaterThan(other.id!);
    expect(active).toEqual({
      ...selected, id: active.id, enabled: true, effectiveAt: activateAt, createdAt: activateAt,
    });
    expect(getSevenPickConfig(db, activateAt - 1)).toEqual(previous);
    expect(getSevenPickConfig(db, activateAt)).toEqual(active);
    expect(getSevenPickConfig(db, selected.effectiveAt)).toEqual(active);
    expect(getNextSevenPickConfig(db, activateAt)).toBeNull();
    expect(getLatestSevenPickConfig(db)).toEqual(active);
    expect(listSevenPickConfigVersions(db)).toEqual([
      active, { ...other, canceledAt: activateAt }, { ...selected, canceledAt: activateAt }, previous,
    ]);
    expect(db.prepare("SELECT 1 FROM seven_pick_rounds").get()).toBeUndefined();

    const restored = activateSevenPickConfig(db, selected.id!, activateAt)!;
    expect(restored).toEqual({ ...active, id: restored.id });
    expect(restored.id).toBeGreaterThan(active.id!);
    expect(getSevenPickConfig(db, activateAt)).toEqual(restored);
    expect(listSevenPickConfigVersions(db, 1, other.id!)).toEqual([{ ...selected, canceledAt: activateAt }]);
    const historical = activateSevenPickConfig(db, previous.id!, selected.effectiveAt + 1)!;
    expect(historical).toEqual({
      ...previous, id: historical.id, effectiveAt: selected.effectiveAt + 1, createdAt: selected.effectiveAt + 1,
    });
    const savedAgain = saveSevenPickConfig(db, input, selected.effectiveAt + 2);
    expect(savedAgain.effectiveAt).toBe(selected.effectiveAt + 24 * HOUR);
    expect(getSevenPickConfig(db, savedAgain.effectiveAt - 1)).toEqual(historical);
    expect(getNextSevenPickConfig(db, savedAgain.effectiveAt - 1)).toEqual(savedAgain);
    expect(getSevenPickConfig(db, savedAgain.effectiveAt)).toEqual(savedAgain);
  });

  it("rolls back the cloned configuration when pending cancellation fails", () => {
    const pending = saveSevenPickConfig(db, config(db), NOW);
    db.exec("CREATE TRIGGER fail_cancel BEFORE INSERT ON seven_pick_config_cancellations BEGIN SELECT RAISE(ABORT, 'injected cancellation fault'); END;");
    expect(() => activateSevenPickConfig(db, pending.id!, NOW)).toThrow("injected cancellation fault");
    expect(listSevenPickConfigVersions(db)).toEqual([pending]);
    expect(getNextSevenPickConfig(db, NOW)).toEqual(pending);
    expect(getSevenPickConfig(db, NOW).id).toBeNull();
  });

  it("upgrades a legacy database without changing existing configs, items, or locked rounds", () => {
    const legacy = new Database(":memory:");
    try {
      legacy.pragma("foreign_keys = ON");
      legacy.exec("CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);");
      legacy.exec(SEVEN_PICK_SCHEMA.replace("effective_at>=created_at", "effective_at>created_at"));
      ensureSevenPickLifecycleSchema(legacy);
      const saved = saveSevenPickConfig(legacy, config(legacy), NOW);
      const round = createSevenPickRound(legacy, OPENS, OPENS - 1);
      expect(() => activateSevenPickConfig(legacy, saved.id!, OPENS - 1)).toThrow(/CHECK constraint/);
      legacy.exec("DROP TABLE seven_pick_config_cancellations"); // Absent in the old deployment.
      ensureSevenPickSchema(legacy);
      ensureSevenPickSchema(legacy);
      expect(getLatestSevenPickConfig(legacy)).toEqual(saved);
      expect(getSevenPickRound(legacy, round.id)).toEqual(round);
      expect(legacy.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(legacy.pragma("foreign_key_check")).toEqual([]);
      expect(activateSevenPickConfig(legacy, saved.id!, OPENS - 1)).toMatchObject({
        items: saved.items, effectiveAt: OPENS - 1, createdAt: OPENS - 1,
      });
      expect(getSevenPickRound(legacy, round.id)).toEqual(round);
    } finally {
      legacy.close();
    }
  });

  it("rejects invalid item IDs, schedule overlaps, amounts and unsafe image references", () => {
    const input = config(db);
    expect(
      sevenPickConfigInput.safeParse({ ...input, minStakeUnits: 999 }).success
    ).toBe(false);
    expect(
      sevenPickConfigInput.safeParse({ ...input, openMinutes: [100, 109] })
        .success
    ).toBe(false);
    expect(
      sevenPickConfigInput.safeParse({
        ...input,
        items: [...input.items.slice(1), input.items[1]],
      }).success
    ).toBe(false);
    for (const imageUrl of [
      "http://example.test/img.png",
      "javascript:alert(1)",
      "//evil.test/a.jpg",
      "https://user:pass@example.test/a.png",
      "https://example.test/\nx.png",
      "/admin/debug.svg",
    ]) {
      expect(
        sevenPickConfigInput.safeParse({
          ...input,
          items: [{ ...input.items[0], imageUrl }, ...input.items.slice(1)],
        }).success
      ).toBe(false);
    }
    input.items[0].imageUrl = "https://example.test/a.png";
    expect(sevenPickConfigInput.safeParse(input).success).toBe(true);
  });

  it("locks exactly floor(total available cash × 20%) once and resumes skipped refunds without opening", () => {
    const scheduled = makeRound(db, MIN_LIMIT - 1, false);
    setCash(db, 3, (MIN_LIMIT - 1) * 5 - 2_000_000 + 4);
    expect(() => openSevenPickRound(db, scheduled.id, OPENS - 1)).toThrow(
      expect.objectContaining({ code: "ROUND_CLOSED" })
    );
    expect(getSevenPickRound(db, scheduled.id)?.riskLimitUnits).toBeNull();
    // Simulate an anomalous pre-activation stake persisted during recovery.
    db.transaction(() => {
      db.prepare(
        "INSERT INTO seven_pick_orders VALUES (17,?,1,'anomaly',?,1000,?)"
      ).run(scheduled.id, "1".repeat(64), OPENS - 1);
      db.prepare(
        "INSERT INTO seven_pick_bets VALUES (23,17,?,1,?, ?,1000,?,?)"
      ).run(
        scheduled.id,
        JSON.stringify(A),
        sevenPickItemMask(A),
        "a".repeat(32),
        OPENS - 1
      );
      applySevenPickCash(db, {
        roundId: scheduled.id,
        betId: 23,
        userId: 1,
        kind: "stake",
        deltaUnits: -1000,
        now: OPENS - 1,
      });
    }).immediate();
    db.exec(
      "CREATE TRIGGER fail_refund BEFORE INSERT ON seven_pick_ledger WHEN NEW.kind='refund' " +
        "BEGIN SELECT RAISE(ABORT, 'injected refund fault'); END;"
    );
    expect(() => openSevenPickRound(db, scheduled.id, OPENS)).toThrow(
      "injected refund fault"
    );
    const skipped = getSevenPickRound(db, scheduled.id);
    expect(skipped?.status).toBe("risk_skipped");
    expect(skipped?.riskLimitUnits).toBe(String(MIN_LIMIT - 201));
    expect(readSevenPickCash(db, 1)).toBe(999_000);
    expect(count(db, "ledger")).toBe(1);
    db.exec("DROP TRIGGER fail_refund");
    setCash(db, 3, 500_000_000);
    expect(openSevenPickRound(db, scheduled.id, OPENS + HOUR)).toEqual(skipped);
    expect(openSevenPickRound(db, scheduled.id, OPENS + 2 * HOUR)).toEqual(
      skipped
    );
    expect(readSevenPickCash(db, 1)).toBe(1_000_000);
    expect(count(db, "ledger")).toBe(2);
    expect(() =>
      placeSevenPickOrderForTest(
        db,
        1,
        { roundId: scheduled.id, requestKey: "skipped", bets: [bet()] },
        OPENS + 1
      )
    ).toThrow(expect.objectContaining({ code: "ROUND_CLOSED" }));
  });
});

describe("automatic round scheduling after config activation", () => {
  it("keeps locked scheduled windows, skips overlapping slots, and creates later slots at the exact close", async () => {
    ensureSevenPickLifecycleSchema(db);
    const existing = makeRound(db, MIN_LIMIT, false);
    const m = 13 * 60;
    const input = { ...config(db), openMinutes: [m - 1, m + 10], maxStakeUnits: 41_000 };
    const selected = saveSevenPickConfig(db, input, OPENS - 3 * MINUTE_MS);
    const now = OPENS - 2 * MINUTE_MS;
    const active = activateSevenPickConfig(db, selected.id!, now)!;
    expect(() => createSevenPickRound(db, OPENS - MINUTE_MS, now)).toThrow(
      expect.objectContaining({ code: "CONFLICT" })
    );
    const onError = vi.fn();
    await tickSevenPickMaintenance(db, { now, onError });
    expect(getSevenPickRound(db, existing.id)).toEqual(existing);
    expect(getSevenPickSnapshot(db, now).round).toEqual(existing);
    expect(createSevenPickRound(db, OPENS, now)).toEqual(existing);
    await tickSevenPickMaintenance(db, { now: OPENS, onError });
    expect(getSevenPickRound(db, existing.id)?.status).toBe("open");
    await tickSevenPickMaintenance(db, { now: existing.closesAt - 1, onError });
    expect(db.prepare("SELECT config_version_id FROM seven_pick_rounds WHERE opens_at=?").pluck().get(existing.closesAt)).toBe(active.id);
    await tickSevenPickMaintenance(db, { now: existing.closesAt, onError });
    expect(getSevenPickSnapshot(db, existing.closesAt).round).toMatchObject({
      status: "open", opensAt: existing.closesAt, configVersionId: active.id, maxStakeUnits: 41_000,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(["open", "risk_skipped"] as const)("honors manual %s window reservations after activation", async status => {
    ensureSevenPickLifecycleSchema(db);
    const old = saveSevenPickConfig(db, { ...config(db), openMinutes: [14 * 60] }, NOW);
    if (status === "open") setCash(db, 1, MIN_LIMIT * 5);
    const manual = startManualSevenPickRound(db, old.id!, OPENS - MINUTE_MS + 1);
    expect(manual.status).toBe(status);
    const selected = saveSevenPickConfig(db, { ...config(db), openMinutes: [13 * 60] }, manual.opensAt + 1);
    const active = activateSevenPickConfig(db, selected.id!, manual.opensAt + 2)!;
    const onError = vi.fn();
    await tickSevenPickMaintenance(db, { now: active.effectiveAt, onError });
    const scheduled = db.prepare("SELECT config_version_id FROM seven_pick_rounds WHERE opens_at=?").pluck().get(OPENS);
    expect(scheduled).toBe(status === "open" ? undefined : active.id);
    expect(getSevenPickRound(db, manual.id)).toEqual(manual);
    expect(onError).not.toHaveBeenCalled();
  });

  it("continues scheduling activated rules across Beijing midnight but retains a pre-created pending snapshot", async () => {
    ensureSevenPickLifecycleSchema(db);
    const midnight = EFFECTIVE + 24 * HOUR;
    const selected = saveSevenPickConfig(db, { ...config(db), openMinutes: [10] }, NOW);
    const pending = saveSevenPickConfig(db, { ...config(db), openMinutes: [0, 30] }, midnight - HOUR);
    const reserved = createSevenPickRound(db, midnight, midnight - 2);
    setCash(db, 1, MIN_LIMIT * 5);
    const active = activateSevenPickConfig(db, selected.id!, midnight - 1)!;
    expect(getNextSevenPickConfig(db, midnight - 1)).toBeNull();
    expect(getSevenPickConfig(db, midnight)).toEqual(active);
    expect(reserved.configVersionId).toBe(pending.id);
    expect(getSevenPickRound(db, reserved.id)).toEqual(reserved);

    const onError = vi.fn();
    await tickSevenPickMaintenance(db, { now: midnight, onError });
    expect(getSevenPickRound(db, reserved.id)).toMatchObject({
      status: "open", configVersionId: pending.id, opensAt: midnight,
    });
    const later = midnight + 10 * MINUTE_MS;
    await tickSevenPickMaintenance(db, { now: later - 1, onError });
    const next = db.prepare("SELECT config_version_id FROM seven_pick_rounds WHERE opens_at=?").pluck().get(later);
    expect(next).toBe(active.id);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("manual seven-pick rounds", () => {
  const MANUAL_START = OPENS - 30 * MINUTE_MS + 123;
  const MIDNIGHT = EFFECTIVE + 24 * HOUR;

  it("pins current rules and Quicknet, opens now, and accepts bets immediately", () => {
    ensureSevenPickLifecycleSchema(db);
    const input = config(db);
    input.items[0].name = "手动场次宝物";
    const active = saveSevenPickConfig(db, input, NOW);
    const next = saveSevenPickConfig(
      db,
      { ...input, maxStakeUnits: 5_000 },
      MANUAL_START
    );
    setCash(db, 1, MIN_LIMIT * 5);
    expect(getSevenPickManualStartBlock(db, MANUAL_START)).toBeNull();
    expect(() => startManualSevenPickRound(db, next.id!, MANUAL_START)).toThrow(
      expect.objectContaining({ code: "CONFLICT" })
    );
    const round = startManualSevenPickRound(db, active.id!, MANUAL_START);
    expect(round).toMatchObject({
      configVersionId: active.id,
      status: "open",
      opensAt: MANUAL_START,
      closesAt: MANUAL_START + active.closeAfterMinutes * MINUTE_MS,
      drawAt: MANUAL_START + active.drawAfterMinutes * MINUTE_MS,
      quicknetChainHash: QUICKNET.chainHash,
      multipliers: active.multipliers,
      minStakeUnits: active.minStakeUnits,
      maxStakeUnits: active.maxStakeUnits,
      items: active.items,
      riskLimitUnits: String(MIN_LIMIT),
      maxExposureUnits: "0",
    });
    expect(round.quicknetRound).toBe(quicknetRoundAtOrAfter(round.drawAt));
    expect(getSevenPickSnapshot(db, MANUAL_START)).toMatchObject({
      round,
      bettingEnabled: true,
    });
    expect(() =>
      db
        .prepare("UPDATE seven_pick_rounds SET opens_at=0 WHERE id=?")
        .run(round.id)
    ).toThrow("七星寻宝场次规则不可修改");
    expect(
      placeSevenPickOrder(
        db,
        1,
        { roundId: round.id, requestKey: "manual", bets: [bet()] },
        MANUAL_START
      )
    ).toMatchObject({ roundId: round.id, createdAt: MANUAL_START });
    expect(getSevenPickConfig(db, MIDNIGHT)).toEqual(next);
  });

  it("blocks disabled and paused configurations without creating any round", () => {
    expect(getSevenPickManualStartBlock(db, NOW)).toMatch(/未启用/);
    expect(() => startManualSevenPickRound(db, 1, NOW)).toThrow(
      expect.objectContaining({ code: "BETTING_DISABLED" })
    );
    const active = saveSevenPickConfig(db, config(db), NOW);
    setSevenPickRuntime(db, "paused", true, 1);
    const block = getSevenPickManualStartBlock(db, MANUAL_START);
    expect(block).toMatch(/暂停/);
    expect(() =>
      startManualSevenPickRound(db, active.id!, MANUAL_START)
    ).toThrow(
      expect.objectContaining({ code: "BETTING_DISABLED", message: block })
    );
    expect(db.prepare("SELECT 1 FROM seven_pick_rounds").get()).toBeUndefined();
  });

  it("checks configured betting slots even before maintenance materializes them and allows exact boundaries", () => {
    const active = saveSevenPickConfig(db, config(db), NOW);
    setCash(db, 1, MIN_LIMIT * 5);
    const closeDelay = active.closeAfterMinutes * MINUTE_MS;
    for (const time of [
      OPENS - closeDelay + 1,
      OPENS,
      OPENS + closeDelay - 1,
    ]) {
      expect(getSevenPickManualStartBlock(db, time)).toMatch(/定时场次/);
      expect(() => startManualSevenPickRound(db, active.id!, time)).toThrow(
        expect.objectContaining({ code: "CONFLICT" })
      );
    }
    expect(db.prepare("SELECT 1 FROM seven_pick_rounds").get()).toBeUndefined();
    const before = startManualSevenPickRound(
      db,
      active.id!,
      OPENS - closeDelay
    );
    expect(before.closesAt).toBe(OPENS);
    const scheduled = createSevenPickRound(db, OPENS, OPENS - 1);
    openSevenPickRound(db, scheduled.id, OPENS);
    const after = startManualSevenPickRound(db, active.id!, scheduled.closesAt);
    expect(after.opensAt).toBeLessThan(scheduled.drawAt);
  });

  it("blocks already-materialized current/future slots even if the active config no longer lists them", () => {
    const old = saveSevenPickConfig(db, config(db), NOW - 100);
    const existing = createSevenPickRound(db, OPENS, NOW - 50);
    const active = saveSevenPickConfig(
      db,
      { ...config(db), openMinutes: [15 * 60] },
      NOW
    );
    expect(existing.configVersionId).toBe(old.id);
    for (const time of [OPENS - 2 * MINUTE_MS, OPENS + 1]) {
      expect(getSevenPickManualStartBlock(db, time)).toMatch(/已有场次/);
      expect(() => startManualSevenPickRound(db, active.id!, time)).toThrow(
        expect.objectContaining({ code: "CONFLICT" })
      );
    }
    expect(getSevenPickRound(db, existing.id)).toEqual(existing);
  });

  it("checks the next Beijing-day config and protects later rollover edits without changing scheduling", async () => {
    ensureSevenPickLifecycleSchema(db);
    const active = saveSevenPickConfig(db, config(db), NOW);
    const start = MIDNIGHT - active.closeAfterMinutes * MINUTE_MS;
    setCash(db, 1, MIN_LIMIT * 5);
    expect(getSevenPickManualStartBlock(db, start + 1)).toMatch(/午夜/);
    const early = { ...config(db), openMinutes: [0] };
    saveSevenPickConfig(db, early, start - 1);
    expect(getSevenPickManualStartBlock(db, start + 1)).toMatch(/定时场次/);
    const manual = startManualSevenPickRound(db, active.id!, start);
    expect(manual.closesAt).toBe(MIDNIGHT);
    expect(manual.drawAt).toBeGreaterThan(MIDNIGHT);

    // Saving again during the manual window may affect next-day schedule only.
    const next = saveSevenPickConfig(
      db,
      { ...early, closeAfterMinutes: 5 },
      start + 1
    );
    const noNetwork = vi.fn(() => {
      throw new Error("Unexpected network call");
    });
    await tickSevenPickMaintenance(db, {
      now: MIDNIGHT - 1,
      onError: noNetwork,
    });
    const scheduled = getSevenPickSnapshot(db, MIDNIGHT).round;
    expect(scheduled).toMatchObject({
      status: "scheduled",
      configVersionId: next.id,
      opensAt: MIDNIGHT,
      closesAt: MIDNIGHT + 5 * MINUTE_MS,
    });
    await tickSevenPickMaintenance(db, { now: MIDNIGHT, onError: noNetwork });
    expect(getSevenPickRound(db, manual.id)?.status).toBe("sealed");
    expect(getSevenPickRound(db, scheduled!.id)?.status).toBe("open");
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it("retains skipped attempts and their risk lock without displacing the previous public selection", () => {
    const previous = makeRound(db);
    const start = previous.closesAt;
    setCash(db, 3, (MIN_LIMIT - 1) * 5 - 2_000_000);
    expect(getSevenPickManualStartBlock(db, start)).toBeNull();
    const skipped = startManualSevenPickRound(
      db,
      previous.configVersionId,
      start
    );
    expect(skipped).toMatchObject({
      status: "risk_skipped",
      riskLimitUnits: String(MIN_LIMIT - 1),
      maxExposureUnits: "0",
    });
    expect(getSevenPickRound(db, skipped.id)).toEqual(skipped);
    expect(getSevenPickSnapshot(db, start)).toMatchObject({
      round: previous,
      bettingEnabled: false,
    });
    expect(getSevenPickSnapshot(db, skipped.closesAt)).toMatchObject({
      round: previous,
    });
    expect(() =>
      startManualSevenPickRound(db, previous.configVersionId, start)
    ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    setCash(db, 3, MIN_LIMIT * 5);
    const retry = startManualSevenPickRound(
      db,
      previous.configVersionId,
      start + 1
    );
    expect(retry.status).toBe("open");
    expect(retry.id).not.toBe(skipped.id);
    expect(getSevenPickRound(db, skipped.id)).toEqual(skipped);
    expect(getSevenPickSnapshot(db, start + 1)).toMatchObject({
      round: retry,
      bettingEnabled: true,
    });
  });

  it("rolls back unexpected risk errors instead of returning a skipped result", () => {
    const active = saveSevenPickConfig(db, config(db), NOW);
    db.exec(
      "CREATE TRIGGER fail_risk BEFORE INSERT ON seven_pick_risk BEGIN SELECT RAISE(ABORT, 'injected risk fault'); END;"
    );
    expect(() =>
      startManualSevenPickRound(db, active.id!, MANUAL_START)
    ).toThrow("injected risk fault");
    expect(db.prepare("SELECT 1 FROM seven_pick_rounds").get()).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM seven_pick_manual_rounds").get()
    ).toBeUndefined();
  });

  it("serializes competing manual starts across database connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "seven-pick-manual-"));
    const file = join(dir, "shared.db");
    const left = new Database(file, { timeout: 0 });
    const right = new Database(file, { timeout: 0 });
    try {
      init(left);
      right.pragma("foreign_keys = ON");
      const active = saveSevenPickConfig(left, config(left), NOW);
      setCash(left, 1, MIN_LIMIT * 5);
      left
        .transaction(() => {
          const round = startManualSevenPickRound(
            left,
            active.id!,
            MANUAL_START
          );
          expect(round.status).toBe("open");
          expect(() =>
            startManualSevenPickRound(right, active.id!, MANUAL_START + 1)
          ).toThrow(expect.objectContaining({ code: "SQLITE_BUSY" }));
        })
        .immediate();
      for (const time of [MANUAL_START, MANUAL_START + 1]) {
        expect(() =>
          startManualSevenPickRound(right, active.id!, time)
        ).toThrow(expect.objectContaining({ code: "CONFLICT" }));
      }
      expect(
        right.prepare("SELECT count(*) FROM seven_pick_rounds").pluck().get()
      ).toBe(1);
    } finally {
      right.close();
      left.close();
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("atomic seven-pick order placement", () => {
  it("blocks new orders when paused, including the isolated test entry point", () => {
    const { id } = makeRound(db);
    setSevenPickRuntime(db, "paused", true, 1);
    const input = { roundId: id, requestKey: "new", bets: [bet()] };
    expect(getSevenPickSnapshot(db, OPENS)).toMatchObject({
      name: "七星寻宝",
      bettingEnabled: false,
      round: { id },
    });
    expect(() => placeSevenPickOrder(db, 1, input, OPENS)).toThrow(
      expect.objectContaining({ code: "BETTING_DISABLED" })
    );
    expect(() => placeSevenPickOrderForTest(db, 1, input, OPENS)).toThrow(
      expect.objectContaining({ code: "BETTING_DISABLED" })
    );
    expect(count(db, "orders")).toBe(0);
  });

  it("charges once, accepts canonical retries even after closing, and rejects conflicting key reuse", () => {
    const round = makeRound(db);
    const input = {
      roundId: round.id,
      requestKey: "same-key",
      bets: [bet(B, "1.010"), bet(A, "1.001")],
    };
    const placed = placeSevenPickOrderForTest(db, 1, input, OPENS);
    expect(placed).toMatchObject({
      id: 1,
      roundId: round.id,
      createdAt: OPENS,
      totalStakeUnits: 2011,
      bets: [
        { itemIds: A, stakeUnits: 1001 },
        { itemIds: B, stakeUnits: 1010 },
      ],
    });
    expect(placed.bets[0].receiptId).toMatch(/^[0-9a-f]{32}$/);
    const retry = {
      ...input,
      bets: [bet([...A].reverse(), "1.001"), bet([...B].reverse(), "1.01")],
    };
    expect(placeSevenPickOrderForTest(db, 1, retry, round.closesAt)).toEqual(
      placed
    );
    expect(() =>
      placeSevenPickOrderForTest(
        db,
        1,
        { ...input, bets: [bet(A, "1.002")] },
        OPENS
      )
    ).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(() =>
      placeSevenPickOrderForTest(
        db,
        1,
        { ...input, requestKey: "late" },
        round.closesAt
      )
    ).toThrow(expect.objectContaining({ code: "ROUND_CLOSED" }));
    expect(readSevenPickCash(db, 1)).toBe(997_989);
    expect(count(db, "ledger")).toBe(2);
    expect(listSevenPickOrders(db, 1)).toEqual([placed]);
    expect(listSevenPickOrders(db, 2)).toEqual([]);
    expect(db.prepare("SELECT 1 FROM perp_events").get()).toBeUndefined();
  });

  it("rejects duplicate combinations, malformed or out-of-range amounts, and a sixth group", () => {
    const { id } = makeRound(db);
    const place = (key: string, bets: ReturnType<typeof bet>[]) =>
      placeSevenPickOrderForTest(
        db,
        1,
        { roundId: id, requestKey: key, bets },
        OPENS
      );
    for (const amount of [
      "0.999",
      "1.0000",
      " 1",
      "1\n",
      "01",
      "1e2",
      "Infinity",
      "NaN",
      "-1",
      "100.001",
    ]) {
      expect(() => place("bad", [bet(A, amount)])).toThrow(
        expect.objectContaining({ code: "INVALID_INPUT" })
      );
    }
    expect(() => place("bad", [bet([1, 2, 3, 4, 5, 6, 6])])).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" })
    );
    expect(() => place("duplicate", [bet(A), bet([...A].reverse())])).toThrow(
      expect.objectContaining({ code: "DUPLICATE_COMBINATION" })
    );
    place(
      "five",
      [7, 8, 9, 10, 11].map(x => bet(group(x)))
    );
    expect(() => place("repeat", [bet(A)])).toThrow(
      expect.objectContaining({ code: "DUPLICATE_COMBINATION" })
    );
    expect(() => place("sixth", [bet(B)])).toThrow(
      expect.objectContaining({ code: "BET_LIMIT" })
    );
    expect(
      placeSevenPickOrderForTest(
        db,
        2,
        { roundId: id, requestKey: "five", bets: [bet(A)] },
        OPENS
      ).bets
    ).toHaveLength(1);
    expect(readSevenPickCash(db, 1)).toBe(995_000);
    expect(count(db, "orders")).toBe(2);
  });

  it("accepts exactly the locked limit and leaves the ledger and prior order intact on risk rejection", () => {
    const { id } = makeRound(db, MIN_LIMIT);
    setCash(db, 3, 999_999_999); // Must not change a previously locked limit.
    placeSevenPickOrderForTest(
      db,
      1,
      { roundId: id, requestKey: "first", bets: [bet()] },
      OPENS
    );
    expect(getSevenPickRound(db, id)).toMatchObject({
      riskLimitUnits: String(MIN_LIMIT),
      maxExposureUnits: String(MIN_LIMIT),
    });
    expect(() =>
      placeSevenPickOrderForTest(
        db,
        2,
        { roundId: id, requestKey: "second", bets: [bet(B)] },
        OPENS
      )
    ).toThrow(expect.objectContaining({ code: "RISK_LIMIT" }));
    expect(count(db, "bets")).toBe(1);
    expect(count(db, "ledger")).toBe(1);
    expect(readSevenPickCash(db, 2)).toBe(1_000_000);
    expect(openSevenPickRound(db, id, OPENS + 1).riskLimitUnits).toBe(
      String(MIN_LIMIT)
    );
  });

  it("rolls back every bet and its debit if a later debit fails", () => {
    const { id } = makeRound(db);
    db.exec(
      "CREATE TRIGGER fail_second_stake BEFORE INSERT ON seven_pick_ledger WHEN NEW.delta_units=-1001 BEGIN SELECT RAISE(ABORT, 'injected'); END;"
    );
    const input = {
      roundId: id,
      requestKey: "batch",
      bets: [bet(A), bet(B, "1.001")],
    };
    expect(() => placeSevenPickOrderForTest(db, 1, input, OPENS)).toThrow(
      "injected"
    );
    expect(readSevenPickCash(db, 1)).toBe(1_000_000);
    expect(getSevenPickRound(db, id)?.maxExposureUnits).toBe("0");
    expect([
      count(db, "orders"),
      count(db, "bets"),
      count(db, "ledger"),
    ]).toEqual([0, 0, 0]);
    db.exec("DROP TRIGGER fail_second_stake");
    expect(
      placeSevenPickOrderForTest(db, 1, input, OPENS).totalStakeUnits
    ).toBe(2001);
  });

  it("serializes competing writers across connections and rejects the losing debit", () => {
    const dir = mkdtempSync(join(tmpdir(), "seven-pick-core-"));
    const file = join(dir, "shared.db");
    const left = new Database(file, { timeout: 0 });
    const right = new Database(file, { timeout: 0 });
    try {
      init(left);
      right.pragma("foreign_keys = ON");
      const { id } = makeRound(left);
      setCash(left, 1, 1000);
      const first = { roundId: id, requestKey: "writer-1", bets: [bet(A)] };
      const second = { roundId: id, requestKey: "writer-2", bets: [bet(B)] };
      left
        .transaction(() => {
          placeSevenPickOrderForTest(left, 1, first, OPENS);
          expect(readSevenPickCash(right, 1)).toBe(1000);
          expect(() =>
            placeSevenPickOrderForTest(right, 1, second, OPENS)
          ).toThrow(expect.objectContaining({ code: "SQLITE_BUSY" }));
        })
        .immediate();
      expect(() => placeSevenPickOrderForTest(right, 1, second, OPENS)).toThrow(
        expect.objectContaining({ code: "INSUFFICIENT_FUNDS" })
      );
      expect(placeSevenPickOrderForTest(right, 1, first, OPENS)).toEqual(
        listSevenPickOrders(left, 1)[0]
      );
      expect(readSevenPickCash(right, 1)).toBe(0);
      expect(count(right, "ledger")).toBe(1);
    } finally {
      right.close();
      left.close();
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
