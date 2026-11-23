import type { KLineData } from "klinecharts";
import type { PerpApi } from "./format";

type Bar = PerpApi["market"]["bars"][number];
type Trade = PerpApi["account"]["orders"][number];
const dayMs = 86_400_000;
const shanghaiOffset = 8 * 3_600_000;

/** Candles are grouped by their opening day in Asia/Shanghai. */
export const dayStart = (endAt: number, duration: number) =>
  Math.floor((endAt - duration + shanghaiOffset) / dayMs) * dayMs -
  shanghaiOffset;

export function toChartData(bars: Bar[], duration: number): KLineData[] {
  return bars.map(({ endAt, open, high, low, close, volume }) => ({
    timestamp: endAt - duration,
    open,
    high,
    low,
    close,
    volume,
  }));
}

export function groupCandleTrades(
  trades: Trade[],
  symbol: string,
  duration: number
) {
  const groups = new Map<number, Trade[]>();
  for (const trade of trades) {
    if (trade.symbol !== symbol) continue;
    // A fill exactly at the boundary belongs to the newly opened candle.
    const start = Math.floor(trade.createdAt / duration) * duration;
    const group = groups.get(start);
    if (group) group.push(trade);
    else groups.set(start, [trade]);
  }
  return groups;
}

/** Only the tail of the library's data can be updated without resetting the view. */
export function incrementalBars(current: KLineData[], next: KLineData[]) {
  if (current.length === 0 || next.length < current.length) return null;
  for (let i = 0; i < current.length; i++) {
    const a = current[i],
      b = next[i];
    if (a.timestamp !== b.timestamp) return null;
    if (i < current.length - 1 && !sameOhlcv(a, b)) return null;
  }
  const tail = current.length - 1;
  return next.slice(sameOhlcv(current[tail], next[tail]) ? tail + 1 : tail);
}

function sameOhlcv(a: KLineData, b: KLineData) {
  return (
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume
  );
}

export const changePercent = (open: number, close: number) =>
  open > 0 ? ((close - open) / open) * 100 : 0;
