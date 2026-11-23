import { useState } from "react";
import { Link } from "react-router";
import { Pager } from "@/components/Pager";
import { SiteNav } from "@/components/SiteNav";
import { useMe } from "@/hooks/useMe";
import { trpc } from "@/providers/trpc";
import { baseCoin, button, coin, panel, sim, type PerpApi } from "./format";
import { Table } from "./shared";
import { PnlAmount } from "./PnlAmount";
import { usePerpPresence } from "./usePerpPresence";

type SquareData = PerpApi["positionSquare"];
const columns = [
  "玩家",
  "合约页状态",
  "方向 / 杠杆",
  "数量",
  "开仓均价（USDT）",
  "标记价（USDT）",
  "浮动盈亏（模拟 USDT）",
];

function Loading({ label }: { label: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <progress className="h-1 w-16 accent-[#FFB700]" />
      {label}
    </label>
  );
}

export default function PerpSquare() {
  const { user, isLoading } = useMe({
    requireAuth: true,
    requireOnboarded: true,
  });
  const enabled = !!user?.onboarded;
  usePerpPresence(enabled);
  const [{ pages, previousData }, setPagination] = useState<{
    pages: Record<string, number>;
    previousData?: SquareData;
  }>({ pages: {} });
  const list = trpc.perps.positionSquare.useQuery(
    { pages },
    {
      enabled,
      refetchInterval: 5000,
      retry: 1,
      placeholderData: previous => previous,
    }
  );
  // A failed page request no longer receives placeholder data from React Query.
  const data = list.data ?? previousData;
  const groups = data?.groups ?? [];
  const isPrevious = list.isPlaceholderData || !list.data;

  if (isLoading || !user?.onboarded)
    return <p className="p-8 text-center">正在读取账户…</p>;

  return (
    <div className="min-h-screen">
      <SiteNav user={user} />
      <main className="mx-auto max-w-5xl space-y-5 px-4 py-8">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-black text-[#fce1b6]">持仓广场</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              查看玩家当前的模拟合约持仓。在线表示最近 90
              秒内有合约页面在前台打开，不代表正在下单。
            </p>
          </div>
          <nav aria-label="合约社区">
            <Link className={button} to="/contracts">
              返回合约
            </Link>
          </nav>
        </header>
        <section className={panel + " space-y-4"}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="text-lg font-bold">玩家持仓</h2>
            {data && (
              <p className="text-sm">在线持仓玩家：{data.onlineHolders} 人</p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            每 5 秒刷新。浮动盈亏按 Bybit
            标记价估算，不含交易手续费和资金费；无有效报价时显示「待估值」。
          </p>
          {list.isLoading && !data && <Loading label="正在加载持仓…" />}
          {list.error && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <p role="alert">持仓读取失败：{list.error.message}</p>
              <button
                type="button"
                className={button}
                onClick={() => void list.refetch()}
              >
                重试
              </button>
            </div>
          )}
          {data && groups.length === 0 && (
            <p className="py-3 text-sm text-muted-foreground">
              当前暂无公开持仓。
            </p>
          )}
          {groups.map(group => {
            const { symbol, page, totalPages } = group;
            // The server may clamp a requested page if positions have since closed.
            const requestedPage = Math.min(pages[symbol] ?? 1, totalPages);
            const needsPage = isPrevious && requestedPage !== page;
            return (
              <section
                key={symbol}
                className="min-w-0 rounded-lg border border-border p-3 sm:p-4"
              >
                <h3 className="text-base font-bold">{symbol}</h3>
                <Table title={`${symbol} 会员公开持仓`} columns={columns}>
                  {needsPage ? (
                    <tr>
                      <td colSpan={columns.length}>
                        {list.error ? (
                          `未能加载第 ${requestedPage} 页。`
                        ) : (
                          <Loading label={`正在加载第 ${requestedPage} 页…`} />
                        )}
                      </td>
                    </tr>
                  ) : (
                    group.items.map(p => (
                      <tr key={p.nickname}>
                        <th
                          className="sticky left-0 bg-[#101d2b] px-3 py-2"
                          scope="row"
                        >
                          {p.nickname}
                          {p.mine ? "（我）" : ""}
                        </th>
                        <td
                          className={
                            p.online
                              ? "text-emerald-300"
                              : "text-muted-foreground"
                          }
                        >
                          {p.online ? "在线" : "离线"}
                        </td>
                        <td>
                          {p.side === "long" ? "多" : "空"} · {p.leverage}×
                        </td>
                        <td>
                          {coin(p.quantityAtoms)} {baseCoin(p.symbol)}
                        </td>
                        <td>{sim(p.entryPriceUnits)}</td>
                        <td>
                          {p.markPriceUnits === null
                            ? "—"
                            : sim(p.markPriceUnits)}
                        </td>
                        <td>
                          <PnlAmount units={p.pnlUnits} />
                        </td>
                      </tr>
                    ))
                  )}
                </Table>
                <nav aria-label={`${symbol} 持仓分页`}>
                  <fieldset disabled={needsPage}>
                    <Pager
                      className="mt-3"
                      page={page}
                      pageSize={group.pageSize}
                      totalPages={totalPages}
                      total={group.total}
                      onPage={nextPage => {
                        if (needsPage || nextPage === page) return;
                        setPagination(previous => {
                          if (previous.pages[symbol] !== pages[symbol])
                            return previous;
                          const next: Record<string, number> = {};
                          for (const group of groups) {
                            const selected =
                              group.symbol === symbol
                                ? nextPage
                                : previous.pages[group.symbol];
                            if (selected > 1) next[group.symbol] = selected;
                          }
                          return { pages: next, previousData: data };
                        });
                      }}
                      unit="笔持仓"
                    />
                  </fieldset>
                </nav>
              </section>
            );
          })}
        </section>
      </main>
    </div>
  );
}
