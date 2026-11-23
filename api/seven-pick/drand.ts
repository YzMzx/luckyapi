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
