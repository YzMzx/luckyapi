const dayMs = 86_400_000;
const shanghaiOffset = 8 * 3_600_000;
export const chart = { top: 27, bottom: 169, volumeBottom: 253 } as const;

/** Return the candle containing an event. Execution at an exact boundary belongs to the next candle. */
export const candleEnd = (at: number, duration: number) =>
  (Math.floor(at / duration) + 1) * duration;
/** Candles are grouped by their opening date in Asia/Shanghai, even when they close at midnight. */
export const dayStart = (endAt: number, duration: number) =>
  Math.floor((endAt - duration + shanghaiOffset) / dayMs) * dayMs -
  shanghaiOffset;

/** Lay out the visible day's observed time span, not a fixed number of bars or a full 24h axis. */
export function timeScale(
  firstEnd: number,
  lastEnd: number,
  duration: number,
  viewportWidth = 640
) {
  const slots = (lastEnd - firstEnd) / duration + 1;
  const left = 80,
    right = 22,
    minCell = 12;
  const width = Math.max(viewportWidth, left + right + slots * minCell);
  const cell = (width - left - right) / slots;
  const x = (endAt: number) =>
    left + ((endAt - firstEnd) / duration + 0.5) * cell;
  const endAtPoint = (px: number, py: number) => {
    const i = Math.floor((px - left) / cell);
    return Number.isFinite(i) &&
      i >= 0 &&
      i < slots &&
      py >= chart.top &&
      py <= chart.volumeBottom
      ? firstEnd + i * duration
      : null;
  };
  const ticks: number[] = [];
  const stride = Math.max(1, Math.ceil(78 / cell));
  for (let i = 0; i < slots; i += stride) ticks.push(firstEnd + i * duration);
  return { width, cell, x, endAtPoint, ticks };
}
export function priceScale(low: number, high: number) {
  const pad = Math.max((high - low) * 0.12, 0.001);
  const floor = Math.max(0, low - pad),
    ceiling = high + pad;
  const span = chart.bottom - chart.top;
  return {
    y: (price: number) =>
      chart.bottom - ((price - floor) * span) / (ceiling - floor),
    priceAt: (y: number) =>
      y < chart.top || y > chart.bottom
        ? null
        : floor + ((chart.bottom - y) * (ceiling - floor)) / span,
  };
}
export const changePercent = (open: number, close: number) =>
  open > 0 ? ((close - open) / open) * 100 : 0;
