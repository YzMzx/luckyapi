/** All amounts are integer micro-USD. Apply each exchange once, in ledger order. */
export function applyPerpCashFlow(principal: number, direction: "in" | "out", units: number) {
  if (!Number.isSafeInteger(principal) || principal < 0 || !Number.isSafeInteger(units) || units <= 0)
    throw new Error("合约经验本金或兑换金额无效");
  // An outflow uses actual site credit received, after the redemption fee.
  const remaining = direction === "in" ? principal + units : Math.max(0, principal - units);
  if (!Number.isSafeInteger(remaining)) throw new Error("合约经验本金超出范围");
  return { principal: remaining, income: direction === "out" ? Math.max(0, units - principal) : 0 };
}
