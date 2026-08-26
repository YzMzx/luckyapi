import { useState } from "react";
import { useLocation } from "react-router";
import { BanknoteArrowDown, BanknoteArrowUp } from "lucide-react";
import { SiteNav } from "@/components/SiteNav";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useMe } from "@/hooks/useMe";
import { trpc } from "@/providers/trpc";

const PAGE_SIZE = 20;

export default function LoanLeaderboard() {
  const { user, isLoading } = useMe({ requireAuth: true, requireOnboarded: true });
  const { pathname } = useLocation();
  const side = pathname.endsWith("/lending") ? "lender" : "borrower";
  const [page, setPage] = useState(1);
  const query = trpc.finance.loanVolumeLeaderboard.useQuery({ side, page, pageSize: PAGE_SIZE }, { enabled: !!user?.onboarded });
  if (isLoading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;
  const isLending = side === "lender";
  const title = isLending ? "放贷榜" : "借贷榜";
  const Icon = isLending ? BanknoteArrowUp : BanknoteArrowDown;
  return <div className="min-h-screen"><SiteNav user={user} /><main className="mx-auto max-w-4xl px-4 py-10">
    <div className="flex items-center gap-3"><Icon className="h-9 w-9 text-[#FFB700]" /><div><h1 className="text-3xl font-black text-[#fce1b6]">{title}</h1><p className="mt-1 text-sm text-muted-foreground">仅统计已接受且实际放款的合同；等待、拒绝、取消和超时合同不计入。</p></div></div>
    {query.data?.myRank && <div className="mt-6 rounded-xl border border-[#FFB700]/25 bg-[#FFB700]/5 p-4 text-sm">我的排名：第 <b>{query.data.myRank.rank}</b> 名 · 累计本金 <b>${(Number(query.data.myRank.totalPrincipalUnits) / 1_000_000).toFixed(2)}</b> · {query.data.myRank.loanCount} 笔</div>}
    <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-[#101d2b]">
      {query.isLoading ? <p className="py-20 text-center text-sm text-muted-foreground">榜单加载中…</p> : query.error ? <p className="py-20 text-center text-sm text-[#EF5459]">加载失败：{query.error.message}</p> : <div className="divide-y divide-border">{query.data?.items.map((row) => <div key={row.userId} className={`flex items-center gap-3 px-4 py-3 ${row.userId === user.id ? "bg-[#FFB700]/8" : ""}`}><span className="w-10 shrink-0 text-center text-lg font-black text-[#FFB700]">#{row.rank}</span><Avatar className="h-10 w-10 border border-[#af915f]/40"><AvatarImage src={row.avatarUrl ?? undefined} /><AvatarFallback>{(row.groupName || row.username).slice(0, 1)}</AvatarFallback></Avatar><span className="min-w-0 flex-1 truncate font-bold text-[#fce1b6]">{row.groupName || row.username}</span><span className="shrink-0 text-right"><b className="font-num text-[#FFB700]">${(Number(row.totalPrincipalUnits) / 1_000_000).toFixed(2)}</b><br /><span className="text-xs text-muted-foreground">有效 {row.loanCount} 笔</span></span></div>)}{!query.data?.items.length && <p className="py-20 text-center text-sm text-muted-foreground">暂无已放款记录</p>}</div>}
      {(query.data?.totalPages ?? 0) > 1 && <div className="flex items-center justify-center gap-3 border-t border-border p-4"><button type="button" className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><span className="text-sm text-muted-foreground">第 {page} / {query.data?.totalPages ?? 1} 页</span><button type="button" className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40" disabled={page >= (query.data?.totalPages ?? 1)} onClick={() => setPage((value) => value + 1)}>下一页</button></div>}
    </section>
  </main></div>;
}
