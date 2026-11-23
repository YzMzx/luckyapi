import type Database from "better-sqlite3";
import { beijingDayStart, getSevenPickConfig, MINUTE_MS } from "./config";
import { fetchQuicknetRound } from "./drand";
import { createSevenPickRound, openSevenPickRound, SevenPickError, type SevenPickRound } from "./engine";
import { getSevenPickRuntime } from "./release";
import {
  evaluateSevenPickRound,
  hasSevenPickQuicknetSeal,
  hasSevenPickVerifiedBeacon,
  recordSevenPickQuicknetEvidence,
  resumeSevenPickRefund,
  sealSevenPickRound,
  settleSevenPickRound,
} from "./lifecycle";

type Db = Database.Database;
const DAY_MS = 24 * 60 * MINUTE_MS;
const SCHEDULE_AHEAD_MS = MINUTE_MS;
export const SEVEN_PICK_MAINTENANCE_INTERVAL_MS = 5_000;
const MAX_ACTIVE_NETWORK_ROUNDS = 4;
const activeNetwork = new WeakMap<Db, Set<number>>();
const lastNetworkStarts = new WeakMap<Db, Map<number, number>>();
export type SevenPickMaintenanceOptions = {
  network?: Parameters<typeof fetchQuicknetRound>[1];
  now?: number;
  onError?: (error: unknown, roundId?: number) => void;
};
type PendingRound = { id: number; status: SevenPickRound["status"]; opensAt: number; closesAt: number; drawAt: number; quicknetScheduledAt: number; quicknetRound: number; commitmentHex: string | null };

function scheduleUpcomingRounds(db: Db, now: number) {
  const today = beijingDayStart(now);
  for (const day of new Set([today, beijingDayStart(now + SCHEDULE_AHEAD_MS)])) {
    const config = getSevenPickConfig(db, Math.max(now, day));
    if (!config.enabled) continue;
    for (const minute of config.openMinutes) {
      const opensAt = day + minute * MINUTE_MS;
      if (opensAt > now && opensAt <= now + SCHEDULE_AHEAD_MS) {
        try { createSevenPickRound(db, opensAt, now); }
        catch (error) {
          // Another process can commit an admin pause after our first read.
          // Skip new slots without dropping settlement work for existing rounds.
          if (!(error instanceof SevenPickError) || error.code !== "BETTING_DISABLED") throw error;
        }
      }
    }
  }
}

function listPendingRounds(db: Db, now: number) {
  return db.prepare<[number], PendingRound>(
    "SELECT r.id,r.status,r.opens_at AS opensAt,r.closes_at AS closesAt,r.draw_at AS drawAt," +
    "r.quicknet_scheduled_at AS quicknetScheduledAt,r.quicknet_round AS quicknetRound,s.commitment_hex AS commitmentHex " +
    "FROM seven_pick_rounds r LEFT JOIN seven_pick_seals s ON s.round_id=r.id " +
    "WHERE r.opens_at<=? AND (r.status IN ('scheduled','open','sealed','ots_waiting','review','refunding') " +
    "OR (r.status='risk_skipped' AND EXISTS(SELECT 1 FROM seven_pick_ledger stake WHERE stake.round_id=r.id " +
    "AND stake.kind='stake' AND NOT EXISTS(SELECT 1 FROM seven_pick_ledger refund WHERE refund.bet_id=stake.bet_id AND refund.kind='refund')))) " +
    "ORDER BY r.opens_at DESC"
  ).all(now);
}

const QUICKNET_RETRY_INTERVAL_MS = 15_000;

function beaconFetchDue(db: Db, roundId: number, now: number, interval: number) {
  return !db.prepare<[number, number], number>(
    "SELECT 1 FROM seven_pick_audit WHERE round_id=? AND kind='quicknet' AND created_at>? LIMIT 1"
  ).pluck().get(roundId, now - interval);
}

async function fetchAndSettle(db: Db, round: PendingRound, options: SevenPickMaintenanceOptions, now: number) {
  // Use saved evidence first, including after a restart that interrupts payout.
  if (await settleSevenPickRound(db, round.id, options.now)) return;
  if (hasSevenPickVerifiedBeacon(db, round.id, round.quicknetRound)) return;
  const interval = now >= round.drawAt + DAY_MS ? 30 * MINUTE_MS : QUICKNET_RETRY_INTERVAL_MS;
  if (!beaconFetchDue(db, round.id, now, interval)) return;
  const { evidence } = await fetchQuicknetRound(round.quicknetRound, options.network);
  recordSevenPickQuicknetEvidence(db, round.id, evidence, options.now ?? Date.now());
  await settleSevenPickRound(db, round.id, options.now);
}

export async function tickSevenPickMaintenance(db: Db, options: SevenPickMaintenanceOptions): Promise<void> {
  const now = options.now ?? Date.now();
  const { paused } = getSevenPickRuntime(db);
  if (!paused) scheduleUpcomingRounds(db, now);
  let active = activeNetwork.get(db);
  if (!active) {
    active = new Set();
    activeNetwork.set(db, active);
  }
  let dequeued = lastNetworkStarts.get(db);
  if (!dequeued) {
    dequeued = new Map();
    lastNetworkStarts.set(db, dequeued);
  }
  const networkCandidates: PendingRound[] = [];
  for (const round of listPendingRounds(db, now)) {
    try {
      if (round.status === "refunding") {
        resumeSevenPickRefund(db, round.id, now);
        continue;
      }
      if (round.status === "risk_skipped" || (!paused && round.status === "scheduled" && now < round.closesAt)) {
        openSevenPickRound(db, round.id, now);
        continue;
      }
      if (round.status === "open" && now >= round.closesAt) {
        round.commitmentHex = sealSevenPickRound(db, round.id, options.now).commitmentHex;
      }
      evaluateSevenPickRound(db, round.id, now);
      if (round.commitmentHex && hasSevenPickQuicknetSeal(db, round.id) && now >= round.quicknetScheduledAt &&
          (round.status === "sealed" || round.status === "review")) {
        const sealedAt = db.prepare<[number], number>("SELECT sealed_at FROM seven_pick_seals WHERE round_id=?").pluck().get(round.id);
        if (sealedAt !== undefined && sealedAt < round.quicknetScheduledAt) networkCandidates.push(round);
      }
    } catch (error) {
      options.onError?.(error, round.id);
    }
  }
  const candidates = new Set(networkCandidates.map(round => round.id));
  for (const roundId of dequeued.keys()) if (!candidates.has(roundId)) dequeued.delete(roundId);
  const inFlight = active;
  const recent = dequeued;
  networkCandidates.sort((left, right) => {
    return (recent.get(left.id) ?? 0) - (recent.get(right.id) ?? 0);
  });
  const jobs = networkCandidates.filter(round => !inFlight.has(round.id))
    .slice(0, MAX_ACTIVE_NETWORK_ROUNDS - inFlight.size).map(round => {
      inFlight.add(round.id);
      recent.set(round.id, now);
      return fetchAndSettle(db, round, options, now)
        .catch(error => options.onError?.(error, round.id))
        .finally(() => inFlight.delete(round.id));
    });
  // Network wait does not block later ticks from sealing or refunding other rounds.
  await Promise.all(jobs);
}
