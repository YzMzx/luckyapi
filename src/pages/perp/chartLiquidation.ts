import type { Chart, OverlayTemplate } from "klinecharts";
import type { PerpApi } from "./format";

export type LiquidationPosition = Pick<
  PerpApi["account"]["positions"][number],
  "symbol" | "liquidationPriceUnits"
>;

export function getLiquidationUnits(
  symbol: string,
  position?: LiquidationPosition
): number | null {
  const units =
    position?.symbol === symbol ? position.liquidationPriceUnits : 0;
  return Number.isFinite(units) && units > 0 ? units : null;
}

export const liquidationLine = {
  name: "luckyPerpLiquidation",
  createPointFigures: ({ coordinates, bounding }) => {
    const y = coordinates[0]?.y;
    // Use the candle pane's existing scale; offscreen levels stay in the legend.
    if (y == null || !Number.isFinite(y) || y < 0 || y > bounding.height)
      return [];
    return {
      type: "line",
      attrs: {
        coordinates: [
          { x: 0, y },
          { x: bounding.width, y },
        ],
      },
      styles: {
        style: "dashed",
        dashedValue: [6, 4],
        color: "#c4b5fd",
        size: 1,
      },
      ignoreEvent: true,
    };
  },
} satisfies OverlayTemplate;

type OverlayChart = Pick<
  Chart,
  "createOverlay" | "getOverlays" | "overrideOverlay" | "removeOverlay"
>;

export function syncLiquidationLine(chart: OverlayChart, units: number | null) {
  const id = liquidationLine.name;
  if (units === null) {
    chart.removeOverlay({ id });
    return;
  }
  // A value-only point needs no time anchor, so it survives date and candle updates.
  const points = [{ value: units / 1_000 }];
  if (chart.getOverlays({ id }).length) {
    chart.overrideOverlay({ id, points });
  } else {
    chart.createOverlay({ name: id, id, lock: true, points });
  }
}
