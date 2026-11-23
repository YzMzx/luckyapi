import { createHash } from 'node:crypto'
import { canonicalItemIds } from './draw'

export const ANONYMOUS_PROOF_VERSION = 'LuckyAPI/32pick7/anonymous-bets/v1'

export type AnonymousBetInput = {
  /** Independently generated 128 random bits per bet; never a user or internal order ID. */
  receiptId: string
  itemIds: readonly number[]
  stakeUnits: number
}

export type AnonymousProofInput = {
  roundId: number
  itemIds: readonly number[]
  bets: readonly AnonymousBetInput[]
}

/**
 * V1 is plain UTF-8 JSON, no BOM, whitespace, or trailing newline. Object keys are
 * emitted in the literal order below, numbers are positive safe integer decimals,
 * item IDs sort numerically, and bets sort lexically by fixed lowercase hex receipt ID.
 * The SHA-256 is over exactly these bytes; timestamp this file's digest, not the hex text.
 * This is a commitment, not an OTS attestation or a claim about when the bytes existed.
 */
export function buildAnonymousProof(input: AnonymousProofInput) {
  const { roundId } = input
  if (!Number.isSafeInteger(roundId) || roundId <= 0) {
    throw new Error('Round ID must be a positive safe integer')
  }
  const itemIds = canonicalItemIds(input.itemIds, 32)
  if (!Array.isArray(input.bets)) throw new Error('Expected a list of anonymous bets')
  const ids = new Set(itemIds)
  const seen = new Set<string>()
  const bets = Array.from(input.bets as readonly AnonymousBetInput[], ({ receiptId, itemIds, stakeUnits }) => {
    if (typeof receiptId !== 'string' || receiptId.length !== 32 || /[^0-9a-f]/.test(receiptId) || seen.has(receiptId)) {
      throw new Error('Receipt IDs must be unique 16-byte lowercase hex strings')
    }
    seen.add(receiptId)
    if (!Number.isSafeInteger(stakeUnits) || stakeUnits <= 0) {
      throw new Error('Stake must be a positive safe integer in milli-USDT units')
    }
    const picks = canonicalItemIds(itemIds, 7)
    if (picks.some(id => !ids.has(id))) throw new Error('Bet item is not in the round snapshot')
    // Whitelist fields; never serialize a raw bet row.
    return { receiptId, itemIds: picks, stakeUnits }
  }).sort((a, b) => a.receiptId < b.receiptId ? -1 : a.receiptId > b.receiptId ? 1 : 0)

  const canonicalJson = JSON.stringify({ version: ANONYMOUS_PROOF_VERSION, roundId, itemIds, bets })
  const commitmentHex = createHash('sha256').update(canonicalJson, 'utf8').digest('hex')
  return { canonicalJson, commitmentHex }
}
