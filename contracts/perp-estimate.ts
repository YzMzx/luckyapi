// Indicative only. The execution engine checks the accepted quote, collateral and limits again.
// Quantities are 1e-8 coins; prices, cash, notional and fees are 1e-3 simulated USDT.
const SCALE = 100_000_000n,
  BPS = 10_000n,
  SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
const safe = (n: number, min = 0) => Number.isSafeInteger(n) && n >= min;
const min = (a: bigint, b: bigint) => (a < b ? a : b);

export type EstimatePriceInput = {
  orderType: "market" | "limit" | "conditionalMarket" | "conditionalLimit";
  action: "openLong" | "openShort" | "close";
  positionSide?: "long" | "short";
  bidUnits?: number | null;
  askUnits?: number | null;
  limitPriceUnits?: number | null;
  triggerPriceUnits?: number | null;
};
/** A conditional-market trigger is a mark price, NOT a promised executable quote. */
export function estimateReferencePrice(c: EstimatePriceInput): number | null {
  if (c.action === "close" && !c.positionSide) return null;
  const conditional =
    c.orderType === "conditionalLimit" || c.orderType === "conditionalMarket";
  if (conditional && !safe(c.triggerPriceUnits ?? 0, 1)) return null;
  let selected: number | null | undefined;
  switch (c.orderType) {
    case "limit":
    case "conditionalLimit":
      selected = c.limitPriceUnits;
      break;
    case "conditionalMarket":
      selected = c.triggerPriceUnits;
      break;
    case "market":
      if (
        !safe(c.askUnits ?? 0, 1) ||
        !safe(c.bidUnits ?? 0, 1) ||
        c.bidUnits! > c.askUnits!
      )
        return null;
      selected =
        c.action === "openLong" ||
        (c.action === "close" && c.positionSide === "short")
          ? c.askUnits
          : c.bidUnits;
      break;
    default:
      return null;
  }
  return typeof selected === "number" && safe(selected, 1) ? selected : null;
}

export type EstimateInput = {
  action: "openLong" | "openShort" | "close";
  priceUnits: number;
  leverage: number;
  availableCashUnits: number;
  qtyStepAtoms: number;
  minQtyAtoms: number;
  maxQtyAtoms: number;
  minNotionalUnits: number;
  takerFeeBps: number;
  maintenanceMarginBps: number;
  /** Remaining account/platform notional allowance, after existing positions. */
  notionalHeadroomUnits?: number;
  /** If a per-symbol cap applies, include the current position in its consumption. */
  symbolNotionalLimitUnits?: number;
  availableCloseAtoms?: number;
  position?: {
    side: "long" | "short";
    leverage: number;
    quantityAtoms: number;
    entryNotionalUnits: number;
    marginUnits: number;
  };
};
export type EstimateResult = {
  quantityAtoms: number;
  notionalUnits: number;
  marginUnits: number;
  feeUnits: number;
  costUnits: number;
  /** Estimated post-fill position. No liquidation price for a fully closed or fully collateralized position. */
  liquidationPriceUnits: number | null;
  close: {
    releasedMarginUnits: number;
    netPnlUnits: number;
    payoutUnits: number;
  } | null;
};
function valid(c: EstimateInput) {
  const p = c.position;
  if (
    !safe(c.priceUnits, 1) ||
    !safe(c.availableCashUnits) ||
    !safe(c.qtyStepAtoms, 1) ||
    !safe(c.minQtyAtoms, 1) ||
    !safe(c.maxQtyAtoms, 1) ||
    !safe(c.minNotionalUnits) ||
    !safe(c.takerFeeBps) ||
    c.takerFeeBps > 10000 ||
    !safe(c.maintenanceMarginBps) ||
    c.maintenanceMarginBps >= 10000 ||
    !safe(c.leverage, 1)
  )
    return false;
  if (
    (c.notionalHeadroomUnits !== undefined && !safe(c.notionalHeadroomUnits)) ||
    (c.symbolNotionalLimitUnits !== undefined &&
      !safe(c.symbolNotionalLimitUnits)) ||
    (c.availableCloseAtoms !== undefined && !safe(c.availableCloseAtoms))
  )
    return false;
  if (
    p &&
    (!safe(p.quantityAtoms, 1) ||
      !safe(p.entryNotionalUnits, 1) ||
      !safe(p.marginUnits) ||
      !safe(p.leverage, 1))
  )
    return false;
  return c.action === "close"
    ? !!p
    : !p ||
        (p.leverage === c.leverage &&
          (c.action === "openLong") === (p.side === "long"));
}
function amounts(c: EstimateInput, qty: bigint, filledNotional?: number) {
  const notional =
    filledNotional === undefined
      ? (qty * BigInt(c.priceUnits)) / SCALE
      : BigInt(filledNotional);
  const fee = ceil(notional * BigInt(c.takerFeeBps), BPS);
  const margin = c.action === "close" ? 0n : ceil(notional, BigInt(c.leverage));
  return { notional, fee, margin, cost: margin + fee };
}
function liquidation(
  long: boolean,
  qty: bigint,
  entry: bigint,
  margin: bigint,
  mm: bigint
) {
  const base = long ? entry - margin : entry + margin;
  if (!qty || base <= 0n) return null;
  const units = (base * SCALE * BPS) / (qty * (long ? BPS - mm : BPS + mm));
  return units > 0n && units <= SAFE ? Number(units) : null;
}
export function maxOrderQuantity(c: EstimateInput): number {
  if (!valid(c)) return 0;
  const step = BigInt(c.qtyStepAtoms);
  if (c.action === "close")
    return Number(
      (BigInt(
        Math.min(
          c.maxQtyAtoms,
          c.position!.quantityAtoms,
          c.availableCloseAtoms ?? Number.MAX_SAFE_INTEGER
        )
      ) /
        step) *
        step
    );
  const cash = BigInt(c.availableCashUnits),
    remaining = min(
      BigInt(c.notionalHeadroomUnits ?? Number.MAX_SAFE_INTEGER),
      BigInt(c.symbolNotionalLimitUnits ?? Number.MAX_SAFE_INTEGER) -
        BigInt(c.position?.entryNotionalUnits ?? 0)
    );
  let lo = 0n,
    hi =
      min(
        BigInt(c.maxQtyAtoms),
        SAFE - BigInt(c.position?.quantityAtoms ?? 0)
      ) / step;
  // Search in lots. The fee and margin have *separate* ceiling operations; a simple
  // division by price * (1/leverage + feeRate) can overstate affordable quantity.
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const a = amounts(c, mid * step);
    if (
      a.cost <= cash &&
      a.notional <= remaining &&
      a.notional <= SAFE - BigInt(c.position?.entryNotionalUnits ?? 0)
    )
      lo = mid;
    else hi = mid - 1n;
  }
  const qty = lo * step;
  return qty >= BigInt(c.minQtyAtoms) &&
    amounts(c, qty).notional >= BigInt(Math.max(1, c.minNotionalUnits))
    ? Number(qty)
    : 0;
}
export function percentageQuantity(c: EstimateInput, percent: number): number {
  if (
    !safe(percent) ||
    percent > 100 ||
    percent === 0 ||
    !safe(c.qtyStepAtoms, 1)
  )
    return 0;
  const step = BigInt(c.qtyStepAtoms);
  return Number(
    (((BigInt(maxOrderQuantity(c)) / step) * BigInt(percent)) / 100n) * step
  );
}
export function estimateOrder(
  c: EstimateInput,
  quantityAtoms: number,
  filledNotional?: number
): EstimateResult | null {
  if (
    !valid(c) ||
    !safe(quantityAtoms, 1) ||
    quantityAtoms % c.qtyStepAtoms ||
    (filledNotional === undefined
      ? quantityAtoms > maxOrderQuantity(c)
      : !safe(filledNotional, 1)) ||
    quantityAtoms > c.maxQtyAtoms ||
    (c.action === "close" &&
      quantityAtoms >
        Math.min(
          c.position!.quantityAtoms,
          c.availableCloseAtoms ?? Number.MAX_SAFE_INTEGER
        ))
  )
    return null;
  const qty = BigInt(quantityAtoms),
    a = amounts(c, qty, filledNotional),
    p = c.position;
  if (a.notional > SAFE) return null;
  let remainingQty = BigInt(p?.quantityAtoms ?? 0),
    margin = BigInt(p?.marginUnits ?? 0),
    entry = BigInt(p?.entryNotionalUnits ?? 0),
    fee = a.fee;
  let close: EstimateResult["close"] = null;
  if (c.action === "close") {
    const released = (margin * qty) / remainingQty,
      releasedBasis = (entry * qty) / remainingQty;
    const equity =
      released + (p!.side === "long" ? 1n : -1n) * (a.notional - releasedBasis);
    if (qty < remainingQty && equity <= 0n) return null;
    // Mirror settlement: an isolated position cannot debit the rest of the wallet.
    if (equity > SAFE || equity < -SAFE) return null;
    const availableEquity = equity > 0n ? equity : 0n;
    fee = min(fee, availableEquity);
    const payout = availableEquity - fee;
    close = {
      releasedMarginUnits: Number(released),
      netPnlUnits: Number(payout - released),
      payoutUnits: Number(payout),
    };
    remainingQty -= qty;
    margin -= released;
    entry -= releasedBasis;
  } else {
    if (
      quantityAtoms < c.minQtyAtoms ||
      a.notional < BigInt(Math.max(1, c.minNotionalUnits)) ||
      a.cost > BigInt(c.availableCashUnits) ||
      a.notional > BigInt(c.notionalHeadroomUnits ?? Number.MAX_SAFE_INTEGER) ||
      entry + a.notional >
        BigInt(c.symbolNotionalLimitUnits ?? Number.MAX_SAFE_INTEGER)
    )
      return null;
    remainingQty += qty;
    margin += a.margin;
    entry += a.notional;
  }
  if (
    remainingQty > SAFE ||
    entry > SAFE ||
    margin > SAFE ||
    a.margin + fee > SAFE
  )
    return null;
  return {
    quantityAtoms,
    notionalUnits: Number(a.notional),
    marginUnits: Number(a.margin),
    feeUnits: Number(fee),
    costUnits: Number(a.margin + fee),
    close,
    liquidationPriceUnits: liquidation(
      p ? p.side === "long" : c.action === "openLong",
      remainingQty,
      entry,
      margin,
      BigInt(c.maintenanceMarginBps)
    ),
  };
}
