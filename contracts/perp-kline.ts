export const PERP_KLINE_INTERVALS = [1, 3, 5, 15] as const;
export type PerpKlineInterval = (typeof PERP_KLINE_INTERVALS)[number];
export const DEFAULT_PERP_KLINE_INTERVAL: PerpKlineInterval = 1;
