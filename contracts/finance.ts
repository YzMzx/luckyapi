export const MONEY_SCALE = 1_000_000;
export const TRANSFER_FEE_BASIS_POINTS = 300;
export const INTEREST_TAX_BASIS_POINTS = 1_000;
export const MONTH_MS = 30 * 24 * 60 * 60 * 1_000;

export function unitsFromMoney(value: number) {
  const units = Math.round(value * MONEY_SCALE);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(units) || Math.abs(value * MONEY_SCALE - units) > 1e-6) {
    throw new Error("金额最多支持 6 位小数");
  }
  return units;
}

export function moneyFromUnits(units: number) {
  if (!Number.isSafeInteger(units)) throw new Error("金额单位无效");
  return units / MONEY_SCALE;
}

export function transferFeeUnits(amountUnits: number, basisPoints = TRANSFER_FEE_BASIS_POINTS) {
  if (!Number.isSafeInteger(amountUnits) || amountUnits <= 0) throw new Error("转账金额无效");
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) throw new Error("转账手续费率无效");
  return Number((BigInt(amountUnits) * BigInt(basisPoints) + 9_999n) / 10_000n);
}

/** 月利率按 30 天折算，使用实际经过毫秒，向下取到 0.000001。 */
export function accruedInterestUnits(input: {
  principalUnits: number;
  monthlyRateBasisPoints: number;
  acceptedAtMs: number;
  settlementAtMs: number;
  dueAtMs: number;
}) {
  const elapsedMs = Math.max(0, Math.min(input.settlementAtMs, input.dueAtMs) - input.acceptedAtMs);
  if (elapsedMs <= 0 || input.monthlyRateBasisPoints <= 0) return 0;
  const numerator = BigInt(input.principalUnits) * BigInt(input.monthlyRateBasisPoints) * BigInt(elapsedMs);
  const denominator = 10_000n * BigInt(MONTH_MS);
  return Number(numerator / denominator);
}

export function interestTaxUnits(grossInterestUnits: number, basisPoints = INTEREST_TAX_BASIS_POINTS) {
  if (!Number.isSafeInteger(grossInterestUnits) || grossInterestUnits < 0) throw new Error("利息无效");
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) throw new Error("利息税率无效");
  return Number((BigInt(grossInterestUnits) * BigInt(basisPoints)) / 10_000n);
}

export function allocateLoanCollection(input: {
  availableUnits: number;
  outstandingPrincipalUnits: number;
  outstandingInterestUnits: number;
  interestTaxBasisPoints?: number;
}) {
  const totalOutstanding = input.outstandingPrincipalUnits + input.outstandingInterestUnits;
  const collectedUnits = Math.max(0, Math.min(input.availableUnits, totalOutstanding));
  const principalUnits = Math.min(collectedUnits, input.outstandingPrincipalUnits);
  const interestUnits = collectedUnits - principalUnits;
  const taxUnits = interestTaxUnits(interestUnits, input.interestTaxBasisPoints);
  return {
    collectedUnits,
    principalUnits,
    interestUnits,
    taxUnits,
    lenderCreditUnits: principalUnits + interestUnits - taxUnits,
    remainingPrincipalUnits: input.outstandingPrincipalUnits - principalUnits,
    remainingInterestUnits: input.outstandingInterestUnits - interestUnits,
  };
}
