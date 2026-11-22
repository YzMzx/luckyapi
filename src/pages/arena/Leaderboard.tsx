import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Trophy, TrendingDown, ChevronLeft, Loader2 } from "lucide-react";
import { useMe } from "@/hooks/useMe";
import { SiteNav } from "@/components/SiteNav";
import { RankingBadge, RankingIdentity } from "@/components/RankingIdentity";
import { trpc } from "@/providers/trpc";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

type Board = "winner" | "loser";
type Period = "today" | "week" | "month" | "all";
type Game = "all" | "dice" | "blackjack";

const BOARD_LABEL: Record<Board, string> = { winner: "赢家榜", loser: "逆风榜" };
const PERIOD_LABEL: Record<Period, string> = { today: "今天", week: "本周", month: "本月", all: "全部" };
const GAME_FILTER_LABEL: Record<Game, string> = { all: "全部玩法", dice: "幸运骰子", blackjack: "二十一点" };

const fmtSigned = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;

/** 决斗风云榜：赢家榜 / 逆风榜，周期与玩法筛选，Top20 分页，我的排名 */
export default function ArenaLeaderboard() {
  const { user, isLoading } = useMe();
  const [searchParams] = useSearchParams();
  const [board, setBoard] = useState<Board>(searchParams.get("board") === "loser" ? "loser" : "winner");
  const requestedPeriod = searchParams.get("period");
  const [period, setPeriod] = useState<Period>(requestedPeriod === "today" || requestedPeriod === "month" || requestedPeriod === "all" ? requestedPeriod : "week");
  const [game, setGame] = useState<Game>("all");
  const [page, setPage] = useState(1);

  const q = trpc.duel.leaderboard.useQuery(
    { board, period, game, page },
    { enabled: !!user?.onboarded },
  );

  if (isLoading) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;

  // 未登录 / 未入驻：页面内引导，不硬跳转
  if (!user?.onboarded) {
    return (
      <div className="min-h-screen">
        <SiteNav user={user} />
        <main className="mx-auto max-w-md px-4 py-24">
          <div className="rise-in rounded-xl border border-border bg-[#101d2b] p-8 text-center">
            <Trophy className="mx-auto h-8 w-8 text-[#FFB700]" />
            <p className="mt-4 text-lg font-bold text-[#fce1b6]">决斗风云榜</p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {user ? "完成入驻后即可查看榜单并参与排名" : "登录后查看赢家榜 / 逆风榜，展示群内名称、等级铭牌与战绩"}
            </p>
            {user ? (
              <Link to="/onboarding" className="btn-3d mt-6 inline-block rounded-lg bg-[#FFB700] px-8 py-2.5 text-sm font-black text-[#162638]">
                完成入驻
              </Link>
            ) : (
              <a href={`/api/oauth/login?origin=${encodeURIComponent(window.location.origin)}`} className="btn-3d mt-6 inline-block rounded-lg bg-[#FFB700] px-8 py-2.5 text-sm font-black text-[#162638]">
                使用 LINUX DO 登录
              </a>
            )}
          </div>
        </main>
      </div>
    );
  }

  const switchBoard = (b: Board) => { setBoard(b); setPage(1); };
  const switchPeriod = (p: Period) => { setPeriod(p); setPage(1); };
  const switchGame = (g: Game) => { setGame(g); setPage(1); };

  const data = q.data;
  const mine = data?.mine;

  const filterBtn = (active: boolean) =>
    cn(
      "whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors",
      active ? "border-[#FFB700] bg-[#FFB700]/10 text-[#FFB700]" : "border-border text-muted-foreground hover:text-[#fce1b6]",
    );

  return (
    <div className="min-h-screen">
      <SiteNav user={user} />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <div className="rise-in text-center">
          <p className="text-xs font-bold tracking-[0.5em] text-[#af915f]">ARENA HALL OF FAME</p>
          <h1 className="mt-2 text-3xl font-black"><span className="text-outline">决斗风云榜</span></h1>
          <p className="mt-2 text-xs text-muted-foreground">
            按{data?.metric ?? "税后净收益"}排行 · 展示群内名称、等级铭牌与战绩，不展示余额
          </p>
        </div>

        {/* 榜单切换 */}
        <div className="rise-in rise-in-1 mt-8 flex justify-center">
          <div className="flex rounded-xl border border-border bg-[#101d2b] p-1 text-sm font-bold">
            {(["winner", "loser"] as const).map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => switchBoard(b)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-6 py-2 transition-colors",
                  board === b ? "bg-[#FFB700]/15 text-[#FFB700]" : "text-muted-foreground hover:text-[#fce1b6]",
                )}
              >
                {b === "winner" ? <Trophy className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                {BOARD_LABEL[b]}
              </button>
            ))}
          </div>
        </div>

        {/* 筛选 */}
        <div className="rise-in rise-in-2 mt-4 flex flex-wrap items-center justify-center gap-2">
          {(["today", "week", "month", "all"] as const).map((p) => (
            <button key={p} type="button" onClick={() => switchPeriod(p)} className={filterBtn(period === p)}>{PERIOD_LABEL[p]}</button>
          ))}
          <span className="mx-1 hidden h-4 w-px bg-border sm:inline-block" />
          {(["all", "dice", "blackjack"] as const).map((g) => (
            <button key={g} type="button" onClick={() => switchGame(g)} className={filterBtn(game === g)}>
              {GAME_FILTER_LABEL[g]}
            </button>
          ))}
        </div>

        {/* 我的排名 */}
        {mine && (
          <div className={cn(
            "rise-in rise-in-2 mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4",
            mine.isRanked ? "border-[#FFB700]/50 bg-[#FFB700]/5" : "border-border bg-[#101d2b]",
          )}>
            <div className="flex items-center gap-3">
              <Avatar className="h-9 w-9 border border-[#af915f]/50">
                {mine.avatarUrl && <AvatarImage src={mine.avatarUrl} />}
                <AvatarFallback className="bg-[#1d3145] text-xs text-[#fce1b6]">{(mine.groupName ?? "我").slice(0, 1)}</AvatarFallback>
              </Avatar>
              <div>
                <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-[#fce1b6]">
                  我的排名
                  {mine.isRanked && <span className="font-num text-[#FFB700]">#{mine.rank}</span>}
                  <RankingBadge badge={mine.badge} />
                </p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {mine.isRanked ? `${mine.wins} 胜 ${mine.losses} 负 · 胜率 ${mine.winRatePercent}%` : mine.reason}
                </p>
              </div>
            </div>
            <span className={cn("font-num text-lg font-black", mine.net > 0 ? "text-[#00B77D]" : mine.net < 0 ? "text-[#EF5459]" : "text-muted-foreground")}>
              {fmtSigned(mine.net)}
            </span>
          </div>
        )}

        {/* 榜单 */}
        <section className="rise-in rise-in-3 mt-6 rounded-xl border border-border bg-[#101d2b] p-4 sm:p-6">
          {q.isLoading ? (
            <p className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 榜单加载中…
            </p>
          ) : q.isError ? (
            <div className="py-14 text-center">
              <p className="text-sm text-muted-foreground">榜单加载失败：{q.error.message}</p>
              <button onClick={() => q.refetch()} className="mt-3 text-xs font-bold text-[#FFB700] hover:underline">重试</button>
            </div>
          ) : !data?.rows.length ? (
            <div className="py-14 text-center">
              <p className="text-sm font-bold text-[#fce1b6]">虚位以待</p>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {PERIOD_LABEL[period]} · {GAME_FILTER_LABEL[game]} 还没有符合上榜条件的已结算对局
              </p>
              <Link to="/arena" className="btn-3d mt-5 inline-block rounded-lg bg-[#FFB700] px-8 py-2.5 text-sm font-black text-[#162638]">
                去开一局
              </Link>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="pb-2 pr-3 font-medium">名次</th>
                      <th className="pb-2 pr-3 font-medium">玩家</th>
                      <th className="pb-2 pr-3 font-medium">战绩</th>
                      <th className="pb-2 pr-3 font-medium text-right">胜率</th>
                      <th className="pb-2 font-medium text-right">{data.metric}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr key={row.rank} className="border-b border-border/50 last:border-0">
                        <td className="py-2.5 pr-3">
                          {row.rank <= 3 ? (
                            <span className="rank-medal font-num flex h-6 w-6 items-center justify-center rounded-full text-xs font-black">{row.rank}</span>
                          ) : (
                            <span className="font-num px-1.5 text-muted-foreground">{row.rank}</span>
                          )}
                        </td>
                        <td className="py-2.5 pr-3">
                          <span className="flex items-center gap-2">
                            <Avatar className="h-6 w-6 border border-[#af915f]/40">
                              {row.avatarUrl && <AvatarImage src={row.avatarUrl} />}
                              <AvatarFallback className="bg-[#1d3145] text-[10px] text-[#fce1b6]">{row.groupName.slice(0, 1)}</AvatarFallback>
                            </Avatar>
                            <RankingIdentity name={row.groupName} badge={row.badge} className="max-w-44 font-bold text-[#fce1b6]" />
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 text-muted-foreground">
                          {row.wins} 胜 {row.losses} 负<span className="hidden sm:inline"> · 共 {row.games} 局</span>
                        </td>
                        <td className="font-num py-2.5 pr-3 text-right text-muted-foreground">{row.winRatePercent}%</td>
                        <td className={cn("font-num py-2.5 text-right font-black", row.net >= 0 ? "text-[#00B77D]" : "text-[#EF5459]")}>
                          {fmtSigned(row.net)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.totalPages > 1 && (
                <div className="mt-4 flex items-center justify-center gap-3 text-xs">
                  <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="flex items-center gap-1 rounded border border-border px-3 py-1 disabled:opacity-40">
                    <ChevronLeft className="h-3 w-3" /> 上一页
                  </button>
                  <span className="font-num text-muted-foreground">{data.page} / {data.totalPages}</span>
                  <button disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)} className="rounded border border-border px-3 py-1 disabled:opacity-40">下一页</button>
                </div>
              )}
              <p className="mt-4 text-center text-[10px] leading-4 text-muted-foreground/70">
                {data.interval && `统计区间 ${new Date(data.interval.start).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 起（${data.timezone}） · `}
                {data.privacy}
              </p>
            </>
          )}
        </section>

        <p className="mt-6 text-center">
          <Link to="/arena" className="text-xs font-bold text-[#FFB700] hover:underline">← 返回决斗场大厅</Link>
        </p>
      </main>
    </div>
  );
}
