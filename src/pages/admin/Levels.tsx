import { Link } from "react-router";
import { LEVEL_STAGES, MAX_LEVEL, getLevelThreshold } from "@contracts/levels";
import { StagePlate } from "@/components/StagePlate";
import { trpc } from "@/providers/trpc";

export default function AdminLevels() {
  const hall = trpc.admin.levels.hall.useQuery();
  return (
    <div className="space-y-5">
      <section className="admin-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold">限定铭牌席位</h2>
          <Link to="/admin/users" className="admin-secondary px-3 py-2 text-sm">
            查看会员等级
          </Link>
        </div>
        {hall.isError ? (
          <p role="alert" className="mt-4">
            铭牌记录加载失败。{" "}
            <button className="underline" onClick={() => void hall.refetch()}>
              重试
            </button>
          </p>
        ) : hall.data ? (
          <div className="mt-4 space-y-3">
            {LEVEL_STAGES.map(stage => (
              <section
                key={stage.level}
                className="rounded-xl border border-border p-4"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <h3>
                    <StagePlate {...stage} />
                  </h3>
                  <span className="text-sm">
                    Lv.{stage.level} ·{" "}
                    {getLevelThreshold(stage.level).toLocaleString()} EXP
                  </span>
                </div>
                <ol className="mt-3 grid gap-2 sm:grid-cols-3">
                  {[1, 2, 3].map(rank => {
                    const seat = hall.data.find(
                      item => item.level === stage.level && item.rank === rank
                    );
                    return (
                      <li
                        className="min-w-0 rounded border border-border p-2 text-sm"
                        key={rank}
                      >
                        <strong>No.{rank}</strong> ·{" "}
                        <span className="break-all">
                          {seat?.userName ?? "虚位以待"}
                        </span>
                        {seat && (
                          <time
                            className="block text-xs text-muted-foreground"
                            dateTime={new Date(seat.awardedAt).toISOString()}
                          >
                            {new Date(seat.awardedAt).toLocaleString("zh-CN")}
                          </time>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </div>
        ) : (
          <p role="status" className="mt-4">
            正在加载铭牌记录…
          </p>
        )}
      </section>
      <details className="admin-panel p-5">
        <summary className="cursor-pointer font-bold">
          等级经验表 · Lv.1 至 Lv.{MAX_LEVEL}
        </summary>
        <table className="mt-4 w-full text-right text-sm">
          <caption className="sr-only">等级经验门槛</caption>
          <thead>
            <tr>
              <th scope="col" className="text-left">
                站内等级
              </th>
              <th scope="col">累计 EXP</th>
              <th scope="col">升下一级所需 EXP</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: MAX_LEVEL }, (_, index) => {
              const level = index + 1;
              const total = getLevelThreshold(level);
              return (
                <tr key={level} className="border-t border-border">
                  <th scope="row" className="py-1 text-left">
                    Lv.{level}
                  </th>
                  <td>{total.toLocaleString()}</td>
                  <td>
                    {level === MAX_LEVEL
                      ? "已满级"
                      : (getLevelThreshold(level + 1) - total).toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </div>
  );
}
