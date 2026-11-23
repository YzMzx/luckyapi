import { useState } from "react";
import { Pager } from "@/components/Pager";
import { usePerpPresence } from "./usePerpPresence";
import { trpc } from "@/providers/trpc";
import { button, day, input, panel, signed, stamp } from "./format";
import { Table } from "./shared";

const weekBatch = 26;
export default function PerpBoard({ userId }: { userId: number }) {
  usePerpPresence(true);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(0);
  const [side, setSide] = useState<"profit" | "loss">("profit");
  const [page, setPage] = useState(1);
  const list = trpc.perps.weeks.useQuery({ limit: weekBatch, offset });
  const week =
    list.data?.weeks.find(w => w.weekStart === selected) ?? list.data?.weeks[0];
  const board = trpc.perps.weekBoard.useQuery(
    { weekStart: week?.weekStart ?? 0, side, page, pageSize: 20 },
    { enabled: !!week }
  );
  const changeBatch = (next: number) => {
    setSelected(0);
    setPage(1);
    setOffset(next);
  };
  const data = board.data;
  return (
    <section className={panel} aria-label="历史周结算排名">
      {list.data?.pendingWeek != null && (
        <p className="mb-4 rounded-lg bg-[#182b3c] p-3 text-sm">
          有历史周正在等待结算。
        </p>
      )}
      {list.error && (
        <p role="alert">
          周列表读取失败：{list.error.message}{" "}
          <button className={button} onClick={() => list.refetch()}>
            重试
          </button>
        </p>
      )}
      {list.isLoading && <p>正在读取历史周…</p>}
      {list.data && !week && <p>尚无已结算的周榜。</p>}
      {week && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="settled-contract-week">已结算周</label>
              <select
                id="settled-contract-week"
                className={input}
                value={week.weekStart}
                onChange={e => {
                  setSelected(Number(e.target.value));
                  setPage(1);
                }}
              >
                {list.data?.weeks.map(w => (
                  <option key={w.weekStart} value={w.weekStart}>
                    {day(w.weekStart)} – {day(w.weekEnd - 1)}
                  </option>
                ))}
              </select>
            </div>
            {!!offset && (
              <button
                className={button}
                onClick={() => changeBatch(Math.max(0, offset - weekBatch))}
              >
                更新的周
              </button>
            )}
            {list.data && offset + weekBatch < list.data.total && (
              <button
                className={button}
                onClick={() => changeBatch(offset + weekBatch)}
              >
                更早的周
              </button>
            )}
          </div>
          <div className="my-5 flex gap-2">
            {(["profit", "loss"] as const).map(s => (
              <button
                key={s}
                className={button + (s === side ? " bg-[#FFB700]/15" : "")}
                aria-pressed={s === side}
                onClick={() => {
                  setSide(s);
                  setPage(1);
                }}
              >
                {s === "profit" ? "盈利榜" : "亏损榜"}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            归档于 {stamp(week.publishedAt)}
          </p>
          {board.error ? (
            <p role="alert">
              榜单读取失败：{board.error.message}{" "}
              <button className={button} onClick={() => board.refetch()}>
                重试
              </button>
            </p>
          ) : board.isLoading ? (
            <p>读取名次中…</p>
          ) : data ? (
            <>
              <p className="mt-4 rounded-lg bg-[#182b3c] p-3 text-sm">
                我的当周成绩
                {data.mine ? (
                  <>
                    <strong>{signed(data.mine.pnlUnits)} 模拟金</strong>
                    {data.mine.rank != null
                      ? (data.mine.pnlUnits > 0 ? "盈利榜" : "亏损榜") +
                        "第 " +
                        data.mine.rank +
                        " 名"
                      : "持平"}
                  </>
                ) : (
                  "无记录"
                )}
              </p>
              {data.rows.length ? (
                <Table
                  title={side === "profit" ? "当周盈利榜" : "当周亏损榜"}
                  columns={["名次", "玩家", "当周盈亏（模拟金）"]}
                >
                  {data.rows.map(r => (
                    <tr key={r.userId}>
                      <td>{r.rank}</td>
                      <td>
                        {r.displayName}
                        {r.userId === userId ? "（我）" : ""}
                      </td>
                      <td>{signed(r.pnlUnits)}</td>
                    </tr>
                  ))}
                </Table>
              ) : (
                <p className="my-5">
                  {side === "profit" ? "该周无人盈利。" : "该周无人亏损。"}
                </p>
              )}
              <Pager
                page={data.page}
                totalPages={Math.max(1, Math.ceil(data.total / data.pageSize))}
                total={data.total}
                pageSize={data.pageSize}
                onPage={setPage}
                className="mt-4"
              />
            </>
          ) : (
            <p>该周榜单暂未发布。</p>
          )}
        </>
      )}
    </section>
  );
}
