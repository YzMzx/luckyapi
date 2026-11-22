import { useState } from "react";
import { Link } from "react-router";
import { skipToken } from "@tanstack/react-query";
import { trpc } from "@/providers/trpc";
import {
  DEFAULT_PERP_KLINE_INTERVAL,
  PERP_KLINE_INTERVALS,
  type PerpKlineInterval,
} from "@contracts/perp-kline";
import { SiteNav } from "@/components/SiteNav";
import { usePerpPresence } from "./usePerpPresence";
import { useMe } from "@/hooks/useMe";
import { PerpChart } from "./PerpChart";
import { PendingOrders } from "./PendingOrders";
import { ExchangeForm, TradeForm } from "./PerpForms";
import {
  type PerpApi,
  button,
  credit,
  input,
  panel,
  signed,
  sim,
  stamp,
  rate,
  coin,
  baseCoin,
  notionalUnits,
  orderLabel,
} from "./format";
import { Table } from "./shared";
import { formatExchange } from "./exchangeReview";

type Account = PerpApi["account"];
function PositionRow({
  p,
  select,
}: {
  p: Account["positions"][number];
  select: (s: string) => void;
}) {
  const symbol = p.symbol;
  const q = trpc.perps.market.useQuery(
    { symbol },
    { refetchInterval: 5000, retry: 1 }
  );
  const quote = q.error ? null : q.data?.quote;
  const pnl = quote
    ? (notionalUnits(p.quantityAtoms, quote.markUnits) - p.entryNotionalUnits) *
      (p.side === "long" ? 1 : -1)
    : null;
  return (
    <tr>
      <td>
        <button
          type="button"
          className="text-[#ffd473] underline"
          onClick={() => select(p.symbol)}
        >
          {p.symbol}
        </button>
      </td>
      <td>
        {p.side === "long" ? "多" : "空"} · {p.leverage}×
      </td>
      <td>
        {coin(p.quantityAtoms)} {baseCoin(p.symbol)}
      </td>
      <td>{sim(p.marginUnits)}</td>
      <td>{sim(p.entryPriceUnits)}</td>
      <td>{quote ? sim(quote.markUnits) : "—"}</td>
      <td>{p.liquidationPriceUnits ? sim(p.liquidationPriceUnits) : "—"}</td>
      <td>{pnl !== null ? signed(pnl) : "待估值"}</td>
    </tr>
  );
}
function Records({ account }: { account: Account }) {
  return (
    <section className={panel}>
      <h2 className="text-xl font-bold">账户记录</h2>
      <details open className="mt-4">
        <summary className="cursor-pointer font-bold">成交与强平记录</summary>
        {account.orders.length ? (
          <Table
            title="成交与强平记录"
            columns={[
              "成交时间",
              "合约",
              "操作",
              "数量",
              "成交价（USDT）",
              "手续费",
              "已实现盈亏",
            ]}
          >
            {account.orders.map(o => (
              <tr key={o.id}>
                <td>{stamp(o.createdAt)}</td>
                <td>{o.symbol}</td>
                <td>
                  {orderLabel[o.action]} · {o.side === "long" ? "多" : "空"}
                </td>
                <td>{coin(o.quantityAtoms)}</td>
                <td>{sim(o.priceUnits)}</td>
                <td>{sim(o.feeUnits)}</td>
                <td>{signed(o.pnlUnits)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">暂无成交。</p>
        )}
      </details>
      <details className="mt-4">
        <summary className="cursor-pointer font-bold">资金费流水</summary>
        {account.funding.length ? (
          <Table
            title="资金费流水"
            columns={[
              "结算时间",
              "合约",
              "标记价格（USDT）",
              "资金费率",
              "收支（模拟金）",
            ]}
          >
            {account.funding.map(f => (
              <tr key={f.id}>
                <td>{stamp(f.asOf)}</td>
                <td>{f.symbol}</td>
                <td>{sim(f.markUnits)}</td>
                <td>{rate(f.rateE8)}</td>
                <td>{signed(f.amountUnits)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">暂无资金费结算。</p>
        )}
      </details>
      <details className="mt-4">
        <summary className="cursor-pointer font-bold">最近兑换</summary>
        {account.exchanges.length ? (
          <Table
            title="最近兑换"
            columns={[
              "兑换时间",
              "方向",
              "成交比例（余额 : 模拟金）",
              "本笔费率",
              "扣除",
              "手续费",
              "实际到账",
            ]}
          >
            {account.exchanges.map(e => {
              const amounts = formatExchange(e);
              return (
                <tr key={e.id}>
                  <td>{stamp(e.createdAt)}</td>
                  <td>{e.direction === "in" ? "换入模拟金" : "兑回余额"}</td>
                  <td>1 : {e.exchangeRate.toLocaleString("zh-CN")}</td>
                  <td>
                    {e.direction === "in" ? 0 : e.redemptionFeeBps / 100}%
                  </td>
                  <td>{amounts.debit}</td>
                  <td>{amounts.fee}</td>
                  <td>{amounts.received}</td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">暂无兑换记录。</p>
        )}
      </details>
    </section>
  );
}
export default function Perps() {
  const { user, isLoading } = useMe({
    requireAuth: true,
    requireOnboarded: true,
  });
  usePerpPresence(!!user?.onboarded);
  const [interval, setIntervalMinutes] = useState<PerpKlineInterval>(
    DEFAULT_PERP_KLINE_INTERVAL
  );
  const enabled = !!user?.onboarded,
    [selected, setSelected] = useState("");
  const symbols = trpc.perps.symbols.useQuery(undefined, {
    enabled,
    refetchInterval: 15000,
  });
  const symbol =
    symbols.data?.find(s => s.symbol === selected)?.symbol ??
    symbols.data?.[0]?.symbol;
  const market = trpc.perps.market.useQuery(
    symbol ? { symbol, interval } : skipToken,
    {
      enabled: enabled && !!symbol,
      // Keep the order form mounted while fetching a different chart for the same symbol.
      placeholderData: previous =>
        previous?.symbol === symbol ? previous : undefined,
      refetchInterval: 3000,
      retry: 1,
    }
  );
  const account = trpc.perps.account.useQuery(undefined, {
    enabled,
    refetchInterval: 10000,
  });
  if (isLoading || !user)
    return <p className="p-8 text-center">正在读取账户…</p>;
  const current = market.data,
    wallet = account.data,
    quote = market.error ? null : current?.quote;
  return (
    <div className="min-h-screen">
      <SiteNav user={user} />
      <main className="mx-auto max-w-6xl space-y-5 px-4 py-8">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black text-[#fce1b6]">
              USDT 永续合约
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Bybit 公开行情 · 24 小时模拟交易 · 逐仓保证金
            </p>
          </div>
          <nav aria-label="合约社区" className="flex flex-wrap gap-2">
            <Link className={button} to="/contracts/square">
              持仓广场 →
            </Link>
            <Link className={button} to="/contracts/weeks">
              历史盈亏周榜 →
            </Link>
          </nav>
        </header>
        {account.error && (
          <p role="alert">
            资产读取失败：{account.error.message}{" "}
            <button className={button} onClick={() => account.refetch()}>
              重试
            </button>
          </p>
        )}
        {wallet && (
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {[
              ["可用模拟金", sim(wallet.availableCashUnits)],
              ["逐仓保证金", sim(wallet.frozenCashUnits)],
              ["永久可用余额", credit(wallet.permanentCreditUnits)],
            ].map(([k, v]) => (
              <div className={panel} key={k}>
                <dt className="text-sm text-muted-foreground">{k}</dt>
                <dd className="mt-1 font-bold text-xl">{v}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section className={panel}>
            <label>
              合约品种
              <select
                value={symbol ?? ""}
                className={input}
                onChange={e => setSelected(e.target.value)}
              >
                {symbols.data?.map(s => (
                  <option key={s.symbol} value={s.symbol}>
                    {s.name} · {s.symbol}
                    {s.openEnabled ? "" : " · 仅平仓"}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor="perp-kline-period" className="mt-3 block text-sm">
              K 线周期
              <select
                id="perp-kline-period"
                className={input}
                value={interval}
                onChange={e => {
                  const selected = PERP_KLINE_INTERVALS.find(
                    value => String(value) === e.target.value
                  );
                  if (selected) setIntervalMinutes(selected);
                }}
              >
                {PERP_KLINE_INTERVALS.map(value => (
                  <option key={value} value={value}>
                    {value} 分钟
                  </option>
                ))}
              </select>
            </label>
            {symbols.error && (
              <p role="alert">
                合约清单读取失败：{symbols.error.message}{" "}
                <button className={button} onClick={() => symbols.refetch()}>
                  重试
                </button>
              </p>
            )}
            {market.error && (
              <p role="alert">
                行情读取失败：{market.error.message}{" "}
                <button className={button} onClick={() => market.refetch()}>
                  重试
                </button>
              </p>
            )}
            {current && symbol ? (
              <>
                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
                  {[
                    ["买一 / USDT", quote ? sim(quote.bidUnits) : "—"],
                    ["卖一 / USDT", quote ? sim(quote.askUnits) : "—"],
                    ["标记价 / USDT", quote ? sim(quote.markUnits) : "—"],
                    ["最新价 / USDT", quote ? sim(quote.lastUnits) : "—"],
                    ["预计资金费率", quote ? rate(quote.fundingRateE8) : "—"],
                    ["下次资金费", quote ? stamp(quote.nextFundingAt) : "—"],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="font-semibold tabular-nums">{v}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-3 text-xs text-muted-foreground">
                  {current.source} ·{" "}
                  {quote ? "盘口时间 " + stamp(quote.asOf) : "实时盘口暂不可用"}
                </p>
                {current.interval === interval ? (
                  <PerpChart
                    key={symbol + ":" + interval}
                    market={current}
                    trades={wallet?.orders ?? []}
                  />
                ) : (
                  <p role="status" className="py-6 text-muted-foreground">
                    正在读取 {interval} 分钟 K 线…
                  </p>
                )}
                {current.readOnlyReason && (
                  <p className="mt-3 text-sm">{current.readOnlyReason}</p>
                )}
              </>
            ) : (
              market.isFetching && <p>正在读取行情…</p>
            )}
          </section>
          {current && wallet && !market.error && (
            <TradeForm key={symbol} market={current} account={wallet} />
          )}
        </div>
        {wallet && (
          <>
            <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
              <section className={panel}>
                <h2 className="text-xl font-bold">逐仓持仓</h2>
                {wallet.positions.length ? (
                  <Table
                    title="逐仓持仓与浮动盈亏"
                    columns={[
                      "合约",
                      "方向 / 杠杆",
                      "数量",
                      "保证金",
                      "开仓均价",
                      "标记价格",
                      "预估强平价",
                      "浮动盈亏",
                    ]}
                  >
                    {wallet.positions.map(p => (
                      <PositionRow key={p.symbol} p={p} select={setSelected} />
                    ))}
                  </Table>
                ) : (
                  <p className="mt-3 text-sm text-muted-foreground">
                    当前没有持仓。
                  </p>
                )}
                <p className="mt-3 text-xs text-muted-foreground">
                  浮动盈亏按标记价格估值。维持保证金率{" "}
                  {wallet.config.maintenanceMarginBps / 100}
                  %，资金费会影响强平价。仅可兑回可用模拟金。
                </p>
              </section>
              <ExchangeForm account={wallet} />
            </div>
            <PendingOrders />
            <Records account={wallet} />
          </>
        )}
      </main>
    </div>
  );
}
