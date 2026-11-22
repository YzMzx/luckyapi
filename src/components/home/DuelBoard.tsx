import { useState } from "react";
import { Link } from "react-router";
import { Trophy, TrendingDown } from "lucide-react";
import { RankingIdentity } from "@/components/RankingIdentity";
import { trpc } from "@/providers/trpc";
import { cn } from "@/lib/utils";

const fmtSigned = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;

/**
 * 决斗风云榜（首页 Top3 预览）：赢家榜 / 逆风榜双标签，数据来自 trpc.duel.leaderboard。
 * 完整榜单（周期/玩法筛选、Top20、我的排名）在 /arena/leaderboard。
 */
export function DuelBoard({ enabled }: { enabled: boolean }) {
  const [tab, setTab] = useState<"winners" | "losers">("winners");
  const board = tab === "winners" ? "winner" : "loser";
  const q = trpc.duel.leaderboard.useQuery(
    { board, period: "all", game: "all", page: 1 },
    { enabled, staleTime: 60_000 },
  );
  const rows = q.data?.rows.slice(0, 3) ?? [];

  return (
    <div className="card-luxe light-sweep rounded-2xl p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-bold text-[#fce1b6]">
          <Trophy className="h-4 w-4 text-[#FFB700]" /> 决斗风云榜
        </h3>
        <div className="flex rounded-lg border border-border p-0.5 text-xs font-bold">
          {([
            ["winners", "赢家榜", Trophy],
            ["losers", "逆风榜", TrendingDown],
          ] as const).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                "flex items-center gap-1 rounded-md px-3 py-1.5 transition-colors",
                tab === key ? "bg-[#FFB700]/15 text-[#FFB700]" : "text-muted-foreground hover:text-[#fce1b6]",
              )}
            >
              <Icon className="h-3 w-3" /> {label}
            </button>
          ))}
        </div>
      </div>

      {!enabled ? (
        <div className="mt-4 rounded-lg border border-dashed border-[#af915f]/40 px-4 py-8 text-center">
          <p className="text-sm font-bold text-[#fce1b6]">登录后查看风云榜</p>
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">赢家榜 / 逆风榜按税后净输赢排行，展示群内名称、等级铭牌与战绩</p>
          <a href={`/api/oauth/login?origin=${encodeURIComponent(window.location.origin)}`} className="mt-4 inline-block text-xs font-bold text-[#FFB700] hover:underline">使用 LINUX DO 登录 →</a>
        </div>
      ) : q.isLoading ? (
        <div className="mt-4 space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg border border-border/60 bg-[#101d2b]/70" />
          ))}
        </div>
      ) : q.isError ? (
        <div className="mt-4 rounded-lg border border-[#EF5459]/40 bg-[#101d2b]/70 px-4 py-7 text-center">
          <p className="text-sm font-bold text-[#EF5459]">风云榜加载失败</p>
          <button onClick={() => q.refetch()} className="mt-2 text-xs font-bold text-[#FFB700] hover:underline">重试</button>
        </div>
      ) : rows.length ? (
        <ol className="mt-4 space-y-2">
          {rows.map((row) => (
            <li key={row.rank} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg border border-border/60 bg-[#101d2b]/70 px-3 py-2.5">
              <span className="rank-medal font-num flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-black">{row.rank}</span>
              <RankingIdentity name={row.groupName} badge={row.badge} className="text-sm font-bold text-[#fce1b6]" />
              <span className="flex flex-col items-end gap-1">
                <span className="text-[10px] text-muted-foreground">{row.wins} 胜 {row.losses} 负</span>
                <span className={cn("font-num text-sm font-black", row.net >= 0 ? "text-[#00B77D]" : "text-[#EF5459]")}>
                  {fmtSigned(row.net)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-[#af915f]/40 px-4 py-8 text-center">
          <p className="text-sm font-bold text-[#fce1b6]">首季风云虚位以待</p>
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
            完成任意一场决斗对局后即可上榜；按税后{tab === "winners" ? "净收益" : "净亏损"}排行
          </p>
        </div>
      )}

      <Link to="/arena/leaderboard" className="mt-4 block text-center text-xs font-bold text-[#FFB700] hover:underline">
        查看完整榜单，争夺榜首 →
      </Link>
    </div>
  );
}
