export const PERP_LEVERAGE_MIN = 1;
export const PERP_LEVERAGE_MAX = 100;
export const DEFAULT_PERP_MIN_LEVERAGE = 1;
export const DEFAULT_PERP_MAX_LEVERAGE = 5;

export type PerpLeverageRange = { minLeverage: number; maxLeverage: number };

/** The SIM range is global; the instrument can impose a lower maximum. */
export function getPerpLeverageRange(
  config: PerpLeverageRange,
  instrumentMax?: number
) {
  return {
    min: config.minLeverage,
    max: Math.min(config.maxLeverage, instrumentMax ?? config.maxLeverage),
  };
}

export function isValidPerpLeverage(value: number) {
  return (
    Number.isInteger(value) &&
    value >= PERP_LEVERAGE_MIN &&
    value <= PERP_LEVERAGE_MAX
  );
}
