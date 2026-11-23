import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { quicknetRoundTimeMs } from "./drand";
import type { ProofNetworkOptions } from "./proof-network";
import { getSevenPickRuntime } from "./release";
import { requestSevenPickTsaStamp, sevenPickTsaEvidenceInput, verifySevenPickTsaStamp, type TsaStampEvidence } from "./tsa";

export type TimestampBinding = { roundId: number; commitmentHex: string; quicknetRound: number; sealedAt: number };

/** Only these canonical digest bytes (not picks or wagering data) go to the TSA. */
export function sevenPickSealImprint(binding: TimestampBinding) {
  return createHash("sha256").update(JSON.stringify([
    "LuckyAPI/32pick7/quicknet-seal-tsa/v1", binding.roundId, binding.quicknetRound,
    quicknetRoundTimeMs(binding.quicknetRound), binding.sealedAt, binding.commitmentHex,
  ]), "utf8").digest("hex");
}

/** The token independently attests existence of this exact imprint by its signed upper bound. */
export function verifySevenPickSealTimestamp(binding: TimestampBinding, evidence: unknown) {
  const stamp = verifySevenPickTsaStamp(sevenPickSealImprint(binding), evidence);
  if (stamp.upperBoundMs < binding.sealedAt || stamp.upperBoundMs >= quicknetRoundTimeMs(binding.quicknetRound)) {
    throw new Error("RFC 3161 timestamp does not prove this seal existed before the fixed Quicknet round");
  }
  return stamp;
}

export function ensureSevenPickTimestampSchema(db: Database.Database) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS seven_pick_seal_timestamps (" +
      "round_id INTEGER PRIMARY KEY REFERENCES seven_pick_quicknet_seals(round_id)," +
      "upper_bound_ms INTEGER NOT NULL CHECK(upper_bound_ms>0)," +
      "evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)));" +
    "CREATE TRIGGER IF NOT EXISTS seven_pick_no_update_tsa BEFORE UPDATE ON seven_pick_seal_timestamps " +
      "BEGIN SELECT RAISE(ABORT,'封盘时间戳不可更改'); END;" +
    "CREATE TRIGGER IF NOT EXISTS seven_pick_no_delete_tsa BEFORE DELETE ON seven_pick_seal_timestamps " +
      "BEGIN SELECT RAISE(ABORT,'封盘时间戳不可删除'); END;" +
    "CREATE TRIGGER IF NOT EXISTS seven_pick_no_replace_tsa BEFORE INSERT ON seven_pick_seal_timestamps " +
      "WHEN EXISTS (SELECT 1 FROM seven_pick_seal_timestamps WHERE round_id=NEW.round_id) " +
      "BEGIN SELECT RAISE(ABORT,'封盘时间戳不可覆盖'); END;"
  );
}

export function getSevenPickSealTimestamp(db: Database.Database, roundId: number): TsaStampEvidence | null {
  const json = db.prepare<[number], string>(
    "SELECT evidence_json FROM seven_pick_seal_timestamps WHERE round_id=?"
  ).pluck().get(roundId);
  return json ? sevenPickTsaEvidenceInput.parse(JSON.parse(json) as unknown) : null;
}

export function getSevenPickSealTimestampTime(db: Database.Database, roundId: number): number | null {
  return db.prepare<[number], number>(
    "SELECT upper_bound_ms FROM seven_pick_seal_timestamps WHERE round_id=?"
  ).pluck().get(roundId) ?? null;
}

const active = new WeakSet<Database.Database>();
const attempted = new WeakMap<Database.Database, Map<number, number>>();
const RETRY_MS = 30_000;

/** Best-effort worker with no participation in draw or settlement. */
export async function refreshSevenPickSealTimestamps(db: Database.Database, options: ProofNetworkOptions = {}) {
  if (active.has(db) || !getSevenPickRuntime(db).rfc3161Enabled) return;
  active.add(db);
  try {
    const now = (options.now ?? Date.now)();
    const attempts = attempted.get(db) ?? new Map<number, number>();
    attempted.set(db, attempts);
    for (const [id, last] of attempts) if (now - last > 24 * 60 * 60_000) attempts.delete(id);
    const rounds = db.prepare<[number], TimestampBinding>(
      "SELECT q.round_id AS roundId,s.commitment_hex AS commitmentHex,r.quicknet_round AS quicknetRound,s.sealed_at AS sealedAt " +
      "FROM seven_pick_rounds r JOIN seven_pick_quicknet_seals q ON q.round_id=r.id " +
      "JOIN seven_pick_seals s ON s.round_id=r.id LEFT JOIN seven_pick_seal_timestamps t ON t.round_id=r.id " +
      "WHERE r.quicknet_scheduled_at>? AND t.round_id IS NULL AND r.status IN ('sealed','review') " +
      "ORDER BY r.quicknet_scheduled_at LIMIT 16"
    ).all(now + 1000);
    const due = rounds.filter((r) => now - (attempts.get(r.roundId) ?? 0) >= RETRY_MS).slice(0, 4);
    await Promise.allSettled(due.map(async (round) => {
      attempts.set(round.roundId, now);
      const evidence = await requestSevenPickTsaStamp(sevenPickSealImprint(round), options);
      const stamp = verifySevenPickSealTimestamp(round, evidence);
      db.transaction(() => {
        // An in-flight request can finish after an operator disables the worker.
        if (!getSevenPickRuntime(db).rfc3161Enabled || getSevenPickSealTimestamp(db, round.roundId)) return;
        db.prepare("INSERT INTO seven_pick_seal_timestamps (round_id,upper_bound_ms,evidence_json) VALUES (?,?,?)")
          .run(round.roundId, stamp.upperBoundMs, JSON.stringify(evidence));
      }).immediate();
    }));
  } finally { active.delete(db); }
}
