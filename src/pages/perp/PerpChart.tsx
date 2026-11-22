import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  candleEnd,
  chart,
  timeScale,
  dayStart,
  priceScale,
  changePercent,
} from "./chartScale";
import {
  baseCoin,
  coin,
  day,
  input,
  orderLabel,
  sim,
  stamp,
  time,
} from "./format";
import { Table } from "./shared";
import "./PerpChart.css";
import type { PerpApi } from "./format";

type Market = PerpApi["market"];
type Bar = Market["bars"][number];
const volumeFormat = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 8,
});
const priceFormat = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 3,
});
const pctFormat = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
});
const pct = (b: Bar) => pctFormat.format(changePercent(b.open, b.close)) + "%";
export function PerpChart({
  market,
  trades,
}: {
  market: Market;
  trades: PerpApi["account"]["orders"];
}) {
  const duration = market.interval * 60000;
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(640);
  const followLatest = useRef(true);
  const pan = useRef<{ pointerId: number; x: number; left: number } | null>(
    null
  );
  const skipClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  useLayoutEffect(() => {
    if (!viewport) return;
    const update = () => setViewportWidth(viewport.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewport]);
  const tradesByEnd = useMemo(() => {
    const buckets = new Map<number, typeof trades>();
    for (const trade of trades) {
      if (trade.symbol !== market.symbol) continue;
      const key = candleEnd(trade.createdAt, duration);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(trade);
      else buckets.set(key, [trade]);
    }
    return buckets;
  }, [market.symbol, trades, duration]);
  const [chosenDay, setDay] = useState("");
  const [end, setEnd] = useState(0);
  const [hover, setHover] = useState<{
    end: number;
    y: number;
    left: boolean;
  } | null>(null);
  const dates = useMemo(
    () =>
      [...new Set(market.bars.map(b => day(dayStart(b.endAt, duration))))]
        .sort()
        .reverse(),
    [market.bars, duration]
  );
  const date = dates.includes(chosenDay) ? chosenDay : dates[0];
  const bars = useMemo(
    () =>
      market.bars
        .filter(b => day(dayStart(b.endAt, duration)) === date)
        .sort((a, b) => a.endAt - b.endAt),
    [market.bars, date, duration]
  );
  const hovered = hover && bars.find(b => b.endAt === hover.end);
  const bar = hovered || bars.find(b => b.endAt === end) || bars.at(-1);
  const firstEnd = bars[0]?.endAt ?? 0,
    lastEnd = bars.at(-1)?.endAt ?? 0;
  const axis = useMemo(
    () => timeScale(firstEnd, lastEnd, duration, viewportWidth),
    [firstEnd, lastEnd, duration, viewportWidth]
  );
  useLayoutEffect(() => {
    if (viewport && followLatest.current)
      viewport.scrollTo({ left: viewport.scrollWidth - viewport.clientWidth });
  }, [viewport, axis.width, date, lastEnd]);
  if (!bar)
    return (
      <p className="py-6 text-muted-foreground">
        当前没有可展示的 Bybit {market.interval} 分钟行情。
      </p>
    );
  const min = Math.min(...bars.map(b => b.low));
  const max = Math.max(...bars.map(b => b.high));
  const { y, priceAt } = priceScale(min, max);
  function startPan(e: PointerEvent<HTMLDivElement>) {
    if (!e.isPrimary || e.button !== 0) return;
    skipClick.current = false;
    const view = e.currentTarget;
    // Keep native touch scrolling so vertical swipes still scroll the page.
    if (e.pointerType === "touch" || view.scrollWidth <= view.clientWidth)
      return;
    pan.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      left: view.scrollLeft,
    };
  }
  function movePan(e: PointerEvent<HTMLDivElement>) {
    const start = pan.current;
    if (!start || start.pointerId !== e.pointerId) return;
    const dx = e.clientX - start.x;
    if (!skipClick.current) {
      if (Math.abs(dx) < 4) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      skipClick.current = true;
      followLatest.current = false;
      setHover(null);
      setDragging(true);
    }
    e.currentTarget.scrollLeft = start.left - dx;
  }
  function finishPan(e: PointerEvent<HTMLDivElement>) {
    if (pan.current?.pointerId !== e.pointerId) return;
    pan.current = null;
    const view = e.currentTarget;
    if (skipClick.current)
      followLatest.current =
        view.scrollWidth - view.clientWidth - view.scrollLeft <= axis.cell;
    setDragging(false);
    if (view.hasPointerCapture(e.pointerId))
      view.releasePointerCapture(e.pointerId);
  }
  function panKeys(e: KeyboardEvent<HTMLDivElement>) {
    const view = e.currentTarget;
    const step = Math.max(axis.cell, view.clientWidth / 4);
    const target =
      e.key === "ArrowLeft"
        ? view.scrollLeft - step
        : e.key === "ArrowRight"
          ? view.scrollLeft + step
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? view.scrollWidth - view.clientWidth
              : null;
    if (target === null || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey)
      return;
    e.preventDefault();
    view.scrollLeft = target;
  }
  function inspect(e: PointerEvent<SVGSVGElement>) {
    if (e.pointerType === "touch" || (pan.current && skipClick.current)) return;
    const svg = e.currentTarget,
      matrix = svg.getScreenCTM();
    if (!matrix) return;
    const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(
      matrix.inverse()
    );
    const t = axis.endAtPoint(point.x, point.y);
    const viewport = svg.parentElement!.getBoundingClientRect();
    setHover(
      t !== null && bars.some(b => b.endAt === t)
        ? {
            end: t,
            y: Math.round(point.y),
            left: e.clientX > viewport.left + viewport.width / 2,
          }
        : null
    );
  }
  const volumeMax = Math.max(1, ...bars.map(b => b.volume));
  const marks = (b: Bar) => tradesByEnd.get(b.endAt) ?? [];
  const fills = marks(bar);
  return (
    <figure className="mt-4">
      <figcaption className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-bold">{market.interval} 分钟 K 线与成交量</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            全天交易 · 北京时间 · 空心收高，实心收低，横线平收
          </p>
        </div>
        <div>
          <label htmlFor="chart-date" className="text-xs">
            日期
          </label>
          <select
            id="chart-date"
            className={input}
            value={date}
            onChange={e => {
              followLatest.current = true;
              setDay(e.target.value);
              setHover(null);
              setEnd(0);
            }}
          >
            {dates.map(d => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </div>
      </figcaption>
      <p id="perp-chart-help" className="mb-2 text-xs text-muted-foreground">
        按住图面左右拖动或触屏滑动 · 聚焦图表后可用左右方向键 ·
        点击蜡烛或用下方选择器查看详情
      </p>
      <div className="relative">
        <div
          ref={setViewport}
          onScroll={e => {
            const v = e.currentTarget;
            followLatest.current =
              v.scrollWidth - v.clientWidth - v.scrollLeft <= axis.cell;
            setHover(null);
          }}
          onPointerDown={startPan}
          onPointerMoveCapture={movePan}
          onPointerUp={finishPan}
          onPointerCancel={finishPan}
          onLostPointerCapture={finishPan}
          onPointerLeave={e => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) finishPan(e);
          }}
          onClickCapture={e => {
            if (!skipClick.current) return;
            skipClick.current = false;
            e.stopPropagation();
          }}
          onKeyDown={panKeys}
          className={
            "perp-chart-viewport overflow-x-auto rounded-xl bg-[#0b1722] " +
            (dragging
              ? "cursor-grabbing"
              : axis.width > viewportWidth
                ? "cursor-grab"
                : "")
          }
          role="region"
          tabIndex={0}
          aria-label="价格与成交量图"
          aria-describedby="perp-chart-help"
        >
          <svg
            onPointerMove={inspect}
            onPointerLeave={() => setHover(null)}
            onPointerCancel={() => setHover(null)}
            role="img"
            aria-label={
              date +
              " 的 " +
              market.interval +
              " 分钟行情，可在下方选择区间查看数值"
            }
            viewBox={`0 0 ${axis.width} 287`}
            width={axis.width}
            height={287}
            className="block max-w-none"
            fill="currentColor"
            fontSize="11"
          >
            {[max, (max + min) / 2, min]
              .filter((p, i, a) => a.indexOf(p) === i)
              .map(p => (
                <g key={p}>
                  <text x="6" y={y(p) + 4}>
                    {priceFormat.format(p)}
                  </text>
                  <line
                    x1="60"
                    x2={axis.width - 18}
                    y1={y(p)}
                    y2={y(p)}
                    stroke="#314453"
                  />
                </g>
              ))}
            <text x="6" y="18">
              价格 / USDT
            </text>
            <text x="6" y="202">
              量 / {baseCoin(market.symbol)}
            </text>
            <text x="6" y="222">
              {volumeMax.toLocaleString("zh-CN")}
            </text>
            {bars.map(b => {
              const cx = axis.x(b.endAt);
              const up = b.close > b.open;
              const color = up
                ? "#fb8789"
                : b.close < b.open
                  ? "#5ad6ac"
                  : "#b6beca";
              const h = (b.volume / volumeMax) * 43;
              const filled = marks(b);
              return (
                <g key={b.endAt} onClick={() => setEnd(b.endAt)}>
                  <rect
                    x={cx - axis.cell / 2}
                    width={axis.cell}
                    y="25"
                    height="230"
                    fill={b.endAt === bar.endAt ? "#263748" : "transparent"}
                  />
                  <line
                    x1={cx}
                    x2={cx}
                    y1={y(b.high)}
                    y2={y(b.low)}
                    stroke={color}
                    strokeWidth="1.5"
                  />
                  <rect
                    x={cx - 4}
                    width="8"
                    y={y(Math.max(b.open, b.close))}
                    height={Math.max(1, Math.abs(y(b.open) - y(b.close)))}
                    fill={up ? "#0b1722" : color}
                    stroke={color}
                    strokeWidth="1.5"
                  />
                  <rect
                    x={cx - 4}
                    width="8"
                    y={253 - h}
                    height={h}
                    fill={color}
                  />
                  {filled.length > 0 && (
                    <text x={cx} y="190" textAnchor="middle" fill="#ffc85d">
                      {[...new Set(filled.map(o => orderLabel[o.action]))].join(
                        "/"
                      )}
                    </text>
                  )}
                </g>
              );
            })}
            {hovered && hover && (
              <g
                pointerEvents="none"
                aria-hidden="true"
                stroke="#d9e6f5"
                strokeDasharray="4 3"
              >
                <line
                  x1={axis.x(hovered.endAt)}
                  x2={axis.x(hovered.endAt)}
                  y1={chart.top}
                  y2={chart.volumeBottom}
                />
                {priceAt(hover.y) !== null && (
                  <>
                    <line
                      x1="60"
                      x2={axis.width - 18}
                      y1={hover.y}
                      y2={hover.y}
                    />
                    <rect
                      stroke="none"
                      fill="#263748"
                      x="0"
                      y={hover.y - 9}
                      width="74"
                      height="18"
                      rx="3"
                    />
                    <text x="4" y={hover.y + 4} stroke="none" fill="#fff">
                      {priceFormat.format(priceAt(hover.y)!)}
                    </text>
                  </>
                )}
              </g>
            )}
            {axis.ticks.map(t => (
              <text key={t} x={axis.x(t)} y="275" textAnchor="middle">
                {time(t - duration)}
              </text>
            ))}
          </svg>
        </div>
        {hovered && hover && (
          <div
            aria-hidden="true"
            className={
              "pointer-events-none absolute top-2 z-10 max-w-[85%] rounded-lg border border-slate-500/60 bg-[#122234]/95 px-3 py-2 text-xs text-white shadow-lg tabular-nums " +
              (hover.left ? "left-2" : "right-2")
            }
          >
            <strong>
              {time(hovered.endAt - duration)}–{time(hovered.endAt)} ·{" "}
              {hovered.complete ? "已收盘" : "更新中"}
            </strong>
            <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
              {[
                ["开", priceFormat.format(hovered.open)],
                ["高", priceFormat.format(hovered.high)],
                ["低", priceFormat.format(hovered.low)],
                ["收", priceFormat.format(hovered.close)],
                ["涨跌幅", pct(hovered)],
                [
                  "量 / " + baseCoin(market.symbol),
                  volumeFormat.format(hovered.volume),
                ],
              ].map(([k, v]) => (
                <div className="contents" key={k}>
                  <dt className="text-slate-300">{k}</dt>
                  <dd className="text-right">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <label htmlFor="chart-candle">查看区间</label>
        <select
          id="chart-candle"
          className="rounded border border-border bg-[#162638] p-2"
          value={bar.endAt}
          onChange={e => {
            setHover(null);
            const t = Number(e.target.value);
            setEnd(t);
            if (viewport) {
              const cx = axis.x(t);
              if (
                cx < viewport.scrollLeft ||
                cx > viewport.scrollLeft + viewport.clientWidth
              )
                viewport.scrollTo({ left: cx - viewport.clientWidth / 2 });
            }
          }}
        >
          {bars.map(b => (
            <option key={b.endAt} value={b.endAt}>
              {time(b.endAt - duration)}–{time(b.endAt)}
            </option>
          ))}
        </select>
        <span>
          开 {bar.open} 高 {bar.high} 低 {bar.low} 收 {bar.close} · 涨跌幅{" "}
          {pct(bar)} · 量 {volumeFormat.format(bar.volume)}{" "}
          {baseCoin(market.symbol)}
          {!bar.complete ? " · 更新中" : ""}
        </span>
      </div>
      {fills.length > 0 && (
        <ul className="mt-2 text-sm text-[#ffd473]">
          {fills.map(o => (
            <li key={o.id}>
              {stamp(o.createdAt)} {orderLabel[o.action]}{" "}
              {coin(o.quantityAtoms)} {baseCoin(o.symbol)} · 成交价{" "}
              {sim(o.priceUnits)} USDT
            </li>
          ))}
        </ul>
      )}
      <details className="mt-3 text-sm">
        <summary className="w-fit cursor-pointer">查看行情数据表</summary>
        <Table
          title={date + " " + market.interval + " 分钟行情"}
          columns={[
            "区间结束",
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
              <td>{time(b.endAt)}</td>
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
