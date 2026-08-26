export const DEFAULT_REPORT_TAX_BASIS_POINTS = 500;
export const MAX_REPORT_TAX_BASIS_POINTS = 10_000;
export const DEFAULT_REPORT_SUCCESS_BASIS_POINTS = 4_000;
export const MAX_REPORT_SUCCESS_BASIS_POINTS = 10_000;

export function parseReportTaxPercent(value: string): number | null {
  const normalized = value.trim();
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const basisPoints = whole * 100 + Number(fraction || "0");
  return basisPoints <= MAX_REPORT_TAX_BASIS_POINTS ? basisPoints : null;
}

export function formatReportTaxPercent(basisPoints: number): string {
  return (basisPoints / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

/**
 * 举报风险额始终取双方结算前较低余额的一半。余额统一舍入到百万分之一美元，
 * 因此无论最终哪一方输，扣款基数都完全对称且不会因浮点尾差分叉。
 */
export function calculateReportGross(reporterBalanceBefore: number, targetBalanceBefore: number) {
  if (!Number.isFinite(reporterBalanceBefore) || reporterBalanceBefore < 0) throw new Error("invalid reporter balance");
  if (!Number.isFinite(targetBalanceBefore) || targetBalanceBefore < 0) throw new Error("invalid target balance");
  const reporterUnits = BigInt(Math.round(reporterBalanceBefore * 1_000_000));
  const targetUnits = BigInt(Math.round(targetBalanceBefore * 1_000_000));
  const lowerUnits = reporterUnits < targetUnits ? reporterUnits : targetUnits;
  // round6(lowerBalance * 0.5)：整数百万分之一单位上四舍五入。
  const grossUnits = (lowerUnits + 1n) / 2n;
  return {
    reporterBalanceBefore: Number(reporterUnits) / 1_000_000,
    targetBalanceBefore: Number(targetUnits) / 1_000_000,
    lowerBalance: Number(lowerUnits) / 1_000_000,
    grossAmount: Number(grossUnits) / 1_000_000,
  };
}

/**
 * 余额精度统一为百万分之一美元；税额用 BigInt 在整数单位上四舍五入，
 * 避免二进制浮点直接相乘造成税额与净额无法严格相加回税前金额。
 */
export function calculateReportSettlement(grossAmount: number, taxBasisPoints: number) {
  if (!Number.isFinite(grossAmount) || grossAmount < 0) throw new Error("invalid gross amount");
  if (!Number.isInteger(taxBasisPoints) || taxBasisPoints < 0 || taxBasisPoints > MAX_REPORT_TAX_BASIS_POINTS) {
    throw new Error("invalid report tax basis points");
  }
  const grossUnits = BigInt(Math.round(grossAmount * 1_000_000));
  const taxUnits = (grossUnits * BigInt(taxBasisPoints) + 5_000n) / 10_000n;
  const creditedUnits = grossUnits - taxUnits;
  return {
    grossAmount: Number(grossUnits) / 1_000_000,
    taxBasisPoints,
    taxAmount: Number(taxUnits) / 1_000_000,
    creditedAmount: Number(creditedUnits) / 1_000_000,
    deductedAmount: Number(grossUnits) / 1_000_000,
  };
}
