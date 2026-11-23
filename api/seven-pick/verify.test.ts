import { describe, expect, it } from "vitest";
import { DRAW_ALGORITHM_VERSION } from "./draw";
import { QUICKNET } from "./drand";
import { buildAnonymousProof } from "./proof";
import { verifySevenPickBundle } from "./verify";

const signature = "b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b";
const randomnessHex = "1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a";
const itemIds = Array.from({ length: 32 }, (_, i) => i + 1);
const drawn = [1, 6, 15, 22, 29, 30, 32];
const roundId = 42;
function fixture() {
  const { canonicalJson, commitmentHex } = buildAnonymousProof({ roundId, itemIds, bets: [
    { receiptId: "a".repeat(32), itemIds: drawn, stakeUnits: 1_001 },
    { receiptId: "b".repeat(32), itemIds: [1, 2, 3, 4, 5, 6, 15], stakeUnits: 1_222 },
  ] });
  return {
    roundId, commitmentHex, anonymousJson: canonicalJson,
    sealedAt: QUICKNET.genesisTimeMs - 600_000,
    snapshot: {
      id: roundId, opensAt: QUICKNET.genesisTimeMs - 1_200_000, closesAt: QUICKNET.genesisTimeMs - 600_000,
      drawAt: QUICKNET.genesisTimeMs, quicknetScheduledAt: QUICKNET.genesisTimeMs, quicknetRound: 1,
      quicknetNetwork: QUICKNET.network, quicknetChainHash: QUICKNET.chainHash, quicknetPublicKey: QUICKNET.publicKey,
      quicknetScheme: QUICKNET.scheme, algorithmVersion: DRAW_ALGORITHM_VERSION,
      minStakeUnits: 1_000, maxStakeUnits: 100_000,
      multipliers: [0, 0, 0, 3, 12, 100, 1000, 50_000], items: itemIds.map((id) => ({ id })),
    },
    result: {
      itemIds: [...drawn], quicknetRound: 1, randomnessHex, signature, settledAt: QUICKNET.genesisTimeMs + 10_000,
      totalPayoutUnits: "50053666",
    },
  };
}

describe("independent seven-pick bundle verification", () => {
  it("recomputes the beacon, result and aggregate amounts offline", () => {
    expect(verifySevenPickBundle(fixture())).toMatchObject({
      roundId, itemIds: drawn, beacon: { round: 1, signature, randomness: randomnessHex }, totalPayoutUnits: "50053666",
      timestamp: { status: "missing" },
    });
  });
  it("reports a bad optional certificate separately without changing a valid result", () => {
    expect(verifySevenPickBundle({ ...fixture(), timestamp: { claimedValid: true } })).toMatchObject({
      itemIds: drawn, totalPayoutUnits: "50053666", timestamp: { status: "invalid" },
    });
  });

  it("recalculates a chosen receipt locally without echoing its identifier", () => {
    const bundle = fixture();
    const verified = verifySevenPickBundle(bundle, "b".repeat(32));
    expect(verified.receipt).toEqual({
      itemIds: [1, 2, 3, 4, 5, 6, 15], hitItemIds: [1, 6, 15], hits: 3,
      stakeUnits: 1_222, multiplier: 3, payoutUnits: "3666",
    });
    expect(verified.totalPayoutUnits).toBe("50053666");
    expect(JSON.stringify(verified)).not.toContain("b".repeat(32));
    expect(verifySevenPickBundle(bundle)).not.toHaveProperty("receipt");
    expect(() => verifySevenPickBundle(bundle, "B".repeat(32))).toThrow("lowercase hexadecimal");
    expect(() => verifySevenPickBundle(bundle, "c".repeat(32))).toThrow("not found");
  });

  it("rejects mutated data and frozen network metadata", () => {
    const bundle = fixture();
    for (const modified of [
      { ...bundle, anonymousJson: bundle.anonymousJson + "\n" },
      { ...bundle, commitmentHex: "0".repeat(64) },
      { ...bundle, snapshot: { ...bundle.snapshot, quicknetRound: 2 } },
      { ...bundle, snapshot: { ...bundle.snapshot, quicknetChainHash: "0".repeat(64) } },
      { ...bundle, result: { ...bundle.result, itemIds: [2, ...drawn.slice(1)] } },
      { ...bundle, result: { ...bundle.result, totalPayoutUnits: "50053667" } },
    ]) expect(() => verifySevenPickBundle(modified)).toThrow();
  });
});
