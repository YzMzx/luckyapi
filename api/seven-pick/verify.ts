import { z } from "zod";
import { deriveDraw, DRAW_ALGORITHM_VERSION } from "./draw";
import { QUICKNET, quicknetRoundAtOrAfter, quicknetRoundTimeMs, verifyQuicknetBeacon } from "./drand";
import { ANONYMOUS_PROOF_VERSION, buildAnonymousProof } from "./proof";
import { verifySevenPickSealTimestamp } from "./seal-timestamp";

const positiveInt = z.number().int().positive();
const itemId = positiveInt.max(32);
const timestamp = positiveInt;
const units = z.number().int().min(1_000).max(100_000);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const receiptIdInput = z.string().length(32).regex(/^[0-9a-f]+$/);
const proofInput = z.object({
  roundId: positiveInt,
  sealedAt: timestamp,
  commitmentHex: hash,
  anonymousJson: z.string(),
  timestamp: z.unknown().optional(),
  snapshot: z.object({
    id: positiveInt, opensAt: timestamp, closesAt: timestamp, drawAt: timestamp,
    quicknetRound: positiveInt, quicknetScheduledAt: timestamp, quicknetNetwork: z.literal(QUICKNET.network),
    quicknetChainHash: z.literal(QUICKNET.chainHash), quicknetPublicKey: z.literal(QUICKNET.publicKey),
    quicknetScheme: z.literal(QUICKNET.scheme), algorithmVersion: z.literal(DRAW_ALGORITHM_VERSION),
    minStakeUnits: units, maxStakeUnits: units,
    multipliers: z.array(z.number().int().min(0).max(1_000_000)).length(8),
    items: z.array(z.object({ id: itemId })).length(32),
  }),
  result: z.object({
    itemIds: z.array(itemId).length(7), quicknetRound: positiveInt, randomnessHex: hash, signature: z.string().length(96),
    settledAt: timestamp, totalPayoutUnits: z.union([z.number().int().nonnegative(), z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/)]),
  }),
});
const anonymousInput = z.strictObject({
  version: z.literal(ANONYMOUS_PROOF_VERSION), roundId: positiveInt, itemIds: z.array(itemId).length(32),
  bets: z.array(z.strictObject({ receiptId: z.string(), itemIds: z.array(itemId).length(7), stakeUnits: units })),
});

/** Recompute the pinned Quicknet signature, draw and payout offline. */
export function verifySevenPickBundle(value: unknown, receiptId?: string) {
  if (receiptId !== undefined && !receiptIdInput.safeParse(receiptId).success) {
    throw new Error("Expected receipt ID to be 32 lowercase hexadecimal characters");
  }
  const bundle = proofInput.parse(value);
  const { snapshot, result } = bundle;
  if (bundle.roundId !== snapshot.id || snapshot.opensAt >= snapshot.closesAt || snapshot.closesAt >= snapshot.drawAt ||
      bundle.sealedAt < snapshot.closesAt || bundle.sealedAt >= snapshot.quicknetScheduledAt || result.settledAt < snapshot.quicknetScheduledAt || result.settledAt < bundle.sealedAt) {
    throw new Error("Inconsistent published round or event times");
  }
  if (snapshot.quicknetRound !== quicknetRoundAtOrAfter(snapshot.drawAt) ||
      snapshot.quicknetScheduledAt !== quicknetRoundTimeMs(snapshot.quicknetRound)) {
    throw new Error("Quicknet round does not match the frozen target time");
  }
  if (snapshot.minStakeUnits > snapshot.maxStakeUnits || snapshot.multipliers.slice(0, 3).some(Boolean) || snapshot.multipliers.slice(3).some((x) => x === 0)) {
    throw new Error("Invalid frozen seven-pick rules");
  }
  const itemIds = snapshot.items.map(({ id }) => id);
  const bets = anonymousInput.parse(JSON.parse(bundle.anonymousJson) as unknown);
  const canonical = buildAnonymousProof({ roundId: bundle.roundId, itemIds, bets: bets.bets });
  if (bundle.anonymousJson !== canonical.canonicalJson || bundle.commitmentHex !== canonical.commitmentHex) {
    throw new Error("Anonymous bets do not match the commitment and frozen item set");
  }
  const beacon = verifyQuicknetBeacon(snapshot.quicknetRound, {
    round: result.quicknetRound, signature: result.signature, randomness: result.randomnessHex,
  });
  const drawnItemIds = deriveDraw(itemIds, beacon.randomness);
  if (drawnItemIds.some((id, i) => id !== result.itemIds[i])) throw new Error("Drawn items do not match the verified beacon");
  const drawn = new Set(drawnItemIds);
  let total = 0n;
  let receipt: { itemIds: number[]; hitItemIds: number[]; hits: number; stakeUnits: number; multiplier: number; payoutUnits: string } | undefined;
  for (const bet of bets.bets) {
    if (bet.stakeUnits < snapshot.minStakeUnits || bet.stakeUnits > snapshot.maxStakeUnits) throw new Error("Stake outside frozen limits");
    const hitItemIds = bet.itemIds.filter((id) => drawn.has(id));
    const hits = hitItemIds.length;
    const multiplier = snapshot.multipliers[hits];
    const payoutUnits = BigInt(bet.stakeUnits) * BigInt(multiplier);
    total += payoutUnits;
    if (bet.receiptId === receiptId) {
      receipt = { itemIds: bet.itemIds, hitItemIds, hits, stakeUnits: bet.stakeUnits, multiplier, payoutUnits: payoutUnits.toString() };
    }
  }
  if (receiptId !== undefined && !receipt) throw new Error("Receipt was not found in the committed bets");
  if (total !== BigInt(result.totalPayoutUnits)) throw new Error("Total payout does not match the disclosed bets and odds");
  const binding = { roundId: bundle.roundId, sealedAt: bundle.sealedAt, commitmentHex: bundle.commitmentHex, quicknetRound: snapshot.quicknetRound };
  const timestamp = (() => {
    if (bundle.timestamp === undefined) return { status: "missing" as const };
    try { return { status: "verified" as const, ...verifySevenPickSealTimestamp(binding, bundle.timestamp) }; }
    catch { return { status: "invalid" as const }; }
  })();
  return { roundId: bundle.roundId, commitmentHex: bundle.commitmentHex, beacon, itemIds: drawnItemIds,
    totalPayoutUnits: total.toString(), timestamp, ...(receipt ? { receipt } : {}) };
}
