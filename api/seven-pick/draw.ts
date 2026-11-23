import { createHash } from 'node:crypto'

export const DRAW_ALGORITHM_VERSION = 'sha256-fy32-v1'

const DRAW_DOMAIN = Buffer.from('LuckyAPI/32pick7/draw/sha256-fy32-v1\0', 'ascii')
const ITEM_COUNT = 32
const PICK_COUNT = 7

export function canonicalItemIds(itemIds: readonly number[], count: number): number[] {
  if (!Array.isArray(itemIds) || itemIds.length !== count) {
    throw new Error(`Expected exactly ${count} item IDs`)
  }
  const copy = Array.from(itemIds)
  if (copy.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(copy).size !== count) {
    throw new Error('Item IDs must be unique positive safe integers')
  }
  return copy.sort((a, b) => a - b)
}

/**
 * Only call with the randomness derived from a verified, pre-bound Quicknet signature.
 * V1 stream: SHA256(domain || 32 raw randomness bytes || u32be(counter)), counter from 0.
 * Consume the digest bytes from left to right across swaps, discarding out-of-range bytes.
 * Starting with numeric ascending IDs, do the first seven forward Fisher–Yates swaps.
 * Publish the selected set in numeric ascending order, not in swap order.
 */
export function deriveDraw(itemIds: readonly number[], verifiedRandomnessHex: string): number[] {
  const items = canonicalItemIds(itemIds, ITEM_COUNT)
  if (typeof verifiedRandomnessHex !== 'string' || verifiedRandomnessHex.length !== 64 || /[^0-9a-f]/.test(verifiedRandomnessHex)) {
    throw new Error('Expected 32 bytes of verified Quicknet randomness in lowercase hex')
  }
  const randomness = Buffer.from(verifiedRandomnessHex, 'hex')
  const counterBytes = Buffer.alloc(4)
  let counter = 0
  let block = Buffer.alloc(0)
  let offset = 0

  function nextByte(): number {
    if (offset === block.length) {
      // A counter overflow must fail, not silently reuse old stream bytes.
      counterBytes.writeUInt32BE(counter++)
      block = createHash('sha256').update(DRAW_DOMAIN).update(randomness).update(counterBytes).digest()
      offset = 0
    }
    return block[offset++]
  }

  for (let i = 0; i < PICK_COUNT; i++) {
    const remaining = ITEM_COUNT - i
    const limit = 256 - (256 % remaining)
    let byte = nextByte()
    while (byte >= limit) byte = nextByte()
    const j = i + (byte % remaining)
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items.slice(0, PICK_COUNT).sort((a, b) => a - b)
}
