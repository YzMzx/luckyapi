import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { QUICKNET, quicknetRoundAtOrAfter, quicknetRoundTimeMs } from './drand'
import { DRAW_ALGORITHM_VERSION, deriveDraw } from './draw'
import { buildAnonymousProof } from './proof'

const itemIds = Array.from({ length: 32 }, (_, i) => i + 1)
const roundOneRandomness = '1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a'

describe('Quicknet schedule', () => {
  it('binds the pinned chain hash to its public parameters', () => {
    // drand chain.Info.Hash wire order (the scheme is separately pinned).
    const prefix = Buffer.alloc(12)
    prefix.writeUInt32BE(QUICKNET.periodMs / 1000)
    prefix.writeBigUInt64BE(BigInt(QUICKNET.genesisTimeMs / 1000), 4)
    const hash = createHash('sha256')
      .update(prefix)
      .update(Buffer.from(QUICKNET.publicKey, 'hex'))
      .update(Buffer.from(QUICKNET.genesisSeed, 'hex'))
      .update(QUICKNET.network)
      .digest('hex')
    expect(hash).toBe(QUICKNET.chainHash)
  })

  it('binds the first round at or after the target, with round 1 at genesis', () => {
    expect(quicknetRoundTimeMs(1)).toBe(QUICKNET.genesisTimeMs)
    expect(quicknetRoundAtOrAfter(QUICKNET.genesisTimeMs)).toBe(1)
    expect(quicknetRoundAtOrAfter(QUICKNET.genesisTimeMs + 1)).toBe(2)
    expect(quicknetRoundAtOrAfter(QUICKNET.genesisTimeMs + 2999)).toBe(2)
    expect(quicknetRoundAtOrAfter(QUICKNET.genesisTimeMs + 3000)).toBe(2)
    expect(quicknetRoundAtOrAfter(QUICKNET.genesisTimeMs + 3001)).toBe(3)
    expect(quicknetRoundTimeMs(3)).toBe(QUICKNET.genesisTimeMs + 6000)
  })

  it('rejects invalid rounds, times before genesis, and unsafe ranges', () => {
    for (const round of [0, 1.5, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(() => quicknetRoundTimeMs(round)).toThrow()
    }
    for (const time of [QUICKNET.genesisTimeMs - 1, NaN, Number.MAX_SAFE_INTEGER]) {
      expect(() => quicknetRoundAtOrAfter(time)).toThrow()
    }
  })
})

describe('v1 32-pick-7 draw', () => {
  it('reproduces the independently calculated Quicknet round 1 vector', () => {
    expect(DRAW_ALGORITHM_VERSION).toBe('sha256-fy32-v1')
    expect(deriveDraw(itemIds, roundOneRandomness)).toEqual([1, 6, 15, 22, 29, 30, 32])
  })

  it('rejects out-of-range bytes before taking the modulo; leaves the snapshot untouched', () => {
    // The reference sampler rejects bytes 235, 255, and 246 for this test seed.
    const reversed = Object.freeze(itemIds.slice().reverse())
    const seed = '2b'.padStart(64, '0')
    expect(deriveDraw(reversed, seed)).toEqual([5, 7, 12, 14, 20, 21, 24])
    expect(reversed[0]).toBe(32)
  })

  it('rejects malformed randomness, sparse, repeated, and invalid item IDs', () => {
    for (const seed of ['', roundOneRandomness + '\n', 'z'.repeat(64), 'A'.repeat(64)]) {
      expect(() => deriveDraw(itemIds, seed)).toThrow()
    }
    for (const ids of [itemIds.slice(1), Array(32), itemIds.map(() => 1), [0, ...itemIds.slice(1)]]) {
      expect(() => deriveDraw(ids, roundOneRandomness)).toThrow()
    }
  })
})

const first = { receiptId: '1'.repeat(32), stakeUnits: 1000, itemIds: [25, 2, 1, 7, 16, 13, 12] }
const second = { receiptId: 'a'.repeat(32), stakeUnits: 12345, itemIds: [11, 2, 3, 4, 6, 9, 8] }
const proofInput = { roundId: 123, itemIds, bets: [first, second] }

describe('anonymous bets commitment', () => {
  it('matches canonical JSON and a separately calculated SHA-256 golden vector', () => {
    const ordered = buildAnonymousProof(proofInput)
    expect(ordered.canonicalJson).toBe(
      '{"version":"LuckyAPI/32pick7/anonymous-bets/v1","roundId":123,"itemIds":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32],"bets":[{"receiptId":"11111111111111111111111111111111","itemIds":[1,2,7,12,13,16,25],"stakeUnits":1000},{"receiptId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","itemIds":[2,3,4,6,8,9,11],"stakeUnits":12345}]}',
    )
    expect(ordered.commitmentHex).toBe('5b0631e80442b0f080c361c6d1b907b910065b71cbf4c542c783ee05382ae682')
    const rawBet = { ...first, itemIds: first.itemIds.slice().reverse(), userId: 17, betId: 99, placedAt: 42 }
    expect(buildAnonymousProof({ ...proofInput, itemIds: itemIds.slice().reverse(), bets: [second, rawBet] })).toEqual(ordered)
  })

  it('binds round identity and stake, and handles no wagers', () => {
    const digest = buildAnonymousProof(proofInput).commitmentHex
    expect(buildAnonymousProof({ ...proofInput, roundId: 124 }).commitmentHex).not.toBe(digest)
    expect(buildAnonymousProof({ ...proofInput, bets: [{ ...first, stakeUnits: 1001 }, second] }).commitmentHex).not.toBe(digest)
    expect(buildAnonymousProof({ ...proofInput, bets: [] }).commitmentHex).toBe('eaf864ac268b075a4a508a7e5076dd6cc4f2c49a092a8fdf25b0d021a3750f29')
  })

  it('rejects ambiguous receipts, invalid units and picks outside of the snapshot', () => {
    expect(() => buildAnonymousProof({ ...proofInput, bets: [first, first] })).toThrow(/Receipt/)
    for (const receiptId of ['user-17', 'A'.repeat(32)]) {
      expect(() => buildAnonymousProof({ ...proofInput, bets: [{ ...first, receiptId }] })).toThrow(/Receipt/)
    }
    for (const stakeUnits of [0, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => buildAnonymousProof({ ...proofInput, bets: [{ ...first, stakeUnits }] })).toThrow(/Stake/)
    }
    expect(() => buildAnonymousProof({ ...proofInput, bets: [{ ...first, itemIds: [1, 2, 3, 4, 5, 6, 33] }] })).toThrow(/snapshot/)
    expect(() => buildAnonymousProof({ ...proofInput, bets: [{ ...first, itemIds: [1, 2, 3, 4, 5, 6, 6] }] })).toThrow(/unique/)
  })
})
