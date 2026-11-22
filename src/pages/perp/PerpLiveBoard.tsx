import { useState } from "react";
import { Link } from "react-router";
import { Pager } from "@/components/Pager";
import { SiteNav } from "@/components/SiteNav";
import { useMe } from "@/hooks/useMe";
import { trpc } from "@/providers/trpc";
import { button, panel, signed, stamp } from "./format";
import { Table } from "./shared";
import { usePerpPresence } from "./usePerpPresence";

const pnlColor = (units: number) =>
  units > 0 ? "text-emerald-300" : units < 0 ? "text-rose-300" : "";

export default function PerpLiveBoard() {
  const { user, isLoading } = useMe({
    requireAuth: true,
    requireOnboarded: true,
  });
  const enabled = !!user?.onboarded;
  usePerpPresence(enabled);
  const [page, setPage] = useState(1);
  const board = trpc.perps.liveBoard.useQuery(
    { page, pageSize: 20 },
    { enabled, refetchInterval: 5000, retry: 1 }
  );
  const data = board.data;
  const mine = data?.mine;

  if (isLoading || !user?.onboarded)
    return <p className="p-8 text-center">正在读取账户…</p>;

  return (
    <div className="min-h-screen" lang="zh-CN">
      <title>合约实时盈亏榜 | Lucky Draw API 分发站</title>
      <SiteNav user={user} />
      <main className="mx-auto max-w-4xl space-y-5 px-4 py-8">
        <header className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-3xl font-black text-[#fce1b6]">
              合约实时盈亏榜
            </h1>
            <nav aria-label="合约相关页面" className="flex flex-wrap gap-2">
              <Link className={button} to="/contracts">
                返回合约
              </Link>
              <Link className={button} to="/contracts/square">
                持仓广场
              </Link>
            </nav>
          </div>
          <p className="text-sm text-muted-foreground">
            只统计玩家当前所有未平仓合约，按 Bybit
            标记价格估算浮动盈亏后汇总，不计已实现盈亏、交易手续费和资金费。任一持仓无法估值时，该玩家暂不入榜，也不显示部分合计。
          </p>
        </header>

        <section className={panel + " space-y-4"}>
          <h2 className="text-lg font-bold">实时排名</h2>
          <p className="text-xs text-muted-foreground">
            按浮动盈亏从高到低排序，盈亏为 0 也入榜。每 5 秒刷新。
            {data && (
              <>
                榜单更新于{" "}
                <time dateTime={new Date(data.updatedAt).toISOString()}>
                  {stamp(data.updatedAt)}
                </time>
                （北京时间）
              </>
            )}
          </p>
          {board.error && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <p role="alert">
                榜单读取失败：{board.error.message}
                {data && "。下方为上次成功读取的榜单。"}
              </p>
              <button
                type="button"
                className={button}
                onClick={() => void board.refetch()}
              >
                重试
              </button>
            </div>
          )}
          {board.isLoading && <p>正在读取名次…</p>}
          {data && (
            <>
              {data.pendingPlayers > 0 && (
                <p className="rounded-lg bg-[#182b3c] px-3 py-2 text-sm">
                  {data.pendingPlayers} 位玩家待估值，暂未列入榜单。
                </p>
              )}
              <section className="rounded-lg border border-border bg-[#162638] p-3">
                <h3 className="mb-1 text-sm font-bold">我的实时盈亏</h3>
                {mine ? (
                  <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm tabular-nums">
                    {mine.pnlUnits === null ? (
                      <strong>待估值</strong>
                    ) : (
                      <>
                        <strong className={pnlColor(mine.pnlUnits)}>
                          {signed(mine.pnlUnits)} 模拟金
                          {mine.pnlUnits === 0 && "（持平）"}
                        </strong>
                        {mine.rank !== null && <span>第 {mine.rank} 名</span>}
                      </>
                    )}
                    <span>持仓 {mine.positionCount} 笔</span>
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    暂无未平仓合约。
                  </p>
                )}
              </section>
              {data.rows.length ? (
                <>
                  <Table
                    title="实时浮动盈亏排名"
                    columns={["名次", "玩家", "浮动盈亏（模拟金）", "持仓数"]}
                  >
                    {data.rows.map(row => (
                      <tr
                        key={row.nickname}
                        className={row.mine ? "bg-[#FFB700]/10" : undefined}
                      >
                        <td>{row.rank}</td>
                        <th
                          scope="row"
                          className="whitespace-normal px-3 py-2 font-medium [overflow-wrap:anywhere]"
                        >
                          {row.nickname}
                          {row.mine && "（我）"}
                        </th>
                        <td className={pnlColor(row.pnlUnits)}>
                          {signed(row.pnlUnits)}
                        </td>
                        <td>{row.positionCount}</td>
                      </tr>
                    ))}
                  </Table>
                  <Pager
                    page={data.page}
                    pageSize={data.pageSize}
                    totalPages={data.totalPages}
                    total={data.total}
                    onPage={setPage}
                    unit="位玩家"
                  />
                </>
              ) : (
                <p className="py-3 text-sm text-muted-foreground">
                  当前暂无可估值持仓排名。
                </p>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
