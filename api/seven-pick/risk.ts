import { SEVEN_PICK_ITEMS, SEVEN_PICK_SIZE } from "./config";

export const SEVEN_PICK_DRAW_COUNT = 3_365_856; // C(32, 7)
const MASK_LIMIT = 2 ** SEVEN_PICK_ITEMS;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function sevenPickCountBits(mask: number) {
  mask -= (mask >>> 1) & 0x5555_5555;
  mask = (mask & 0x3333_3333) + ((mask >>> 2) & 0x3333_3333);
  return Math.imul((mask + (mask >>> 4)) & 0x0f0f_0f0f, 0x0101_0101) >>> 24;
}

export function sevenPickItemMask(itemIds: readonly number[]) {
  if (itemIds.length !== SEVEN_PICK_SIZE)
    throw new RangeError("每组必须选择 7 个物品");
  let mask = 0;
  for (const id of itemIds) {
    if (!Number.isInteger(id) || id < 1 || id > SEVEN_PICK_ITEMS)
      throw new RangeError("物品 ID 无效");
    const bit = 1 << (id - 1);
    if ((mask & bit) !== 0) throw new RangeError("同组物品不能重复");
    mask |= bit;
  }
  return mask >>> 0;
}

export function* sevenPickDrawMasks(): Generator<number> {
  let mask = (1 << SEVEN_PICK_SIZE) - 1;
  while (mask < MASK_LIMIT) {
    yield mask;
    // Gosper's hack, with unsigned 32-bit masks and exact Number arithmetic.
    const lowestBit = (mask & -mask) >>> 0;
    const carry = mask + lowestBit;
    if (carry >= MASK_LIMIT) return;
    mask = carry + Math.floor(((carry ^ mask) >>> 0) / lowestBit / 4);
  }
}

export type SevenPickRiskBet = { itemMask: number; stakeUnits: number };

// Each size has its own colexicographic order: the subsets whose greatest
// item is x occupy a contiguous block starting at binomial(x, size).
const BINOMIAL = Array.from({ length: SEVEN_PICK_ITEMS + 1 }, (_, n) => {
  const row = new Int32Array(SEVEN_PICK_SIZE + 1);
  row[0] = 1;
  for (let k = 1; k <= Math.min(n, SEVEN_PICK_SIZE); k++)
    row[k] = (row[k - 1] * (n - k + 1)) / k;
  return row;
});
const LEVEL_COUNT = SEVEN_PICK_SIZE + 1;
const LEVEL_STARTS = new Int32Array(LEVEL_COUNT + 1);
for (let size = 0; size < LEVEL_COUNT; size++)
  LEVEL_STARTS[size + 1] =
    LEVEL_STARTS[size] + BINOMIAL[SEVEN_PICK_ITEMS][size];

function mobiusCoefficients(factors: readonly bigint[]) {
  const differences = [...factors];
  const coefficients = [differences[0]];
  for (let order = 1; order < LEVEL_COUNT; order++) {
    for (let i = 0; i < LEVEL_COUNT - order; i++)
      differences[i] = differences[i + 1] - differences[i];
    coefficients.push(differences[0]);
  }
  return coefficients;
}

function forEachTicketSubset(
  stakes: ReadonlyMap<number, bigint>,
  addTicket: (stake: bigint, ranks: Int32Array, sizes: Uint8Array) => void
) {
  const ranks = new Int32Array(1 << SEVEN_PICK_SIZE);
  const sizes = new Uint8Array(ranks.length);
  for (const [mask, stake] of stakes) {
    let subsetCount = 1;
    let remaining = mask;
    while (remaining) {
      const item = SEVEN_PICK_ITEMS - 1 - Math.clz32(remaining & -remaining);
      const row = BINOMIAL[item];
      remaining &= remaining - 1;
      for (let i = 0; i < subsetCount; i++) {
        const size = sizes[i] + 1;
        sizes[subsetCount + i] = size;
        ranks[subsetCount + i] = ranks[i] + row[size];
      }
      subsetCount *= 2;
    }
    addTicket(stake, ranks, sizes);
  }
}

type AddBlock = (
  source: number,
  dest: number,
  count: number,
  sourceStride: 0 | 1
) => void;

// In-place subset zeta transform. For each greatest item, first sum the
// subsets that keep that item within its block, then add the subsets that
// omit it from the already transformed prefix. Each term is added once.
function sumSubsets(add: AddBlock) {
  const offsets = new Int32Array(LEVEL_COUNT * SEVEN_PICK_SIZE);
  offsets.set(LEVEL_STARTS.subarray(0, LEVEL_COUNT));

  function transform(level: number, n: number, k: number) {
    if (k === 1) {
      add(offsets[level], offsets[level + 1], n, 0);
      return;
    }
    const child = level + LEVEL_COUNT;
    for (let item = 0; item < n; item++) {
      const row = BINOMIAL[item];
      const maxSize = Math.min(k - 1, item);
      for (let size = 0; size <= maxSize; size++)
        offsets[child + size] = offsets[level + size + 1] + row[size + 1];
      if (maxSize > 0) transform(child, item, maxSize);
      for (let size = 0; size <= maxSize; size++)
        add(offsets[level + size], offsets[child + size], row[size], 1);
    }
  }

  transform(0, SEVEN_PICK_ITEMS, SEVEN_PICK_SIZE);
}

function maxExposureBySubsets(
  stakes: ReadonlyMap<number, bigint>,
  coefficients: readonly bigint[]
) {
  const values = new Float64Array(LEVEL_STARTS[LEVEL_COUNT]);
  forEachTicketSubset(stakes, (stake, ranks, sizes) => {
    const weights = coefficients.map(c => Number(c * stake));
    for (let i = 0; i < ranks.length; i++) {
      const size = sizes[i];
      values[LEVEL_STARTS[size] + ranks[i]] += weights[size];
    }
  });
  sumSubsets((source, dest, count, stride) => {
    if (stride === 0 && values[source] === 0) return;
    const end = dest + count;
    while (dest < end) {
      values[dest++] += values[source];
      source += stride;
    }
  });
  let maximum = 0;
  for (let i = LEVEL_STARTS[SEVEN_PICK_SIZE]; i < values.length; i++)
    if (values[i] > maximum) maximum = values[i];
  return BigInt(maximum);
}

function maxExposureByUnsignedSubsets(
  stakes: ReadonlyMap<number, bigint>,
  coefficients: readonly bigint[]
) {
  // BigUint64Array reduces every store modulo 2^64. Negative coefficients and
  // wrapped intermediate sums preserve the result modulo 2^64. The caller
  // bounds every final payout to [0, 2^64), where its residue is exact.
  const values = new BigUint64Array(LEVEL_STARTS[LEVEL_COUNT]);
  forEachTicketSubset(stakes, (stake, ranks, sizes) => {
    const weights = coefficients.map(c => c * stake);
    for (let i = 0; i < ranks.length; i++) {
      const size = sizes[i];
      values[LEVEL_STARTS[size] + ranks[i]] += weights[size];
    }
  });
  sumSubsets((source, dest, count, stride) => {
    if (stride === 0 && values[source] === 0n) return;
    const end = dest + count;
    while (dest < end) {
      values[dest++] += values[source];
      source += stride;
    }
  });
  let maximum = 0n;
  for (let i = LEVEL_STARTS[SEVEN_PICK_SIZE]; i < values.length; i++) {
    const payout = values[i];
    if (payout > maximum) maximum = payout;
  }
  return maximum;
}

function maxExposureForPair(
  stakes: ReadonlyMap<number, bigint>,
  factors: readonly bigint[]
) {
  const [[firstMask, firstStake], [secondMask, secondStake]] = stakes;
  const shared = sevenPickCountBits(firstMask & secondMask);
  const unique = SEVEN_PICK_SIZE - shared;
  const firstPayouts = factors.map(factor => factor * firstStake);
  const secondPayouts = factors.map(factor => factor * secondStake);
  let maximum = 0n;
  // A pair covers at most 14 items, so any legal hit counts can be completed
  // to a seven-item draw using items that are on neither ticket.
  for (let common = 0; common <= shared; common++) {
    for (let first = 0; first <= unique; first++) {
      const maxSecond = Math.min(unique, SEVEN_PICK_SIZE - common - first);
      for (let second = 0; second <= maxSecond; second++) {
        const payout =
          firstPayouts[common + first] + secondPayouts[common + second];
        if (payout > maximum) maximum = payout;
      }
    }
  }
  return maximum;
}

function maxExposureByIntersections(
  stakes: ReadonlyMap<number, bigint>,
  factors: readonly bigint[]
) {
  const masks = [...stakes.keys()];
  const payouts = [...stakes.values()].map(stake =>
    factors.map(x => stake * x)
  );
  let maximum = 0n;
  for (const draw of sevenPickDrawMasks()) {
    let total = 0n;
    for (let i = 0; i < masks.length; i++)
      total += payouts[i][sevenPickCountBits(draw & masks[i])];
    if (total > maximum) maximum = total;
  }
  return maximum;
}

export function calculateSevenPickMaxExposure(
  bets: Iterable<SevenPickRiskBet>,
  multipliers: readonly number[]
): bigint {
  if (
    multipliers.length !== SEVEN_PICK_SIZE + 1 ||
    !Array.from(multipliers).every(x => Number.isSafeInteger(x) && x >= 0)
  ) {
    throw new RangeError("无效倍率");
  }
  const factors = multipliers.map(BigInt);
  const maxFactor = BigInt(Math.max(...multipliers));
  const stakeByMask = new Map<number, bigint>();
  let totalStakes = 0n;
  for (const { itemMask, stakeUnits } of bets) {
    if (
      !Number.isInteger(itemMask) ||
      itemMask <= 0 ||
      itemMask >= MASK_LIMIT ||
      sevenPickCountBits(itemMask) !== SEVEN_PICK_SIZE ||
      !Number.isSafeInteger(stakeUnits) ||
      stakeUnits <= 0
    ) {
      throw new RangeError("无效投注风险数据");
    }
    const stake = BigInt(stakeUnits);
    totalStakes += stake;
    stakeByMask.set(itemMask, (stakeByMask.get(itemMask) ?? 0n) + stake);
  }
  const absoluteBound = totalStakes * maxFactor;
  if (absoluteBound === 0n || stakeByMask.size === 1) return absoluteBound;
  if (stakeByMask.size === 2) return maxExposureForPair(stakeByMask, factors);

  // f(h) = sum_j C(h,j)*c[j]. A ticket therefore contributes stake*c[j]
  // to each of its j-item subsets, which the zeta transform sums per draw.
  const coefficients = mobiusCoefficients(factors);
  const termBound = coefficients.reduce(
    (sum, c, j) =>
      sum + BigInt(BINOMIAL[SEVEN_PICK_SIZE][j]) * (c < 0n ? -c : c),
    0n
  );
  // Bound absolute intermediate sums, including negative coefficients which
  // can cancel later. Every subset update uses a disjoint set of original terms.
  if (totalStakes * termBound <= MAX_SAFE)
    return maxExposureBySubsets(stakeByMask, coefficients);
  if (absoluteBound < 1n << 64n)
    return maxExposureByUnsignedSubsets(stakeByMask, coefficients);
  return maxExposureByIntersections(stakeByMask, factors);
}
