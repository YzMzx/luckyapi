import { useEffect } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";
import { useSearchParams } from "react-router";
import { Activity, Banknote, Braces, Crown, Gamepad2, Medal, RefreshCw, Trophy } from "lucide-react";
import { SiteNav } from "@/components/SiteNav";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Pager } from "@/components/Pager";
import { useMe } from "@/hooks/useMe";
import { RankingBadge, RankingIdentity } from "@/components/RankingIdentity";
import { trpc } from "@/providers/trpc";
import { cn } from "@/lib/utils";

const categoryIcons = { overall: Trophy, api: Braces, finance: Banknote, entertainment: Gamepad2 };
type RankingCategory = keyof typeof categoryIcons;
const periodLabels = { today: "今天", week: "本周", month: "本月", all: "全部" } as const;
type RankRow = inferRouterOutputs<AppRouter>["rankings"]["query"]["rows"][number];

function formatMetric(value: number, unit: string) {
  const safeValue = Number.isFinite(value) ? value : 0;
  if (unit === "money") return `$${safeValue.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
  if (unit === "tokens") return `${Math.round(safeValue).toLocaleString("zh-CN")} Token`;
  if (unit === "milliseconds") return `${Math.round(safeValue).toLocaleString("zh-CN")} ms`;
  if (unit === "minutes") return `${safeValue.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 分钟`;
  return Math.round(safeValue).toLocaleString("zh-CN");
}

function PodiumCard({ row, place, unit, me }: { row?: RankRow; place: number; unit: string; me: number }) {
  const height = place === 1 ? "md:pb-9 md:pt-7" : place === 2 ? "md:mt-8 md:pb-6 md:pt-5" : "md:mt-12 md:pb-5 md:pt-4";
  return <div className={cn("relative flex min-h-40 min-w-0 flex-1 flex-col items-center justify-center rounded-2xl border bg-[#101d2b] p-4 text-center shadow-xl", height, row?.userId === me ? "border-[#FFB700] ring-1 ring-[#FFB700]/40" : "border-border")}>
    <span className={cn("absolute left-3 top-3 flex h-8 w-8 items-center justify-center rounded-full font-num text-sm font-black", place === 1 ? "bg-[#FFB700] text-[#162638]" : place === 2 ? "bg-slate-300 text-slate-800" : "bg-amber-700 text-white")}>{place}</span>
    {place === 1 && <Crown className="absolute -top-5 h-8 w-8 text-[#FFB700]" />}
    {row ? <><Avatar className={cn("border-2", place === 1 ? "h-16 w-16 border-[#FFB700]" : "h-14 w-14 border-[#af915f]")}><AvatarImage src={row.avatarUrl} /><AvatarFallback>{(row.displayName || "?").slice(0, 1)}</AvatarFallback></Avatar><RankingIdentity name={row.displayName || "未命名用户"} badge={row.badge} className="mt-3 items-center font-black text-[#fce1b6]" /><p className="mt-1 font-num text-lg font-black text-[#FFB700]">{formatMetric(row.metric, unit)}</p>{row.userId === me && <span className="mt-2 rounded-full bg-[#FFB700]/15 px-2 py-1 text-[10px] font-bold text-[#FFB700]">我的排名</span>}</> : <p className="text-sm text-muted-foreground">虚位以待</p>}
  </div>;
}

export default function Rankings() {
  const { user, isLoading } = useMe({ requireAuth: true, requireOnboarded: true });
  const [params, setParams] = useSearchParams();
  const catalog = trpc.rankings.catalog.useQuery(undefined, { enabled: !!user?.onboarded });
  const rawCategory = params.get("category") ?? "overall";
  const category: RankingCategory = catalog.data?.categories.some((item) => item.key === rawCategory) ? rawCategory as RankingCategory : "overall";
  const categoryBoards = catalog.data?.boards.filter((item) => item.category === category) ?? [];
  const requestedBoard = params.get("board") ?? (category === "overall" ? "balance" : "");
  const board = categoryBoards.some((item) => item.key === requestedBoard) ? requestedBoard : categoryBoards[0]?.key ?? requestedBoard;
  const meta = categoryBoards.find((item) => item.key === board);
  const requestedPeriod = (params.get("period") ?? "week") as keyof typeof periodLabels;
  const period = meta?.periods.includes(requestedPeriod) ? requestedPeriod : meta?.periods[0] ?? "week";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const ranking = trpc.rankings.query.useQuery({ category, board, period, page, pageSize: 20 }, { enabled: !!user?.onboarded && !!meta });
  const update = (next: Record<string, string | number>) => { const copy = new URLSearchParams(params); for (const [key, value] of Object.entries(next)) copy.set(key, String(value)); setParams(copy); };
  useEffect(() => { if (catalog.data && meta && (rawCategory !== category || requestedBoard !== board || requestedPeriod !== period)) update({ category, board, period, page: 1 }); }, [catalog.data, category, board, period]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;
  const podium = ranking.data?.podium ?? [];
  return <div className="min-h-screen"><SiteNav user={user} /><main className="mx-auto max-w-7xl px-4 py-8 sm:py-10">
    <header className="rounded-3xl border border-[#af915f]/30 bg-gradient-to-br from-[#101d2b] via-[#14273a] to-[#101d2b] p-6 shadow-2xl sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-5"><div><p className="text-xs font-bold tracking-[.38em] text-[#af915f]">LUCKY HALL OF FAME</p><h1 className="mt-3 flex items-center gap-3 text-3xl font-black sm:text-4xl"><Trophy className="h-9 w-9 text-[#FFB700]" /><span className="text-outline">榜单中心</span></h1><p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">综合、API、金融和娱乐数据统一排名。所有数值均来自真实成功或已结算记录。</p></div>{ranking.data && <div className="rounded-xl border border-border bg-black/10 px-4 py-3 text-right text-xs text-muted-foreground"><p>更新时间</p><p className="mt-1 font-num text-[#fce1b6]">{new Date(ranking.data.updatedAt).toLocaleString("zh-CN")}</p></div>}</div>
      <div className="mt-7 grid grid-cols-2 gap-2 md:flex">{catalog.data?.categories.map((item) => { const Icon = categoryIcons[item.key] ?? Trophy; const first = catalog.data.boards.find((b) => b.category === item.key); return <button key={item.key} disabled={!first} onClick={() => { if (!first) return; update({ category: item.key, board: first.key, period: first.periods.includes("week") ? "week" : first.periods[0], page: 1 }); }} className={cn("flex items-center justify-center gap-2 rounded-xl border px-5 py-3 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50", category === item.key ? "border-[#FFB700]/60 bg-[#FFB700]/15 text-[#FFB700]" : "border-border bg-[#162638]/70 text-muted-foreground hover:border-[#af915f] hover:text-[#fce1b6]")}><Icon className="h-4 w-4" />{item.label}</button>; })}</div>
    </header>
    <div className="mt-6 grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="self-start rounded-2xl border border-border bg-[#101d2b] p-3 lg:sticky lg:top-28"><p className="px-3 py-2 text-[10px] font-bold tracking-[.2em] text-[#af915f]">选择榜单</p><div className="space-y-1">{categoryBoards.map((item) => <button key={item.key} onClick={() => update({ board: item.key, period: item.periods.includes(period) ? period : item.periods[0], page: 1 })} className={cn("w-full rounded-xl px-3 py-3 text-left transition", board === item.key ? "bg-[#FFB700]/12 text-[#FFB700]" : "text-muted-foreground hover:bg-white/5 hover:text-[#fce1b6]")}><span className="block text-sm font-black">{item.title}</span><span className="mt-1 block text-[11px] leading-4 opacity-75">{item.description}</span></button>)}</div></aside>
      <section className="min-w-0 space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-bold text-[#af915f]">{catalog.data?.categories.find((c) => c.key === category)?.label}榜单</p><h2 className="mt-1 text-2xl font-black text-[#fce1b6]">{meta?.title ?? "加载中"}</h2><p className="mt-1 text-xs text-muted-foreground">{meta?.description}</p></div><div className="flex rounded-xl border border-border bg-[#101d2b] p-1">{meta?.periods.map((key) => <button key={key} onClick={() => update({ period: key, page: 1 })} className={cn("rounded-lg px-3 py-2 text-xs font-bold", period === key ? "bg-[#FFB700]/15 text-[#FFB700]" : "text-muted-foreground hover:text-[#fce1b6]")}>{periodLabels[key as keyof typeof periodLabels] ?? key}</button>)}</div></div>
        {catalog.error ? <div className="flex min-h-80 flex-col items-center justify-center rounded-2xl border border-[#EF5459]/30 bg-[#101d2b] px-5 text-center"><p className="text-[#EF5459]">{catalog.error.message || "榜单目录加载失败"}</p><button onClick={() => catalog.refetch()} className="mt-4 flex items-center gap-2 rounded-lg bg-[#FFB700] px-4 py-2 text-sm font-black text-[#162638]"><RefreshCw className="h-4 w-4" />重试</button></div> : catalog.isLoading || !catalog.data || ranking.isLoading ? <div className="flex min-h-96 items-center justify-center rounded-2xl border border-border bg-[#101d2b] text-sm text-muted-foreground"><Activity className="mr-2 h-5 w-5 animate-pulse" />榜单聚合中…</div> : ranking.error ? <div className="flex min-h-80 flex-col items-center justify-center rounded-2xl border border-[#EF5459]/30 bg-[#101d2b] px-5 text-center"><p className="text-[#EF5459]">{ranking.error.message}</p><button onClick={() => ranking.refetch()} className="mt-4 flex items-center gap-2 rounded-lg bg-[#FFB700] px-4 py-2 text-sm font-black text-[#162638]"><RefreshCw className="h-4 w-4" />重试</button></div> : ranking.data ? <>
          <div className="grid gap-3 md:grid-cols-3 md:items-end"><PodiumCard row={podium[1]} place={2} unit={ranking.data.board.unit} me={user.id} /><PodiumCard row={podium[0]} place={1} unit={ranking.data.board.unit} me={user.id} /><PodiumCard row={podium[2]} place={3} unit={ranking.data.board.unit} me={user.id} /></div>
          {ranking.data?.myRank && <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#FFB700]/40 bg-[#FFB700]/8 px-5 py-4"><div className="flex items-center gap-3"><Medal className="h-6 w-6 text-[#FFB700]" /><div><p className="text-xs text-muted-foreground">我的排名</p><p className="font-black text-[#fce1b6]">第 {ranking.data.myRank.rank} 名</p></div><RankingBadge badge={ranking.data.myRank.badge} /></div><p className="font-num text-xl font-black text-[#FFB700]">{formatMetric(ranking.data.myRank.metric, ranking.data.board.unit)}</p></div>}
          <div className="overflow-hidden rounded-2xl border border-border bg-[#101d2b]"><div className="hidden grid-cols-[5rem_minmax(0,1fr)_10rem_7rem] border-b border-border px-5 py-3 text-xs font-bold text-muted-foreground sm:grid"><span>排名</span><span>玩家</span><span className="text-right">成绩</span><span className="text-right">记录数</span></div>{ranking.data.rows.map((row) => <div key={row.userId} className={cn("grid gap-3 border-b border-border/70 px-4 py-4 last:border-0 sm:grid-cols-[5rem_minmax(0,1fr)_10rem_7rem] sm:items-center sm:px-5", row.userId === user.id && "bg-[#FFB700]/8")}><div className="flex items-center justify-between sm:block"><span className={cn("font-num text-lg font-black", row.rank <= 3 ? "text-[#FFB700]" : "text-muted-foreground")}>#{row.rank}</span><span className="text-xs text-muted-foreground sm:hidden">记录 {row.detail}</span></div><div className="flex min-w-0 items-center gap-3"><Avatar className="h-9 w-9 border border-[#af915f]/40"><AvatarImage src={row.avatarUrl} /><AvatarFallback>{(row.displayName || "?").slice(0, 1)}</AvatarFallback></Avatar><RankingIdentity name={row.displayName || "未命名用户"} badge={row.badge} className="text-sm font-bold text-[#fce1b6]" />{row.userId === user.id && <span className="shrink-0 rounded bg-[#FFB700]/15 px-1.5 py-0.5 text-[10px] text-[#FFB700]">我</span>}</div><p className="font-num text-right font-black text-[#FFB700]">{formatMetric(row.metric, ranking.data.board.unit)}</p><p className="hidden text-right font-num text-xs text-muted-foreground sm:block">{Number.isFinite(row.detail) ? row.detail.toLocaleString("zh-CN") : "0"}</p></div>)}{!ranking.data.rows.length && <div className="py-20 text-center text-sm text-muted-foreground">当前周期暂无符合条件的上榜记录</div>}</div>
          {ranking.data && <Pager page={ranking.data.page} totalPages={ranking.data.totalPages} total={ranking.data.total} pageSize={ranking.data.pageSize} onPage={(next) => update({ page: next })} onPageSize={() => {}} />}
        </> : <div className="flex min-h-80 flex-col items-center justify-center rounded-2xl border border-[#EF5459]/30 bg-[#101d2b] px-5 text-center"><p className="text-[#EF5459]">榜单返回数据不完整，请重试</p><button onClick={() => ranking.refetch()} className="mt-4 flex items-center gap-2 rounded-lg bg-[#FFB700] px-4 py-2 text-sm font-black text-[#162638]"><RefreshCw className="h-4 w-4" />重试</button></div>}
      </section>
    </div>
  </main></div>;
}
