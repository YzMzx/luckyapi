import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  Chart,
  Crosshair,
  KLineData,
  Options,
  OverlayCreate,
} from "klinecharts";
import {
  changePercent,
  dayStart,
  groupCandleTrades,
  incrementalBars,
  toChartData,
} from "./chartScale";
import {
  baseCoin,
  button,
  coin,
  day,
  input,
  orderLabel,
  sim,
  stamp,
  time,
  type PerpApi,
} from "./format";
import { Table } from "./shared";

type Market = PerpApi["market"];
type Bar = Market["bars"][number];
type Trades = PerpApi["account"]["orders"];
const markerName = "luckyPerpFill";
const markerGroup = "luckyPerpFills";
const volumeFormat = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 8,
});
const pctFormat = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
});
const pct = (b: Bar) => pctFormat.format(changePercent(b.open, b.close)) + "%";
const styles: Options["styles"] = {
  grid: { horizontal: { color: "#203248" }, vertical: { color: "#203248" } },
  candle: {
    type: "candle_solid",
    bar: {
      compareRule: "current_open",
      upColor: "#4ade80",
      upBorderColor: "#4ade80",
      upWickColor: "#4ade80",
      downColor: "#fb7185",
      downBorderColor: "#fb7185",
      downWickColor: "#fb7185",
      noChangeColor: "#94a3b8",
      noChangeBorderColor: "#94a3b8",
      noChangeWickColor: "#94a3b8",
    },
    tooltip: { showRule: "none" },
  },
  indicator: {
    tooltip: { showRule: "none" },
    ohlc: {
      upColor: "#4ade80",
      downColor: "#fb7185",
      noChangeColor: "#94a3b8",
    },
  },
  xAxis: {
    axisLine: { color: "#30465d" },
    tickLine: { color: "#30465d" },
    tickText: { color: "#adbed1" },
  },
  yAxis: {
    axisLine: { color: "#30465d" },
    tickLine: { color: "#30465d" },
    tickText: { color: "#adbed1" },
  },
  separator: { color: "#30465d" },
};

function PerpCanvas({
  symbol,
  interval,
  date,
  precision,
  data,
  markers,
  onHover,
  onSelect,
}: {
  symbol: string;
  interval: Market["interval"];
  date: string;
  precision: number;
  data: KLineData[];
  markers: OverlayCreate[];
  onHover: (timestamp: number | null) => void;
  onSelect: (timestamp: number) => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  const listRef = useRef<KLineData[]>([]);
  const pushBar = useRef<((bar: KLineData) => void) | null>(null);
  const [chart, setChart] = useState<Chart | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const helpId = useId();
  const previousDates = useRef(new WeakMap<Chart, string>());
  useEffect(() => {
    const element = node.current;
    if (!element) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    // KLineChart evaluates browser globals on import. Keep it out of SSR and the initial bundle.
    void import("klinecharts")
      .then(lib => {
        if (cancelled) return;
        if (!lib.getSupportedOverlays().includes(markerName)) {
          lib.registerOverlay<{ label: string }>({
            name: markerName,
            totalStep: 2,
            needDefaultPointFigure: false,
            needDefaultXAxisFigure: false,
            needDefaultYAxisFigure: false,
            createPointFigures: ({ overlay, coordinates }) => {
              const point = coordinates[0];
              if (!point) return [];
              return [
                {
                  type: "circle",
                  attrs: { ...point, r: 3 },
                  styles: { color: "#fbbf24" },
                  ignoreEvent: true,
                },
                {
                  type: "text",
                  attrs: {
                    x: point.x,
                    y: point.y - 8,
                    align: "center",
                    baseline: "bottom",
                    text: overlay.extendData.label,
                  },
                  styles: { color: "#fbbf24", size: 10 },
                  ignoreEvent: true,
                },
              ];
            },
          });
        }
        const instance = lib.init(element, {
          locale: "zh-CN",
          timezone: "Asia/Shanghai",
          styles,
          hotkey: { enabled: false },
        });
        if (!instance) throw new Error("KLineChart initialization failed");
        cleanup = () => {
          pushBar.current = null;
          lib.dispose(instance);
        };
        instance.setOffsetRightDistance(16);
        instance.setBarSpace(9);
        instance.createIndicator({
          name: "VOL",
          shortName: "成交量",
          calcParams: [],
          styles: {
            bars: [
              {
                upColor: "#4ade80",
                downColor: "#fb7185",
                noChangeColor: "#94a3b8",
              },
            ],
          },
        });
        const volume = instance.getIndicators({ name: "VOL" })[0];
        if (volume)
          instance.setPaneOptions({
            id: volume.paneId,
            height: 88,
            minHeight: 64,
          });
        instance.setSymbol({
          ticker: symbol,
          pricePrecision: precision,
          volumePrecision: 8,
        });
        instance.setPeriod({ type: "minute", span: interval });
        instance.setDataLoader({
          getBars: ({ type, callback }) =>
            callback(type === "init" ? [...listRef.current] : [], false),
          subscribeBar: ({ callback }) => {
            pushBar.current = callback;
          },
          unsubscribeBar: () => {
            pushBar.current = null;
          },
        });
        instance.subscribeAction("onCrosshairChange", event => {
          const x = (event as Crosshair | undefined)?.x;
          if (typeof x !== "number") {
            onHover(null);
            return;
          }
          const [point] = instance.convertFromPixel([{ x }]) as {
            dataIndex?: number;
          }[];
          onHover(
            instance.getDataList()[point?.dataIndex ?? -1]?.timestamp ?? null
          );
        });
        instance.subscribeAction("onCandleBarClick", event => {
          const index = (event as { dataIndex?: number } | undefined)
            ?.dataIndex;
          const bar = instance.getDataList()[index ?? -1];
          if (bar) onSelect(bar.timestamp);
        });
        const observer = new ResizeObserver(() => instance.resize());
        const disposeChart = cleanup;
        cleanup = () => {
          observer.disconnect();
          disposeChart();
        };
        observer.observe(element);
        setChart(instance);
      })
      .catch(() => {
        cleanup?.();
        cleanup = undefined;
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      cleanup?.();
      setChart(null);
    };
  }, [symbol, interval, precision, attempt, onHover, onSelect]);

  useEffect(() => {
    listRef.current = data;
    if (!chart) return;
    const current = chart.getDataList();
    const sameDate = previousDates.current.get(chart) === date;
    const incremental = sameDate ? incrementalBars(current, data) : null;
    if (incremental !== null && pushBar.current) {
      for (const bar of incremental) pushBar.current(bar);
    } else {
      const view = chart.getVisibleRange();
      const wasFollowing = view.to >= current.length;
      const anchor =
        sameDate && !wasFollowing
          ? current[Math.max(0, view.to - 1)]?.timestamp
          : undefined;
      chart.resetData();
      if (anchor !== undefined && data.length) chart.scrollToTimestamp(anchor);
    }
    previousDates.current.set(chart, date);
  }, [chart, data, date]);
  useEffect(() => {
    if (!chart) return;
    chart.removeOverlay({ groupId: markerGroup });
    if (markers.length)
      chart.createOverlay(markers.map(marker => ({ ...marker })));
  }, [chart, date, data, markers]);

  function pan(event: KeyboardEvent<HTMLDivElement>) {
    if (
      !chart ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    const key = event.key;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
    event.preventDefault();
    if (key === "Home") chart.scrollToDataIndex(0);
    else if (key === "End") chart.scrollToRealTime();
    else
      chart.scrollByDistance(
        chart.getBarSpace().bar * (key === "ArrowLeft" ? 8 : -8)
      );
  }
  return (
    <>
      <p id={helpId} className="mb-2 text-xs text-muted-foreground">
        左右拖动查看历史 · 滚轮或双指缩放 · 移动十字线查看行情 ·
        也可用方向键平移或下方选择器查看区间
      </p>
      <div className="relative rounded-xl bg-[#0b1722]">
        <div
          ref={node}
          className="h-[23rem] w-full rounded-xl sm:h-[27rem]"
          role="region"
          aria-label="价格与成交量图"
          aria-describedby={helpId}
          tabIndex={0}
          onKeyDown={pan}
          onPointerLeave={() => onHover(null)}
        />
        {!chart && (
          <div className="absolute inset-0 flex flex-wrap items-center justify-center gap-3 text-sm text-muted-foreground">
            <p role="status">
              {failed
                ? "图表加载失败，可继续查看下方行情表。"
                : "正在加载 K 线图…"}
            </p>
            {failed && (
              <button
                type="button"
                className={button}
                onClick={() => {
                  setFailed(false);
                  setAttempt(n => n + 1);
                }}
              >
                重试
              </button>
            )}
          </div>
        )}
      </div>
      {chart && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            className={button}
            onClick={() => chart.scrollToRealTime()}
          >
            回到最新
          </button>
        </div>
      )}
    </>
  );
}

export function PerpChart({
  market,
  trades,
}: {
  market: Market;
  trades: Trades;
}) {
  const duration = market.interval * 60_000;
  const [chosenDay, setDay] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const dateId = useId(),
    candleId = useId();
  const dates = useMemo(
    () =>
      [...new Set(market.bars.map(bar => day(dayStart(bar.endAt, duration))))]
        .sort()
        .reverse(),
    [market.bars, duration]
  );
  const date = dates.includes(chosenDay) ? chosenDay : dates[0];
  const bars = useMemo(
    () =>
      market.bars
        .filter(bar => day(dayStart(bar.endAt, duration)) === date)
        .sort((a, b) => a.endAt - b.endAt),
    [market.bars, date, duration]
  );
  const data = useMemo(() => toChartData(bars, duration), [bars, duration]);
  const groups = useMemo(
    () => groupCandleTrades(trades, market.symbol, duration),
    [trades, market.symbol, duration]
  );
  const markers = useMemo(() => {
    const overlays: OverlayCreate[] = [];
    for (const bar of data) {
      const fills = groups.get(bar.timestamp);
      if (!fills?.length) continue;
      const label = [
        ...new Set(fills.map(fill => orderLabel[fill.action])),
      ].join("/");
      overlays.push({
        name: markerName,
        groupId: markerGroup,
        lock: true,
        points: [{ timestamp: bar.timestamp, value: bar.high }],
        extendData: { label },
      });
    }
    return overlays;
  }, [data, groups]);
  const bar =
    bars.find(b => b.endAt - duration === hover) ??
    bars.find(b => b.endAt - duration === selected) ??
    bars.at(-1);
  if (!bar)
    return (
      <p className="py-6 text-muted-foreground">
        当前没有可展示的 Bybit {market.interval} 分钟行情。
      </p>
    );
  const fills = groups.get(bar.endAt - duration) ?? [];
  const tick = market.instrument?.tickSizeUnits;
  const precision = tick
    ? tick % 1000 === 0
      ? 0
      : tick % 100 === 0
        ? 1
        : tick % 10 === 0
          ? 2
          : 3
    : 3;
  const intervalLabel = (b: Bar) =>
    time(b.endAt - duration) + "–" + time(b.endAt);
  return (
    <figure className="mt-4 min-w-0">
      <figcaption className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-bold">{market.interval} 分钟 K 线与成交量</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            北京时间 · 绿涨红跌 · 黄色标记为个人成交
          </p>
        </div>
        <div>
          <label htmlFor={dateId} className="text-xs">
            日期
          </label>
          <select
            id={dateId}
            className={input}
            value={date}
            onChange={event => {
              setDay(event.target.value);
              setHover(null);
              setSelected(null);
            }}
          >
            {dates.map(d => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </div>
      </figcaption>
      <PerpCanvas
        symbol={market.symbol}
        interval={market.interval}
        date={date}
        precision={precision}
        data={data}
        markers={markers}
        onHover={setHover}
        onSelect={setSelected}
      />
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <label htmlFor={candleId}>查看区间</label>
        <select
          id={candleId}
          className="rounded border border-border bg-[#162638] p-2"
          value={bar.endAt - duration}
          onChange={event => {
            setHover(null);
            setSelected(Number(event.target.value));
          }}
        >
          {bars.map(b => (
            <option key={b.endAt} value={b.endAt - duration}>
              {intervalLabel(b)}
            </option>
          ))}
        </select>
        <span className="tabular-nums">
          开 {bar.open} 高 {bar.high} 低 {bar.low} 收 {bar.close} · 涨跌幅{" "}
          {pct(bar)} · 量 {volumeFormat.format(bar.volume)}{" "}
          {baseCoin(market.symbol)}
          {!bar.complete ? " · 更新中" : ""}
        </span>
      </div>
      {fills.length > 0 && (
        <ul className="mt-2 text-sm text-[#ffd473]">
          {fills.map(fill => (
            <li key={fill.id}>
              {stamp(fill.createdAt)} {orderLabel[fill.action]}{" "}
              {coin(fill.quantityAtoms)} {baseCoin(fill.symbol)} · 成交价{" "}
              {sim(fill.priceUnits)} USDT
            </li>
          ))}
        </ul>
      )}
      <details className="mt-3 text-sm">
        <summary className="w-fit cursor-pointer">查看行情数据表</summary>
        <Table
          title={date + " " + market.interval + " 分钟行情"}
          columns={[
            "区间",
            "开",
            "高",
            "低",
            "收",
            "涨跌幅",
            "成交量（" + baseCoin(market.symbol) + "）",
          ]}
        >
          {bars.map(b => (
            <tr key={b.endAt}>
              <th scope="row" className="px-3 py-2 font-medium">
                {intervalLabel(b)}
              </th>
              <td>{b.open}</td>
              <td>{b.high}</td>
              <td>{b.low}</td>
              <td>{b.close}</td>
              <td>{pct(b)}</td>
              <td>{volumeFormat.format(b.volume)}</td>
            </tr>
          ))}
        </Table>
      </details>
    </figure>
  );
}
