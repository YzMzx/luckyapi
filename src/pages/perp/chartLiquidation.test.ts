import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Chart } from "klinecharts";
import { expect, it, vi } from "vitest";
import {
  getLiquidationUnits,
  liquidationLine,
  syncLiquidationLine,
} from "./chartLiquidation";
import { PerpChart } from "./PerpChart";

const symbol = "BTCUSDT";
const position = (liquidationPriceUnits: number, symbolId = symbol) => ({
  symbol: symbolId,
  liquidationPriceUnits,
});

it("accepts only a finite, positive liquidation price for the plotted symbol", () => {
  expect(getLiquidationUnits(symbol, position(98_125))).toBe(98_125);
  expect(getLiquidationUnits(symbol, position(98_125, "ETHUSDT"))).toBeNull();
  expect(getLiquidationUnits(symbol)).toBeNull();
  for (const invalid of [0, -1, NaN, Infinity, -Infinity]) {
    expect(getLiquidationUnits(symbol, position(invalid))).toBeNull();
  }
});

it("creates, moves and removes one overlay without resetting chart data or fills", () => {
  const id = liquidationLine.name;
  const chart = {
    getOverlays: vi.fn<Chart["getOverlays"]>().mockReturnValue([]),
    createOverlay: vi.fn<Chart["createOverlay"]>(),
    overrideOverlay: vi.fn<Chart["overrideOverlay"]>(),
    removeOverlay: vi.fn<Chart["removeOverlay"]>(),
    resetData: vi.fn(),
  };
  syncLiquidationLine(chart, getLiquidationUnits(symbol, position(98_125)));
  expect(chart.createOverlay).toHaveBeenCalledExactlyOnceWith({
    id,
    name: id,
    lock: true,
    points: [{ value: 98.125 }],
  });
  chart.getOverlays.mockReturnValue([
    { id } as ReturnType<Chart["getOverlays"]>[number],
  ]);
  syncLiquidationLine(chart, getLiquidationUnits(symbol, position(100_000)));
  expect(chart.overrideOverlay).toHaveBeenCalledExactlyOnceWith({
    id,
    points: [{ value: 100 }],
  });
  syncLiquidationLine(chart, getLiquidationUnits(symbol));
  syncLiquidationLine(chart, getLiquidationUnits("ETHUSDT", position(100_000)));
  expect(chart.removeOverlay.mock.calls).toEqual([[{ id }], [{ id }]]);
  expect(chart.getOverlays.mock.calls).toEqual([[{ id }], [{ id }]]);
  expect(chart.resetData).not.toHaveBeenCalled();
});

it("fits the dashed line to the pane and leaves offscreen prices unplotted", () => {
  type Params = Parameters<typeof liquidationLine.createPointFigures>[0];
  const pane = (width: number, y: number) =>
    liquidationLine.createPointFigures({
      coordinates: [{ x: 0, y }],
      bounding: { width, height: 200, left: 0, right: 0, top: 0, bottom: 0 },
    } as Params);
  for (const width of [300, 1_000]) {
    expect(pane(width, 100)).toMatchObject({
      type: "line",
      attrs: {
        coordinates: [
          { x: 0, y: 100 },
          { x: width, y: 100 },
        ],
      },
      styles: { style: "dashed" },
      ignoreEvent: true,
    });
  }
  expect(pane(300, -1)).toEqual([]);
  expect(pane(300, 201)).toEqual([]);
});

it("exposes a visible estimate and trigger explanation as the chart description", () => {
  const market: ComponentProps<typeof PerpChart>["market"] = {
    interval: 1,
    symbol,
    name: "BTC/USDT 永续",
    openEnabled: true,
    tradingEnabled: true,
    source: "mock",
    readOnlyReason: null,
    bars: [
      {
        endAt: 1_795_334_460_000,
        open: 100,
        close: 100,
        high: 101,
        low: 99,
        volume: 10,
        complete: true,
      },
    ],
    instrument: null,
    quote: null,
  };
  const markup = (p?: ReturnType<typeof position>) =>
    renderToStaticMarkup(
      createElement(PerpChart, { market, trades: [], position: p })
    );
  const html = markup(position(98_125));
  const legendId = html.match(
    /<p id="([^"]+)"[^>]*>(?:(?!<\/p>).)*逐仓预估强平价/u
  )?.[1];
  expect(legendId).toBeTruthy();
  expect(html.match(/aria-describedby="([^"]+)"/)?.[1].split(" ")).toContain(
    legendId
  );
  expect(html).toContain(
    "逐仓预估强平价：98.125 USDT · 由标记价触发，不代表成交价"
  );
  expect(markup(position(100_000))).toContain("逐仓预估强平价：100 USDT");
  expect(markup()).not.toContain("逐仓预估强平价");
  expect(markup(position(98_125, "ETHUSDT"))).not.toContain("逐仓预估强平价");
});
