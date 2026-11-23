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
  const factor = multipliers.map(BigInt);
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
  // One 7-of-32 outcome can realize each of the 0–7 hit counts against any
  // single distinct bet; otherwise scan every outcome, summing *before* maxing.
  // The common path uses safe integers only, proven by the exact BigInt bound.
  const masks = [...stakeByMask.keys()];
  if (absoluteBound <= MAX_SAFE) {
    const payouts = [...stakeByMask.values()].map(stake =>
      factor.map(x => Number(stake * x))
    );
    let maximum = 0;
    for (const draw of sevenPickDrawMasks()) {
      let total = 0;
      for (let i = 0; i < masks.length; i++)
        total += payouts[i][sevenPickCountBits(draw & masks[i])];
      if (total > maximum) maximum = total;
    }
    return BigInt(maximum);
  }
  const payouts = [...stakeByMask.values()].map(stake =>
    factor.map(x => stake * x)
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
