import { expect, it } from "vitest";
import {
  chart,
  candleEnd,
  timeScale,
  dayStart,
  priceScale,
  changePercent,
} from "./chartScale";
const start = Date.parse("2026-11-22T00:00:00+08:00"),
  dayMs = 86400000;
it.each([1, 3, 5, 15])(
  "assigns fills to half-open %i-minute intervals across midnight",
  minutes => {
    const d = minutes * 60000;
    const midnight = start + dayMs;
    expect(candleEnd(midnight - 1, d)).toBe(midnight);
    expect(dayStart(midnight, d)).toBe(start);
    expect(candleEnd(midnight, d)).toBe(midnight + d);
    expect(dayStart(midnight + d, d)).toBe(midnight);
  }
);
it.each([1, 3, 5, 15])(
  "limits the %i-minute axis to the actual window, with matching price and volume hit targets",
  minutes => {
    const d = minutes * 60000;
    const first = start + 12 * 3600000 + d;
    const axis = timeScale(first, first + 9 * d, d, 640);
    expect(axis.width).toBe(640);
    expect(axis.ticks[0]).toBe(first);
    for (let i = 0; i < 10; i++) {
      const end = first + i * d;
      for (const y of [chart.top, 100, chart.volumeBottom])
        expect(axis.endAtPoint(axis.x(end), y)).toBe(end);
    }
    expect(
      axis.endAtPoint(axis.x(first) - axis.cell / 2 - 0.1, 100)
    ).toBeNull();
    expect(
      axis.endAtPoint(axis.x(first) + 9.5 * axis.cell + 0.1, 100)
    ).toBeNull();
    expect(axis.endAtPoint(axis.x(first), 275)).toBeNull();
  }
);
it("leaves missing time slots between sparse bars and keeps dense one-minute bars readable", () => {
  const first = start + 60000,
    last = first + 198 * 60000,
    axis = timeScale(first, last, 60000, 480);
  const available = new Set([first, last]);
  expect(axis.cell).toBeGreaterThanOrEqual(12);
  expect(axis.endAtPoint(axis.x(first) + axis.cell, 60)).toBe(first + 60000);
  expect(available.has(axis.endAtPoint(axis.x(first) + axis.cell, 60)!)).toBe(
    false
  );
  expect(axis.x(last) - axis.x(first)).toBe(axis.cell * 198);
  const single = timeScale(first, first, 60000, 480);
  expect(single.ticks).toEqual([first]);
  expect(single.endAtPoint(single.x(first), 100)).toBe(first);
});
it("maps price crosshairs accurately for flat and low-price contracts without measuring volume as price", () => {
  for (const [low, high] of [
    [0.001, 0.001],
    [12.113, 12.115],
    [60000, 67500],
  ]) {
    const s = priceScale(low, high);
    for (const p of [low, high]) expect(s.priceAt(s.y(p))).toBeCloseTo(p, 8);
    expect(s.priceAt(220)).toBeNull();
  }
  expect(changePercent(10, 11)).toBe(10);
  expect(changePercent(10, 9)).toBe(-10);
  expect(changePercent(10, 10)).toBe(0);
});
