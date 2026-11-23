import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERP_ENGINE_SCHEMA } from "../perp/schema";
import {
  getLatestSevenPickConfig,
  getSevenPickConfig,
  listSevenPickConfigVersions,
  saveSevenPickConfig,
  sevenPickConfigInput,
} from "./config";
import { QUICKNET } from "./drand";
import {
  createSevenPickRound,
  getSevenPickRound,
  getSevenPickSnapshot,
  listSevenPickOrders,
  openSevenPickRound,
  placeSevenPickOrder,
  placeSevenPickOrderForTest,
} from "./engine";
import { sevenPickItemMask } from "./risk";
import { setSevenPickRuntime } from "./release";
import { ensureSevenPickSchema } from "./schema";
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
