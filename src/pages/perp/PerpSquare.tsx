import { useState } from "react";
import { Link } from "react-router";
import { useMe } from "@/hooks/useMe";
import { SiteNav } from "@/components/SiteNav";
import { Pager } from "@/components/Pager";
import { trpc } from "@/providers/trpc";
import { baseCoin, button, coin, sim, panel } from "./format";
import { Table } from "./shared";
import { usePerpPresence } from "./usePerpPresence";

export default function PerpSquare() {
  const { user, isLoading } = useMe({
    requireAuth: true,
    requireOnboarded: true,
  });
  const [onlineOnly, setOnline] = useState(false),
    [page, setPage] = useState(1);
  usePerpPresence(!!user?.onboarded);
  const list = trpc.perps.positionSquare.useQuery(
    { page, pageSize: 20, onlineOnly },
    { enabled: !!user?.onboarded, refetchInterval: 15000, retry: 1 }
  );
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
          <Link className={button} to="/contracts">
            返回合约
          </Link>
        </header>
        <section className={panel}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold">
              玩家持仓
              {list.data && !list.error && (
                <span className="ml-2 text-sm font-normal">
                  在线持仓玩家：{list.data.onlineHolders} 人
                </span>
              )}
            </h2>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={onlineOnly}
                onChange={e => {
                  setOnline(e.target.checked);
                  setPage(1);
                }}
              />
              只看在线玩家
            </label>
          </div>
          {list.isLoading && <p role="status">正在加载…</p>}
          {list.error ? (
            <p role="alert">
              持仓读取失败：{list.error.message}{" "}
              <button className={button} onClick={() => void list.refetch()}>
                重试
              </button>
            </p>
          ) : (
            list.data && (
              <>
                {list.data.items.length ? (
                  <Table
                    title="会员公开持仓"
                    columns={[
                      "玩家",
                      "合约页状态",
                      "合约",
                      "方向 / 杠杆",
                      "数量",
                      "开仓均价（USDT）",
                    ]}
                  >
                    {list.data.items.map(p => (
                      <tr key={JSON.stringify([p.nickname, p.symbol])}>
                        <th className="px-3 py-2" scope="row">
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
                        <td>{p.symbol}</td>
                        <td>
                          {p.side === "long" ? "多" : "空"} · {p.leverage}×
                        </td>
                        <td>
                          {coin(p.quantityAtoms)} {baseCoin(p.symbol)}
                        </td>
                        <td>{sim(p.entryPriceUnits)}</td>
                      </tr>
                    ))}
                  </Table>
                ) : (
                  <p className="py-5 text-sm text-muted-foreground">
                    {onlineOnly ? "暂无在线玩家持仓。" : "目前还没有公开持仓。"}
                  </p>
                )}
                <Pager
                  className="mt-4"
                  page={list.data.page}
                  pageSize={list.data.pageSize}
                  totalPages={list.data.totalPages}
                  total={list.data.total}
                  onPage={setPage}
                  unit="笔持仓"
                />
              </>
            )
          )}
        </section>
      </main>
    </div>
  );
}
