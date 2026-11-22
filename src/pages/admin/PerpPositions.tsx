import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Input } from "@/components/ui/input";
import { Pager } from "@/components/Pager";
import { baseCoin, coin, sim, signed, stamp } from "../perp/format";

type Filters = { user: string; symbol: string; side: "" | "long" | "short" };
const empty: Filters = { user: "", symbol: "", side: "" };
const headers = [
  "用户",
  "合约",
  "方向 / 杠杆",
  "持仓数量",
  "逐仓保证金",
  "开仓均价",
  "标记价",
  "未实现盈亏",
  "预估强平价",
  "开仓时间",
];
export default function PerpPositions() {
  const [draft, setDraft] = useState(empty),
    [filters, setFilters] = useState(empty),
    [page, setPage] = useState(1),
    [pageSize, setSize] = useState(20);
  const query = trpc.admin.listPerpPositions.useQuery(
    {
      user: filters.user.trim() || undefined,
      symbol: filters.symbol.trim().toUpperCase() || undefined,
      side: filters.side || undefined,
      page,
      pageSize,
    },
    { refetchInterval: 15000, retry: 1 }
  );
  const data = query.data;
  return (
    <section className="admin-panel min-w-0 space-y-4 p-4 sm:p-6">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={e => {
          e.preventDefault();
          setPage(1);
          setFilters({ ...draft });
        }}
      >
        <label className="text-sm">
          用户
          <Input
            className="admin-input mt-1"
            placeholder="用户名、群内名称或账号 ID"
            maxLength={64}
            value={draft.user}
            onChange={e => setDraft({ ...draft, user: e.target.value })}
          />
        </label>
        <label className="text-sm">
          合约品种
          <Input
            className="admin-input mt-1"
            placeholder="如 BTCUSDT"
            maxLength={32}
            pattern="[A-Za-z0-9]+[Uu][Ss][Dd][Tt]"
            title="请输入完整 USDT 合约代码"
            value={draft.symbol}
            onChange={e =>
              setDraft({ ...draft, symbol: e.target.value.trim() })
            }
          />
        </label>
        <label className="text-sm">
          方向
          <select
            className="admin-input mt-1 block rounded-md border p-2"
            value={draft.side}
            onChange={e =>
              setDraft({ ...draft, side: e.target.value as Filters["side"] })
            }
          >
            <option value="">全部方向</option>
            <option value="long">做多</option>
            <option value="short">做空</option>
          </select>
        </label>
        <button className="admin-primary rounded px-4 py-2">筛选</button>
        <button
          type="button"
          className="rounded border px-3 py-2"
          onClick={() => {
            setDraft(empty);
            setFilters(empty);
            setPage(1);
          }}
        >
          重置
        </button>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p>
          当前未平仓 · 每 15 秒刷新。价格和浮盈亏以模拟 USDT
          计；行情不可用时保留持仓明细。
        </p>
        <button
          className="rounded border px-3 py-1"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? "刷新中…" : "刷新"}
        </button>
      </div>
      {query.error && <p role="alert">持仓读取失败：{query.error.message}</p>}
      {query.isLoading && <p role="status">正在读取持仓…</p>}
      {data && !query.error && (
        <>
          <p className="text-xs text-muted-foreground">
            持仓快照：{stamp(data.asOf)}（北京时间）
          </p>
          {data.items.length ? (
            <div
              role="region"
              aria-label="全站未平仓合约"
              tabIndex={0}
              className="max-h-[65vh] overflow-auto rounded-md border"
            >
              <table className="w-full whitespace-nowrap text-left text-sm tabular-nums [&_td]:px-3 [&_td]:py-2">
                <caption className="sr-only">当前筛选下的用户合约持仓</caption>
                <thead className="sticky top-0 z-10 bg-card">
                  <tr>
                    {headers.map(h => (
                      <th scope="col" className="border-b px-3 py-2" key={h}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map(p => (
                    <tr key={p.userId + ":" + p.symbol} className="border-b">
                      <th
                        scope="row"
                        className="sticky left-0 bg-card px-3 py-2"
                      >
                        {p.groupName || p.username}
                        <small className="block font-normal text-muted-foreground">
                          @{p.username} · #{p.userId}
                        </small>
                      </th>
                      <td>{p.symbol}</td>
                      <td>
                        {p.side === "long" ? "多" : "空"} · {p.leverage}×
                      </td>
                      <td>
                        {coin(p.quantityAtoms)} {baseCoin(p.symbol)}
                      </td>
                      <td>{sim(p.marginUnits)}</td>
                      <td>{sim(p.entryPriceUnits)}</td>
                      <td>
                        {p.markPriceUnits !== null
                          ? sim(p.markPriceUnits)
                          : "待估值"}
                        {p.markAt !== null && (
                          <small className="block text-muted-foreground">
                            {stamp(p.markAt)}
                          </small>
                        )}
                      </td>
                      <td>
                        {p.pnlUnits !== null ? signed(p.pnlUnits) : "待估值"}
                      </td>
                      <td>
                        {p.liquidationPriceUnits
                          ? sim(p.liquidationPriceUnits)
                          : "—"}
                      </td>
                      <td>{stamp(p.openedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="py-5 text-center text-muted-foreground">
              当前没有符合条件的未平仓合约。
            </p>
          )}
          <Pager
            page={data.page}
            total={data.total}
            totalPages={data.totalPages}
            pageSize={data.pageSize}
            onPage={setPage}
            onPageSize={n => {
              setSize(n);
              setPage(1);
            }}
            unit="笔持仓"
          />
        </>
      )}
    </section>
  );
}
