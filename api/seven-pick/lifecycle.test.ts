import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERP_ENGINE_SCHEMA } from "../perp/schema";
import { getSevenPickConfig, saveSevenPickConfig } from "./config";
import { deriveDraw } from "./draw";
import { QUICKNET, verifyQuicknetBeacon, type QuicknetEvidence } from "./drand";
import { createSevenPickRound, getSevenPickRound, openSevenPickRound, placeSevenPickOrderForTest } from "./engine";
import {
  approveSevenPickRefund, evaluateSevenPickRound, getSevenPickLifecycle, getSevenPickPublicProof,
  hasSevenPickQuicknetSeal, listSevenPickAudit, recordSevenPickQuicknetEvidence, resumeSevenPickRefund,
  sealSevenPickRound, settleSevenPickRound,
} from "./lifecycle";
import { ensureSevenPickLifecycleSchema } from "./lifecycle-schema";
import { tickSevenPickMaintenance } from "./maintenance";
import { setSevenPickRuntime } from "./release";
import { ensureSevenPickSchema } from "./schema";
import { readSevenPickCash } from "./wallet";

const OPENS = Date.parse("2026-11-23T09:00:00Z");
const CONFIGURED_AT = OPENS - 24 * 3_600_000;
const ROUND = 34207412;
const SIGNATURE = "b5c4e515b26055f015d9fce7d32986956bd056276187a6f6aa7713ddb6e66c69a8a0da3a81b151bc11397e2f3d44b850";
const IDS = Array.from({ length: 32 }, (_, i) => i + 1);
const FIXTURE = { round: ROUND, signature: SIGNATURE };
const RANDOMNESS = verifyQuicknetBeacon(ROUND, FIXTURE).randomness;
const WINNING = deriveDraw(IDS, RANDOMNESS);
const LOSING = IDS.filter(id => !WINNING.includes(id)).slice(0, 7);
let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1),(2),(3); " +
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE admin_logs (action TEXT, detail TEXT);");
  db.exec(PERP_ENGINE_SCHEMA);
  ensureSevenPickSchema(db);
  ensureSevenPickLifecycleSchema(db);
  ensureSevenPickLifecycleSchema(db);
  db.exec("INSERT INTO perp_wallets(user_id,cash_units) VALUES (1,1000000),(2,1000000),(3,1000000000);");
  const current = getSevenPickConfig(db, CONFIGURED_AT);
  saveSevenPickConfig(db, {
    enabled: true, openMinutes: current.openMinutes, multipliers: current.multipliers,
    minStakeUnits: current.minStakeUnits, maxStakeUnits: current.maxStakeUnits,
    closeAfterMinutes: current.closeAfterMinutes, drawAfterMinutes: current.drawAfterMinutes, items: current.items,
  }, CONFIGURED_AT);
});
afterEach(() => { db.close(); vi.restoreAllMocks(); });

function makeRound(open = true) {
  const planned = createSevenPickRound(db, OPENS, OPENS - 1000);
  expect(planned.quicknetRound).toBe(ROUND);
  return open ? openSevenPickRound(db, planned.id, OPENS) : planned;
}
function bet(roundId: number, userId: number, itemIds: number[], amount: string) {
  return placeSevenPickOrderForTest(db, userId, { roundId, requestKey: "bet-" + userId, bets: [{ itemIds, amount }] }, OPENS + 1000);
}
function evidence(at: number, raw: unknown = FIXTURE): QuicknetEvidence {
  return { source: "drand-v2", round: ROUND, verdict: "verified", method: "GET", url: "https://api.drand.sh/v2/beacons/quicknet/rounds/" + ROUND,
    requestedAt: at, receivedAt: at, responseDate: null, statusCode: 200, bodyHex: Buffer.from(JSON.stringify(raw)).toString("hex"), error: null };
}
const reviewInput = (roundId: number) => ({ roundId, reason: "seal_missed" as const, reviewer: "operator", notes: "verified immutable seal" });

function currentStatus(roundId: number) { return getSevenPickLifecycle(db, roundId)?.status; }

describe("Quicknet-only lifecycle", () => {
  it("atomically freezes a canonical private-order commitment and cannot mutate later", () => {
    const round = makeRound();
    const order = bet(round.id, 1, [...WINNING].reverse(), "1.011");
    expect(() => sealSevenPickRound(db, round.id, round.closesAt - 1)).toThrow();
    const seal = sealSevenPickRound(db, round.id, round.closesAt);
    expect(sealSevenPickRound(db, round.id, round.closesAt + 1)).toEqual(seal);
    expect(JSON.parse(seal.anonymousJson).bets).toEqual([{ receiptId: order.bets[0].receiptId, itemIds: WINNING, stakeUnits: 1011 }]);
    expect(seal.snapshot).not.toHaveProperty("riskLimitUnits");
    expect(hasSevenPickQuicknetSeal(db, round.id)).toBe(true);
    for (const sql of ["UPDATE seven_pick_bets SET stake_units=2000", "UPDATE seven_pick_round_items SET name='tampered'", "UPDATE seven_pick_seals SET sealed_at=1", "DELETE FROM seven_pick_quicknet_seals", "UPDATE seven_pick_rounds SET quicknet_round=quicknet_round+1"]) {
      expect(() => db.exec(sql)).toThrow();
    }
    expect(() => bet(round.id, 2, LOSING, "1")).toThrow();
    expect(getSevenPickPublicProof(db, round.id)).toBeNull();
  });

  it("captures actual manifest freeze time without reusing an earlier scheduler tick", async () => {
    const round = makeRound();
    const at = round.quicknetScheduledAt;
    vi.spyOn(Date, "now").mockReturnValueOnce(at - 1).mockReturnValueOnce(at);
    const seal = sealSevenPickRound(db, round.id);
    expect(seal.sealedAt).toBe(at);
    recordSevenPickQuicknetEvidence(db, round.id, [evidence(at)], at);
    await expect(settleSevenPickRound(db, round.id, at)).resolves.toBeNull();
    expect(getSevenPickLifecycle(db, round.id)?.reviewReasons).toContain("sealed_after_beacon");
  });

  it("requires the exact real signature and atomically rolls back interrupted payout", async () => {
    const round = makeRound();
    bet(round.id, 1, WINNING, "1"); bet(round.id, 2, WINNING, "1");
    const seal = sealSevenPickRound(db, round.id, round.closesAt);
    const now = round.quicknetScheduledAt;
    recordSevenPickQuicknetEvidence(db, round.id, [evidence(now, { ...FIXTURE, round: ROUND + 1 }), evidence(now, { ...FIXTURE, signature: "00".repeat(48) })], now);
    await expect(settleSevenPickRound(db, round.id, now)).resolves.toBeNull();
    recordSevenPickQuicknetEvidence(db, round.id, [evidence(now)], now);
    await expect(settleSevenPickRound(db, round.id, now - 1)).resolves.toBeNull();
    db.exec("CREATE TRIGGER interrupt_payout BEFORE INSERT ON seven_pick_ledger WHEN NEW.kind='payout' AND NEW.user_id=2 BEGIN SELECT RAISE(ABORT,'interrupted'); END;");
    await expect(settleSevenPickRound(db, round.id, now)).rejects.toThrow("interrupted");
    expect(readSevenPickCash(db, 1)).toBe(999_000);
    expect(currentStatus(round.id)).toBe("sealed");
    expect(getSevenPickPublicProof(db, round.id)).toBeNull();
    db.exec("DROP TRIGGER interrupt_payout");
    const result = await settleSevenPickRound(db, round.id, now);
    expect(result).toEqual({ itemIds: WINNING, quicknetRound: ROUND, randomnessHex: RANDOMNESS, signature: SIGNATURE,
      settledAt: now, totalPayoutUnits: 100_000_000 });
    expect(getSevenPickPublicProof(db, round.id)).toEqual({ ...seal, result });
    expect(readSevenPickCash(db, 1)).toBe(50_999_000);
    expect(readSevenPickCash(db, 2)).toBe(50_999_000);
    await expect(settleSevenPickRound(db, round.id, now + 1)).resolves.toBeNull();
    expect(() => db.exec("UPDATE seven_pick_quicknet_draws SET total_payout_units=5")).toThrow();
  });

  it("never treats relays unavailable as proof for a refund", async () => {
    const round = makeRound();
    bet(round.id, 1, WINNING, "1");
    sealSevenPickRound(db, round.id, round.closesAt);
    const now = round.drawAt + 3_600_000;
    recordSevenPickQuicknetEvidence(db, round.id, [{ ...evidence(now), statusCode: 404, bodyHex: null, verdict: "unavailable" }], now);
    evaluateSevenPickRound(db, round.id, now);
    expect(getSevenPickLifecycle(db, round.id)?.reviewReasons).toEqual(["quicknet_unconfirmed"]);
    await expect(approveSevenPickRefund(db, reviewInput(round.id), now)).rejects.toThrow("不可仅凭网络超时");
    expect(readSevenPickCash(db, 1)).toBe(999_000);
    recordSevenPickQuicknetEvidence(db, round.id, [evidence(now + 5)], now + 5);
    await expect(settleSevenPickRound(db, round.id, now + 5)).resolves.toMatchObject({ totalPayoutUnits: 50_000_000 });
  });

  it("resumes missed-seal refunds exactly once while excluding settlement", async () => {
    const round = makeRound();
    bet(round.id, 1, LOSING, "1.001"); bet(round.id, 2, LOSING, "2.002");
    const now = round.quicknetScheduledAt;
    sealSevenPickRound(db, round.id, now);
    recordSevenPickQuicknetEvidence(db, round.id, [evidence(now)], now);
    await expect(settleSevenPickRound(db, round.id, now)).resolves.toBeNull();
    expect(getSevenPickLifecycle(db, round.id)?.reviewReasons).toContain("sealed_after_beacon");
    await expect(approveSevenPickRefund(db, reviewInput(round.id), now)).resolves.toMatchObject({ status: "refunding" });
    expect(resumeSevenPickRefund(db, round.id, now + 1, 1)).toMatchObject({ status: "refunding", refund: { refundedBets: 1 } });
    setSevenPickRuntime(db, "paused", true, 1);
    await tickSevenPickMaintenance(db, { now: now + 2 });
    expect(resumeSevenPickRefund(db, round.id, now + 3)).toMatchObject({ status: "refunded", refund: { refundedBets: 2 } });
    expect(readSevenPickCash(db, 1)).toBe(1_000_000);
    expect(readSevenPickCash(db, 2)).toBe(1_000_000);
    expect(getSevenPickPublicProof(db, round.id)).toBeNull();
  });

  it("preserves older finalized history without silently reinterpreting old sealed rounds", async () => {
    const round = makeRound();
    const sealData = [{ id: round.id, configVersionId: round.configVersionId,
      opensAt: round.opensAt, closesAt: round.closesAt, drawAt: round.drawAt, quicknetRound: round.quicknetRound,
      quicknetScheduledAt: round.quicknetScheduledAt }];
    db.prepare("INSERT INTO seven_pick_seals VALUES (?,?,?,'{}',?)").run(round.id, round.closesAt, "00".repeat(32), JSON.stringify(sealData[0]));
    db.prepare("UPDATE seven_pick_rounds SET status='sealed' WHERE id=?").run(round.id);
    db.prepare("INSERT INTO seven_pick_draws(round_id,settled_at,quicknet_round,signature,randomness_hex,item_ids_json,total_payout_units,upper_bound_ms,evidence_json,test_only) VALUES (?,?,?,?,?,'[]',0,?,'[]',1)")
      .run(round.id, round.quicknetScheduledAt, ROUND, SIGNATURE, RANDOMNESS, round.closesAt);
    ensureSevenPickLifecycleSchema(db);
    expect(db.prepare("SELECT COUNT(*) FROM seven_pick_draws").pluck().get()).toBe(1);
    expect(hasSevenPickQuicknetSeal(db, round.id)).toBe(false);
    const network = { fetch: vi.fn<typeof fetch>() };
    await tickSevenPickMaintenance(db, { now: round.quicknetScheduledAt + 3_600_000, network });
    expect(network.fetch).not.toHaveBeenCalled();
    await expect(settleSevenPickRound(db, round.id, round.quicknetScheduledAt)).resolves.toBeNull();
    expect(getSevenPickPublicProof(db, round.id)).toBeNull();
  });

  it("retries the same fixed round after a transport outage without approving refunds", async () => {
    const round = makeRound();
    bet(round.id, 1, WINNING, "1");
    sealSevenPickRound(db, round.id, round.closesAt);
    const reached = round.quicknetScheduledAt;
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    const options = { network: { fetch: fetchMock } };
    await tickSevenPickMaintenance(db, { ...options, now: reached });
    expect(currentStatus(round.id)).toBe("sealed");
    expect(readSevenPickCash(db, 1)).toBe(999_000);
    await tickSevenPickMaintenance(db, { ...options, now: reached + 5_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockImplementation(async () => Response.json(FIXTURE));
    await tickSevenPickMaintenance(db, { ...options, now: reached + 15_000 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.slice(2).map(([url]) => String(url))).toEqual(fetchMock.mock.calls.slice(0, 2).map(([url]) => String(url)));
    expect(currentStatus(round.id)).toBe("settled");
    expect(readSevenPickCash(db, 1)).toBe(50_999_000);
  });

  it("does not create or open rounds while paused, but seals and pays accepted wagers", async () => {
    setSevenPickRuntime(db, "paused", true, 1);
    await tickSevenPickMaintenance(db, { now: OPENS - 1000 });
    expect(getSevenPickRound(db, 1)).toBeNull();
    setSevenPickRuntime(db, "paused", false, 1);
    await tickSevenPickMaintenance(db, { now: OPENS - 1000 });
    const round = getSevenPickRound(db, 1)!;
    expect(round.quicknetRound).toBe(ROUND);
    expect(round.status).toBe("scheduled");
    setSevenPickRuntime(db, "paused", true, 1);
    await tickSevenPickMaintenance(db, { now: OPENS });
    expect(currentStatus(round.id)).toBe("scheduled");
    setSevenPickRuntime(db, "paused", false, 1);
    await tickSevenPickMaintenance(db, { now: OPENS });
    expect(currentStatus(round.id)).toBe("open");
    bet(round.id, 1, WINNING, "1");
    setSevenPickRuntime(db, "paused", true, 1);
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(FIXTURE));
    await tickSevenPickMaintenance(db, { now: round.closesAt, network: { fetch: fetchMock } });
    expect(currentStatus(round.id)).toBe("sealed");
    expect(fetchMock).not.toHaveBeenCalled();
    await tickSevenPickMaintenance(db, { now: round.quicknetScheduledAt, network: { fetch: fetchMock } });
    expect(fetchMock.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      "https://api.drand.sh/v2/beacons/quicknet/rounds/" + ROUND,
      "https://drand.cloudflare.com/" + QUICKNET.chainHash + "/public/" + ROUND,
    ].sort());
    expect(getSevenPickLifecycle(db, round.id)).toMatchObject({ status: "settled", result: { itemIds: WINNING, totalPayoutUnits: 50_000_000 } });
    expect(readSevenPickCash(db, 1)).toBe(50_999_000);
    expect(listSevenPickAudit(db, round.id).filter(row => row.kind === "quicknet")).toHaveLength(2);
  });
});
