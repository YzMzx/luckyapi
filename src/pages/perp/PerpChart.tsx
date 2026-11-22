import { useState } from "react";
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
import type { PerpApi } from "./format";

type Market = PerpApi["market"];
type Bar = Market["bars"][number];
const quarter = 15 * 60 * 1000;
// Use wall-clock slots, including nights and weekends; missing bars stay empty.
function slot(endAt: number) {
  return Math.floor(((endAt - quarter + 8 * 3600000) % 86400000) / quarter);
}
const cell = 14;
const x = (b: Bar) => 90 + slot(b.endAt) * cell;
export function PerpChart({
  market,
  trades,
}: {
  market: Market;
  trades: PerpApi["account"]["orders"];
}) {
  const [chosenDay, setDay] = useState("");
  const [end, setEnd] = useState(0);
  const dates = [...new Set(market.bars.map(b => day(b.endAt - quarter)))]
    .sort()
    .reverse();
  const date = dates.includes(chosenDay) ? chosenDay : dates[0];
  const bars = market.bars
    .filter(b => day(b.endAt - quarter) === date)
    .sort((a, b) => a.endAt - b.endAt);
  const bar = bars.find(b => b.endAt === end) ?? bars.at(-1);
  if (!bar)
    return (
      <p className="py-6 text-muted-foreground">
        当前没有可展示的 Bybit 15 分钟行情。
      </p>
    );
  const min = Math.min(...bars.map(b => b.low));
  const max = Math.max(...bars.map(b => b.high));
  const padding = Math.max((max - min) * 0.12, 0.005);
  const y = (price: number) =>
    169 - ((price - min + padding) * 142) / (max - min + 2 * padding);
  const volumeMax = Math.max(1, ...bars.map(b => b.volume));
  const marks = (b: Bar) =>
    trades.filter(
      o =>
        o.symbol === market.symbol &&
        o.createdAt >= b.endAt - quarter &&
        o.createdAt < b.endAt
    );
  const fills = marks(bar);
  return (
    <figure className="mt-4">
      <figcaption className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-bold">15 分钟 K 线与成交量</h3>
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
            onChange={e => setDay(e.target.value)}
          >
            {dates.map(d => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </div>
      </figcaption>
      <div
        className="overflow-x-auto rounded-xl bg-[#0b1722]"
        role="region"
        tabIndex={0}
        aria-label="价格与成交量图"
      >
        <svg
          role="img"
          aria-label={date + " 的 15 分钟行情，可在下方选择区间查看数值"}
          viewBox="0 0 1450 287"
          className="w-full min-w-[64rem]"
          fill="currentColor"
          fontSize="11"
        >
          {[max, (max + min) / 2, min]
            .filter((p, i, a) => a.indexOf(p) === i)
            .map(p => (
              <g key={p}>
                <text x="6" y={y(p) + 4}>
                  {p.toFixed(2)}
                </text>
                <line x1="60" x2="1430" y1={y(p)} y2={y(p)} stroke="#314453" />
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
            const cx = x(b);
            const up = b.close > b.open;
            const color = up
              ? "#fb8789"
              : b.close < b.open
                ? "#5ad6ac"
                : "#b6beca";
            const h = (b.volume / volumeMax) * 43;
            const filled = marks(b);
            return (
              <g
                key={b.endAt}
                onClick={() => setEnd(b.endAt)}
                style={{ cursor: "pointer" }}
              >
                <rect
                  x={cx - 6}
                  width="12"
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
          {[0, 12, 24, 36, 48, 60, 72, 84, 95].map(i => (
            <text key={i} x={90 + i * cell} y="275" textAnchor="middle">
              {time(
                Math.floor((bars[0].endAt - quarter + 8 * 3600000) / 86400000) *
                  86400000 -
                  8 * 3600000 +
                  i * quarter
              )}
            </text>
          ))}
        </svg>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <label htmlFor="chart-interval">查看区间</label>
        <select
          id="chart-interval"
          className="rounded border border-border bg-[#162638] p-2"
          value={bar.endAt}
          onChange={e => setEnd(Number(e.target.value))}
        >
          {bars.map(b => (
            <option key={b.endAt} value={b.endAt}>
              {time(b.endAt - quarter)}–{time(b.endAt)}
            </option>
          ))}
        </select>
        <span>
          开 {bar.open} 高 {bar.high} 低 {bar.low} 收 {bar.close} 量{" "}
          {bar.volume.toLocaleString()} {baseCoin(market.symbol)}
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
          title={date + " 十五分钟行情"}
          columns={[
            "区间结束",
            "开",
            "高",
            "低",
            "收",
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
              <td>{b.volume.toLocaleString()}</td>
            </tr>
          ))}
        </Table>
      </details>
    </figure>
  );
}
