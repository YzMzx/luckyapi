import { expect, it } from "vitest";
import {
  changePercent,
  dayStart,
  groupCandleTrades,
  incrementalBars,
  toChartData,
} from "./chartScale";
import type { PerpApi } from "./format";

const midnight = Date.parse("2026-11-23T00:00:00+08:00");
const candle = (endAt: number) => ({
  endAt,
  open: 10,
  high: 11,
  low: 9,
  close: 10.5,
  volume: 2,
  complete: true,
});
const trade = (
  id: number,
  createdAt: number,
  symbol = "BTCUSDT"
): PerpApi["account"]["orders"][number] => ({
  id,
  symbol,
  createdAt,
  action: "openLong",
  side: "long",
  leverage: 1,
  quantityAtoms: 1,
  priceUnits: 10,
  markUnits: 10,
  feeUnits: 0,
  pnlUnits: 0,
});
it.each([1, 3, 5, 15])(
  "aligns %i-minute canvas candles, fill markers and Beijing date boundaries",
  minutes => {
    const duration = minutes * 60000;
    expect(dayStart(midnight, duration)).toBe(midnight - 86_400_000);
    expect(dayStart(midnight + duration, duration)).toBe(midnight);
    const data = toChartData(
      [candle(midnight), candle(midnight + duration)],
      duration
    );
    expect(data.map(bar => bar.timestamp)).toEqual([
      midnight - duration,
      midnight,
    ]);
    expect(data[0]).toMatchObject({
      open: 10,
      high: 11,
      low: 9,
      close: 10.5,
      volume: 2,
    });
    const markers = groupCandleTrades(
      [
        trade(1, midnight - 1),
        trade(2, midnight),
        trade(3, midnight, "ETHUSDT"),
        trade(4, midnight + 1),
      ],
      "BTCUSDT",
      duration
    );
    expect(markers.get(data[0].timestamp)?.map(t => t.id)).toEqual([1]);
    expect(markers.get(data[1].timestamp)?.map(t => t.id)).toEqual([2, 4]);
  }
);
it("updates only the changed tail, with no redraw for identical polling results", () => {
  const d = 60_000;
  const current = toChartData([candle(midnight), candle(midnight + d)], d);
  const next = toChartData(
    [
      candle(midnight),
      { ...candle(midnight + d), close: 11 },
      candle(midnight + 2 * d),
    ],
    d
  );
  expect(incrementalBars(current, [...current])).toEqual([]);
  expect(incrementalBars(current, next)).toEqual(next.slice(1));
  expect(incrementalBars(current, [...current, next[2]])).toEqual([next[2]]);
  expect(incrementalBars(current, next.slice(1))).toBeNull();
  expect(
    incrementalBars(current, [{ ...current[0], volume: 42 }, current[1]])
  ).toBeNull();
  expect(changePercent(10, 11)).toBe(10);
});
