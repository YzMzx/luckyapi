import type Database from "better-sqlite3";
import { canonicalItemIds, deriveDraw, DRAW_ALGORITHM_VERSION } from "./draw";
import { QUICKNET, quicknetRoundAtOrAfter, quicknetRoundTimeMs, verifyQuicknetBeacon, type QuicknetEvidence } from "./drand";
import { getSevenPickRound, type SevenPickRound } from "./engine";
import { buildAnonymousProof, type AnonymousBetInput } from "./proof";
import { applySevenPickCash } from "./wallet";

type Db = Database.Database;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export type SevenPickReviewReason = "quicknet_unconfirmed" | "sealed_after_beacon" | "missed_open";
export type SevenPickRefundReason = "seal_missed";
type AuditKind = "sealed" | "quicknet" | "ots" | "review_needed" | "review_approved" | "settled" | "refund_batch" | "refunded";
export class SevenPickLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SevenPickLifecycleError";
  }
}

export type SevenPickDrawSnapshot = Pick<SevenPickRound,
  "id" | "configVersionId" | "opensAt" | "closesAt" | "drawAt" | "quicknetRound" | "quicknetScheduledAt" |
  "quicknetNetwork" | "quicknetChainHash" | "quicknetPublicKey" | "quicknetScheme" | "algorithmVersion" |
  "minStakeUnits" | "maxStakeUnits" | "multipliers" | "items">;
export type SevenPickSeal = {
  roundId: number;
  sealedAt: number;
  commitmentHex: string;
  anonymousJson: string;
  snapshot: SevenPickDrawSnapshot;
};
type SealRow = Omit<SevenPickSeal, "snapshot"> & { snapshotJson: string };
export type SevenPickResult = {
  itemIds: number[];
  quicknetRound: number;
  randomnessHex: string;
  signature: string;
  settledAt: number;
  totalPayoutUnits: number;
};
type ResultRow = Omit<SevenPickResult, "itemIds"> & { itemIdsJson: string };
type AuditRow = { id: number; roundId: number; kind: AuditKind; createdAt: number; detailsJson: string };
type BetRow = { betId: number; userId: number; receiptId: string; stakeUnits: number; combinationKey: string; debitedUnits: number | null };
type RefundInput = { roundId: number; reason: SevenPickRefundReason; reviewer: string; notes: string };

function assertTime(now: number) {
  if (!Number.isSafeInteger(now) || now < 1 || now > 8_640_000_000_000_000 - DAY_MS) throw new RangeError("无效时间");
}

function assertRound(db: Db, roundId: number) {
  const round = getSevenPickRound(db, roundId);
  if (!round) throw new SevenPickLifecycleError("场次不存在");
  return round;
}

function readRoundStatus(db: Db, roundId: number) {
  return db.prepare<[number], SevenPickRound["status"]>("SELECT status FROM seven_pick_rounds WHERE id=?").pluck().get(roundId);
}

function snapshotRound(round: SevenPickRound): SevenPickDrawSnapshot {
  return {
    id: round.id, configVersionId: round.configVersionId,
    opensAt: round.opensAt, closesAt: round.closesAt, drawAt: round.drawAt,
    quicknetRound: round.quicknetRound, quicknetScheduledAt: round.quicknetScheduledAt,
    quicknetNetwork: round.quicknetNetwork, quicknetChainHash: round.quicknetChainHash,
    quicknetPublicKey: round.quicknetPublicKey, quicknetScheme: round.quicknetScheme,
    algorithmVersion: round.algorithmVersion,
    minStakeUnits: round.minStakeUnits, maxStakeUnits: round.maxStakeUnits,
    multipliers: round.multipliers, items: round.items,
  };
}

function assertBinding(snapshot: SevenPickDrawSnapshot) {
  if (snapshot.quicknetNetwork !== QUICKNET.network || snapshot.quicknetChainHash !== QUICKNET.chainHash ||
    snapshot.quicknetPublicKey !== QUICKNET.publicKey || snapshot.quicknetScheme !== QUICKNET.scheme ||
    quicknetRoundAtOrAfter(snapshot.drawAt) !== snapshot.quicknetRound ||
    quicknetRoundTimeMs(snapshot.quicknetRound) !== snapshot.quicknetScheduledAt ||
    snapshot.quicknetScheduledAt < snapshot.drawAt || snapshot.algorithmVersion !== DRAW_ALGORITHM_VERSION) {
    throw new SevenPickLifecycleError("场次预绑定的 Quicknet 或排序版本不匹配");
  }
}

function audit(db: Db, roundId: number, kind: AuditKind, details: unknown, now: number) {
  return db.prepare("INSERT INTO seven_pick_audit (round_id,kind,details_json,created_at) VALUES (?,?,?,?)")
    .run(roundId, kind, JSON.stringify(details), now).lastInsertRowid;
}

function auditRows(db: Db, roundId: number, kind: AuditKind) {
  return db.prepare<[number, AuditKind], AuditRow>(
    "SELECT id,round_id AS roundId,kind,created_at AS createdAt,details_json AS detailsJson " +
    "FROM seven_pick_audit WHERE round_id=? AND kind=? ORDER BY id"
  ).all(roundId, kind);
}

export function listSevenPickAudit(db: Db, roundId: number, beforeId?: number, limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError("无效审计分页大小");
  return db.prepare<[number, number, number], Omit<AuditRow, "kind"> & { kind: AuditKind | "tsa" }>(
    "SELECT a.id,a.round_id AS roundId,CASE WHEN t.audit_id IS NULL THEN a.kind ELSE 'tsa' END AS kind," +
    "a.created_at AS createdAt,COALESCE(t.evidence_json,a.details_json) AS detailsJson FROM seven_pick_audit a " +
    "LEFT JOIN seven_pick_timing_evidence t ON t.audit_id=a.id WHERE a.round_id=? AND a.id<? ORDER BY a.id DESC LIMIT ?"
  ).all(roundId, beforeId ?? Number.MAX_SAFE_INTEGER, limit).map(({ detailsJson, ...row }) => ({
    ...row, details: JSON.parse(detailsJson) as unknown,
  }));
}

export function getSevenPickSealedProof(db: Db, roundId: number): SevenPickSeal | null {
  const row = db.prepare<[number], SealRow>(
    "SELECT round_id AS roundId,sealed_at AS sealedAt,commitment_hex AS commitmentHex," +
    "anonymous_json AS anonymousJson,snapshot_json AS snapshotJson FROM seven_pick_seals WHERE round_id=?"
  ).get(roundId);
  if (!row) return null;
  const { snapshotJson, ...seal } = row;
  return { ...seal, snapshot: JSON.parse(snapshotJson) as SevenPickDrawSnapshot };
}

function readBets(db: Db, roundId: number) {
  return db.prepare<[number], BetRow>(
    "SELECT b.id AS betId,b.user_id AS userId,b.receipt_id AS receiptId,b.stake_units AS stakeUnits," +
    "b.combination_key AS combinationKey,s.delta_units AS debitedUnits FROM seven_pick_bets b " +
    "LEFT JOIN seven_pick_ledger s ON s.bet_id=b.id AND s.round_id=b.round_id AND s.user_id=b.user_id AND s.kind='stake' " +
    "WHERE b.round_id=? ORDER BY b.id"
  ).all(roundId);
}

function anonymousBets(bets: BetRow[], snapshot: SevenPickDrawSnapshot): AnonymousBetInput[] {
  return bets.map(({ receiptId, stakeUnits, combinationKey, debitedUnits }) => {
    if (debitedUnits !== -stakeUnits || stakeUnits < snapshot.minStakeUnits || stakeUnits > snapshot.maxStakeUnits)
      throw new SevenPickLifecycleError("投注与扣款流水不匹配");
    return { receiptId, stakeUnits, itemIds: canonicalItemIds(JSON.parse(combinationKey) as number[], 7) };
  });
}

export function sealSevenPickRound(db: Db, roundId: number, now?: number): SevenPickSeal {
  return db.transaction(() => {
    const startedAt = now ?? Date.now();
    assertTime(startedAt);
    const existing = getSevenPickSealedProof(db, roundId);
    if (existing) return existing;
    const round = assertRound(db, roundId);
    if (round.status !== "open" || startedAt < round.closesAt) throw new SevenPickLifecycleError("尚未到达封盘时间，或场次未开放");
    const snapshot = snapshotRound(round);
    assertBinding(snapshot);
    const proof = buildAnonymousProof({ roundId, itemIds: snapshot.items.map(item => item.id), bets: anonymousBets(readBets(db, roundId), snapshot) });
    // Take time after acquiring the SQLite writer lock and freezing the manifest;
    // a blocked or slow worker cannot backdate an otherwise missed seal.
    const sealedAt = Math.max(startedAt, now ?? Date.now());
    db.prepare("INSERT INTO seven_pick_seals (round_id,sealed_at,commitment_hex,anonymous_json,snapshot_json) VALUES (?,?,?,?,?)")
      .run(roundId, sealedAt, proof.commitmentHex, proof.canonicalJson, JSON.stringify(snapshot));
    db.prepare("INSERT INTO seven_pick_quicknet_seals (round_id) VALUES (?)").run(roundId);
    db.prepare("UPDATE seven_pick_rounds SET status='sealed' WHERE id=?").run(roundId);
    audit(db, roundId, "sealed", { commitmentHex: proof.commitmentHex }, sealedAt);
    return { roundId, sealedAt, commitmentHex: proof.commitmentHex, anonymousJson: proof.canonicalJson, snapshot };
  }).immediate();
}

export function hasSevenPickQuicknetSeal(db: Db, roundId: number) {
  return db.prepare<[number], number>("SELECT 1 FROM seven_pick_quicknet_seals WHERE round_id=?").pluck().get(roundId) === 1;
}

export function recordSevenPickQuicknetEvidence(db: Db, roundId: number, entries: readonly QuicknetEvidence[], now = Date.now()) {
  assertTime(now);
  db.transaction(() => {
    const seal = getSevenPickSealedProof(db, roundId);
    if (!seal || !hasSevenPickQuicknetSeal(db, roundId)) throw new SevenPickLifecycleError("场次尚未按 Quicknet 规则封盘");
    for (const entry of entries) {
      if (entry.round !== seal.snapshot.quicknetRound) throw new SevenPickLifecycleError("随机数证据不属于预绑定轮次");
      audit(db, roundId, "quicknet", entry, now);
    }
  }).immediate();
}

export function hasSevenPickVerifiedBeacon(db: Db, roundId: number, quicknetRound: number) {
  return findVerifiedBeacon(readSevenPickQuicknetEvidence(db, roundId), quicknetRound) !== null;
}

function readSevenPickQuicknetEvidence(db: Db, roundId: number): QuicknetEvidence[] {
  return auditRows(db, roundId, "quicknet").map(row => JSON.parse(row.detailsJson) as QuicknetEvidence);
}

function readResult(db: Db, roundId: number) {
  return db.prepare<[number], ResultRow>(
    "SELECT item_ids_json AS itemIdsJson,quicknet_round AS quicknetRound,randomness_hex AS randomnessHex," +
    "signature,settled_at AS settledAt,total_payout_units AS totalPayoutUnits FROM seven_pick_quicknet_draws WHERE round_id=?"
  ).get(roundId);
}

function resultView(row: ResultRow): SevenPickResult {
  return {
    itemIds: JSON.parse(row.itemIdsJson) as number[], quicknetRound: row.quicknetRound, randomnessHex: row.randomnessHex,
    signature: row.signature, settledAt: row.settledAt, totalPayoutUnits: row.totalPayoutUnits,
  };
}

export function getSevenPickPublicProof(db: Db, roundId: number) {
  return db.transaction(() => {
    const row = readResult(db, roundId);
    if (!row) return null;
    const seal = getSevenPickSealedProof(db, roundId);
    if (!seal) throw new SevenPickLifecycleError("结算缺少封盘证明");
    return { ...seal, result: resultView(row) };
  })();
}

function findVerifiedBeacon(evidence: readonly QuicknetEvidence[], round: number) {
  for (const entry of evidence) {
    if (entry.bodyHex === null || entry.statusCode !== 200 || entry.error !== null || entry.round !== round) continue;
    try {
      return verifyQuicknetBeacon(round, JSON.parse(Buffer.from(entry.bodyHex, "hex").toString("utf8")) as unknown);
    } catch {
      // Verification against the fixed round is authoritative, not the HTTP status or saved verdict.
    }
  }
  return null;
}

function settleRound(db: Db, seal: SevenPickSeal, verified: NonNullable<ReturnType<typeof findVerifiedBeacon>>, now: number): SevenPickResult {
  const { roundId, snapshot } = seal;
  if (!hasSevenPickQuicknetSeal(db, roundId)) {
    throw new SevenPickLifecycleError("当前状态不可结算");
  }
  assertBinding(snapshot);
  if (verified.round !== snapshot.quicknetRound || now < snapshot.quicknetScheduledAt ||
    seal.sealedAt < snapshot.closesAt || seal.sealedAt >= snapshot.quicknetScheduledAt) {
    throw new SevenPickLifecycleError("开奖未到或封盘不早于预绑定轮次");
  }

  const itemIds = snapshot.items.map(item => item.id);
  const bets = readBets(db, roundId);
  const anonymous = anonymousBets(bets, snapshot);
  const proof = buildAnonymousProof({ roundId, itemIds, bets: anonymous });
  if (proof.commitmentHex !== seal.commitmentHex || proof.canonicalJson !== seal.anonymousJson)
    throw new SevenPickLifecycleError("封盘后投注证明发生变化");
  const draw = deriveDraw(itemIds, verified.randomness);
  const winning = new Set(draw);
  const payouts = anonymous.map(bet => BigInt(bet.stakeUnits) * BigInt(snapshot.multipliers[bet.itemIds.filter(item => winning.has(item)).length]));
  // Keep the round total exact; applySevenPickCash also checks each delta and resulting wallet balance.
  const total = payouts.reduce((sum, units) => sum + units, 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new SevenPickLifecycleError("结算金额超出安全整数范围");
  for (const [i, bet] of bets.entries()) {
    if (payouts[i] === 0n) continue;
    applySevenPickCash(db, { roundId, betId: bet.betId, userId: bet.userId, kind: "payout", deltaUnits: Number(payouts[i]), now });
  }
  const result = {
    itemIds: draw, quicknetRound: verified.round, randomnessHex: verified.randomness, signature: verified.signature,
    settledAt: now, totalPayoutUnits: Number(total),
  };
  db.prepare("INSERT INTO seven_pick_quicknet_draws (round_id,settled_at,quicknet_round,signature,randomness_hex,item_ids_json,total_payout_units) " +
    "VALUES (?,?,?,?,?,?,?)").run(roundId, now, verified.round, verified.signature, verified.randomness, JSON.stringify(draw), Number(total));
  db.prepare("UPDATE seven_pick_rounds SET status='settled' WHERE id=?").run(roundId);
  audit(db, roundId, "settled", result, now);
  return result;
}

/** Settle only a locally frozen round with a re-verified signature for its exact bound round. */
export async function settleSevenPickRound(db: Db, roundId: number, now?: number) {
  const checkedAt = now ?? Date.now();
  assertTime(checkedAt);
  const seal = getSevenPickSealedProof(db, roundId);
  const status = readRoundStatus(db, roundId);
  if (!seal || !hasSevenPickQuicknetSeal(db, roundId) || checkedAt < seal.snapshot.quicknetScheduledAt ||
    !["sealed", "review"].includes(status ?? "")) return null;
  if (seal.sealedAt >= seal.snapshot.quicknetScheduledAt) {
    flagReview(db, roundId, ["sealed_after_beacon"], checkedAt);
    return null;
  }
  const beacon = findVerifiedBeacon(readSevenPickQuicknetEvidence(db, roundId), seal.snapshot.quicknetRound);
  if (!beacon) return null;
  return db.transaction(() => {
    const status = readRoundStatus(db, roundId);
    if (status !== "sealed" && status !== "review") return null;
    return settleRound(db, seal, beacon, now ?? Date.now());
  }).immediate();
}

function reviewReasons(db: Db, roundId: number) {
  return auditRows(db, roundId, "review_needed").map(({ detailsJson }) => (JSON.parse(detailsJson) as { reason: SevenPickReviewReason }).reason);
}

function flagReview(db: Db, roundId: number, reasons: SevenPickReviewReason[], now: number) {
  if (!reasons.length) return;
  db.transaction(() => {
    const round = assertRound(db, roundId);
    if (!["scheduled", "sealed", "ots_waiting", "review"].includes(round.status)) return;
    const prior = new Set(reviewReasons(db, roundId));
    for (const reason of reasons) if (!prior.has(reason)) audit(db, roundId, "review_needed", { reason }, now);
    db.prepare("UPDATE seven_pick_rounds SET status='review' WHERE id=? AND status<>'review'").run(roundId);
  }).immediate();
}

export function evaluateSevenPickRound(db: Db, roundId: number, now = Date.now()) {
  assertTime(now);
  const round = assertRound(db, roundId);
  if (round.status === "scheduled" && now >= round.closesAt) {
    flagReview(db, roundId, ["missed_open"], now);
    return;
  }
  if (!["sealed", "review"].includes(round.status) || !hasSevenPickQuicknetSeal(db, roundId)) return;
  const sealedAt = db.prepare<[number], number>("SELECT sealed_at FROM seven_pick_seals WHERE round_id=?").pluck().get(roundId);
  if (sealedAt === undefined) return;
  const reasons: SevenPickReviewReason[] = [];
  if (now >= round.drawAt + HOUR_MS && !hasSevenPickVerifiedBeacon(db, roundId, round.quicknetRound)) {
    reasons.push("quicknet_unconfirmed");
  }
  if (sealedAt >= round.quicknetScheduledAt) reasons.push("sealed_after_beacon");
  flagReview(db, roundId, reasons, now);
}

type ReviewRow = { reason: SevenPickRefundReason | "quicknet_unpublished" | "ots_ineligible"; reviewedAt: number; reviewer: string; notes: string };
function readReview(db: Db, roundId: number) {
  return db.prepare<[number], ReviewRow>(
    "SELECT reason,reviewer,notes,reviewed_at AS reviewedAt FROM seven_pick_quicknet_reviews WHERE round_id=?"
  ).get(roundId) ?? db.prepare<[number], ReviewRow>(
    "SELECT reason,reviewer,notes,reviewed_at AS reviewedAt FROM seven_pick_reviews WHERE round_id=?"
  ).get(roundId);
}

function refundProgress(db: Db, roundId: number) {
  return db.prepare<[number], { totalBets: number; refundedBets: number; refundedAt: number | null }>(
    "SELECT COUNT(*) AS totalBets,COUNT(refund.id) AS refundedBets,MAX(refund.created_at) AS refundedAt " +
    "FROM seven_pick_ledger AS stake LEFT JOIN seven_pick_ledger AS refund " +
    "ON refund.bet_id=stake.bet_id AND refund.kind='refund' WHERE stake.round_id=? AND stake.kind='stake'"
  ).get(roundId)!;
}

export function getSevenPickLifecycle(db: Db, roundId: number) {
  return db.transaction(() => {
    const round = db.prepare<[number], { status: SevenPickRound["status"] }>("SELECT status FROM seven_pick_rounds WHERE id=?").get(roundId);
    if (!round) return null;
    const seal = db.prepare<[number], { sealedAt: number; commitmentHex: string }>(
      "SELECT sealed_at AS sealedAt,commitment_hex AS commitmentHex FROM seven_pick_seals WHERE round_id=?"
    ).get(roundId);
    const row = readResult(db, roundId);
    const review = readReview(db, roundId);
    const progress = review ? refundProgress(db, roundId) : null;
    const finished = round.status === "refunded" ? auditRows(db, roundId, "refunded").at(-1) : undefined;
    return {
      status: round.status, sealedAt: seal?.sealedAt ?? null, commitmentHex: seal?.commitmentHex ?? null,
      result: row ? resultView(row) : null, reviewReasons: reviewReasons(db, roundId),
      refund: review && progress ? {
        reason: review.reason, reviewedAt: review.reviewedAt,
        summary: review.reason === "seal_missed" ? "封盘未在预绑定 Quicknet 轮次前完成" : "旧规则已批准退款",
        totalBets: progress.totalBets, refundedBets: progress.refundedBets, refundedAt: finished?.createdAt ?? null,
      } : null,
    };
  })();
}

/** A timeout is not refund evidence; only an immutable missed seal proves ineligibility. */
export async function approveSevenPickRefund(db: Db, input: RefundInput, now = Date.now()) {
  assertTime(now);
  const { roundId, reason, reviewer, notes } = input;
  if (reason !== "seal_missed") throw new SevenPickLifecycleError("未知核查原因");
  if (!reviewer.trim() || reviewer.length > 120 || !notes.trim() || notes.length > 2000) {
    throw new SevenPickLifecycleError("必须填写核查人和核查理由");
  }
  return db.transaction(() => {
    const round = assertRound(db, roundId);
    const existing = readReview(db, roundId);
    if (existing) {
      if (existing.reason !== reason) throw new SevenPickLifecycleError("场次已有不可变更的退款决定");
      return getSevenPickLifecycle(db, roundId);
    }
    if (round.status !== "review" || readResult(db, roundId)) throw new SevenPickLifecycleError("场次当前不可批准退款");
    const seal = getSevenPickSealedProof(db, roundId);
    if (!seal || !hasSevenPickQuicknetSeal(db, roundId) || seal.sealedAt < round.quicknetScheduledAt || now < seal.sealedAt) {
      throw new SevenPickLifecycleError("不可仅凭网络超时或查询失败退款；须有未在固定轮次前封盘的证据");
    }
    const evidence = { sealedAt: seal.sealedAt, quicknetScheduledAt: round.quicknetScheduledAt, quicknetRound: round.quicknetRound };
    db.prepare("INSERT INTO seven_pick_quicknet_reviews (round_id,reason,reviewer,notes,evidence_json,reviewed_at) VALUES (?,?,?,?,?,?)")
      .run(roundId, reason, reviewer.trim(), notes.trim(), JSON.stringify(evidence), now);
    db.prepare("UPDATE seven_pick_rounds SET status='refunding' WHERE id=?").run(roundId);
    audit(db, roundId, "review_approved", { reason, reviewer: reviewer.trim(), notes: notes.trim(), evidence }, now);
    return getSevenPickLifecycle(db, roundId);
  }).immediate();
}

export function resumeSevenPickRefund(db: Db, roundId: number, now = Date.now(), batchSize = 100) {
  assertTime(now);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new RangeError("无效退款批次大小");
  return db.transaction(() => {
    const round = assertRound(db, roundId);
    if (round.status === "refunded") return getSevenPickLifecycle(db, roundId);
    if (round.status !== "refunding" || !readReview(db, roundId) || readResult(db, roundId))
      throw new SevenPickLifecycleError("仅可续退经核查批准且尚未结算的场次");
    const bets = db.prepare<[number, number], { betId: number; userId: number; stakeUnits: number }>(
      "SELECT stake.bet_id AS betId,stake.user_id AS userId,-stake.delta_units AS stakeUnits " +
      "FROM seven_pick_ledger stake WHERE stake.round_id=? AND stake.kind='stake' AND NOT EXISTS (" +
      "SELECT 1 FROM seven_pick_ledger refund WHERE refund.bet_id=stake.bet_id AND refund.kind='refund') " +
      "ORDER BY stake.bet_id LIMIT ?"
    ).all(roundId, batchSize);
    for (const { betId, userId, stakeUnits } of bets) {
      applySevenPickCash(db, { roundId, betId, userId, kind: "refund", deltaUnits: stakeUnits, now });
    }
    if (bets.length) audit(db, roundId, "refund_batch", { betCount: bets.length }, now);
    const { totalBets, refundedBets } = refundProgress(db, roundId);
    if (totalBets === refundedBets) {
      db.prepare("UPDATE seven_pick_rounds SET status='refunded' WHERE id=?").run(roundId);
      audit(db, roundId, "refunded", { totalBets }, now);
    }
    return getSevenPickLifecycle(db, roundId);
  }).immediate();
}

