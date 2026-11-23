import { createHash } from "node:crypto";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import { requestProof, type ProofHttpEvidence, type ProofNetworkOptions } from "./proof-network";

export type { ProofNetworkOptions } from "./proof-network";

/** Pinned production drand Quicknet parameters, not accepted from an HTTP response. */
export const QUICKNET = Object.freeze({
  network: 'quicknet',
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  publicKey: '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  scheme: 'bls-unchained-g1-rfc9380',
  genesisTimeMs: 1692803367000,
  periodMs: 3000,
  genesisSeed: 'f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e',
})

export function quicknetRoundTimeMs(round: number): number {
  if (!Number.isSafeInteger(round) || round < 1) throw new Error('Invalid Quicknet round')
  const timeMs = QUICKNET.genesisTimeMs + (round - 1) * QUICKNET.periodMs
  if (!Number.isSafeInteger(timeMs)) throw new Error('Quicknet round time is out of range')
  return timeMs
}

/** Use this once at round creation; never recompute a target based on fetch time. */
export function quicknetRoundAtOrAfter(timeMs: number): number {
  if (!Number.isSafeInteger(timeMs) || timeMs < QUICKNET.genesisTimeMs) {
    throw new Error('Invalid Quicknet target time')
  }
  const round = 1 + Math.ceil((timeMs - QUICKNET.genesisTimeMs) / QUICKNET.periodMs)
  quicknetRoundTimeMs(round) // Check for an out-of-range scheduled timestamp after rounding up.
  return round
}

const QUICKNET_G1_DOMAIN = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
const SIGNATURE_HEX = /^[0-9a-f]{96}$/i;

export type QuicknetBeacon = Readonly<{ round: number; signature: string; randomness: string }>;
export type QuicknetEvidence = ProofHttpEvidence & {
  source: "drand-v2" | "cloudflare-v1";
  round: number;
  verdict: "verified" | "invalid" | "unavailable";
};

export function verifyQuicknetBeacon(expectedRound: number, input: unknown): QuicknetBeacon {
  quicknetRoundTimeMs(expectedRound);
  if (typeof input !== "object" || input === null) throw new Error("Invalid Quicknet response");
  const { round, signature, randomness } = input as Record<string, unknown>;
  if (round !== expectedRound) throw new Error("Quicknet response round does not match fixed round");
  if (typeof signature !== "string" || signature.length !== 96 || !SIGNATURE_HEX.test(signature)) {
    throw new Error("Invalid Quicknet signature encoding");
  }
  const signatureBytes = Buffer.from(signature, "hex");
  const roundBytes = Buffer.alloc(8);
  roundBytes.writeBigUInt64BE(BigInt(expectedRound));
  const roundHash = createHash("sha256").update(roundBytes).digest();
  const bls = bls12_381.shortSignatures;
  const message = bls.hash(roundHash, QUICKNET_G1_DOMAIN);
  const publicKey = Buffer.from(QUICKNET.publicKey, "hex");
  const point = bls.Signature.fromBytes(signatureBytes);
  // Randomness commits to signature bytes, so only the canonical nonzero G1 encoding is allowed.
  if (point.is0() || !signatureBytes.equals(bls.Signature.toBytes(point)) || !bls.verify(point, message, publicKey)) {
    throw new Error("Invalid Quicknet BLS signature");
  }
  const verifiedRandomness = createHash("sha256").update(signatureBytes).digest("hex");
  if (randomness !== undefined && randomness !== verifiedRandomness) {
    throw new Error("Quicknet randomness does not match signature hash");
  }
  return Object.freeze({ round: expectedRound, signature: signature.toLowerCase(), randomness: verifiedRandomness });
}

/** Query two fixed public relays for exactly the already bound round; neither HTTP failure proves nonpublication. */
export async function fetchQuicknetRound(expectedRound: number, options: ProofNetworkOptions = {}) {
  quicknetRoundTimeMs(expectedRound);
  const relays = [
    { source: "drand-v2", url: "https://api.drand.sh/v2/beacons/quicknet/rounds/" + expectedRound },
    { source: "cloudflare-v1", url: "https://drand.cloudflare.com/" + QUICKNET.chainHash + "/public/" + expectedRound },
  ] as const;
  const results = await Promise.all(relays.map(async ({ source, url }): Promise<{ record: QuicknetEvidence; beacon: QuicknetBeacon | null }> => {
    const record: QuicknetEvidence = {
      ...await requestProof(url, { method: "GET", headers: { Accept: "application/json" } }, 8192, options),
      source,
      round: expectedRound,
      verdict: "unavailable",
    };
    if (record.statusCode !== 200 || record.bodyHex === null) return { record, beacon: null };
    try {
      const body = JSON.parse(Buffer.from(record.bodyHex, "hex").toString("utf8")) as unknown;
      const beacon = verifyQuicknetBeacon(expectedRound, body);
      return { record: { ...record, verdict: "verified" }, beacon };
    } catch (error) {
      return { record: { ...record, verdict: "invalid", error: String(error).slice(0, 512) }, beacon: null };
    }
  }));
  const evidence = results.map(({ record }) => record);
  const verified = results.flatMap(({ beacon }) => beacon ? [beacon] : []);
  if (verified.some(({ signature }) => signature !== verified[0].signature)) throw new Error("Conflicting verified Quicknet signatures");
  return { beacon: verified[0] ?? null, evidence };
}
