import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useMe } from "@/hooks/useMe";
import { SiteNav } from "@/components/SiteNav";
import { Pager } from "@/components/Pager";
import { cn } from "@/lib/utils";
import { Link } from "react-router";
import { Flag } from "lucide-react";

const DIRECTIONS = [
  { v: "all", label: "全部" },
  { v: "out", label: "我举报的" },
  { v: "in", label: "举报我的" },
] as const;

export default function Reports() {
  const { user, isLoading } = useMe({ requireAuth: true, requireOnboarded: true });
  const [direction, setDirection] = useState<"all" | "out" | "in">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const records = trpc.member.myReportsPage.useQuery(
    { page, pageSize, direction },
    { enabled: !!user?.onboarded },
  );

  if (isLoading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;

  return (
    <div className="min-h-screen">
      <SiteNav user={user} />
      <main className="mx-auto max-w-3xl px-4 py-12">
        <div className="rise-in flex flex-wrap items-end justify-between gap-4">
          <div>
          <p className="text-xs font-bold tracking-[0.5em] text-[#af915f]">REPORT LOG</p>
          <h1 className="mt-2 text-4xl font-black"><span className="text-outline">举报记录</span></h1>
          <p className="mt-3 text-xs text-muted-foreground">你举报别人的，和别人举报你的，都在这里。</p>
          </div>
          <Link to="/report" className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#EF5459] px-5 py-2.5 text-sm font-black text-white transition hover:bg-[#d94449] sm:w-auto"><Flag className="h-4 w-4" />发起举报</Link>
        </div>

        <div className="rise-in mt-6 flex gap-2">
          {DIRECTIONS.map((d) => (
            <button
              key={d.v}
              onClick={() => { setDirection(d.v); setPage(1); }}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
                direction === d.v ? "bg-[#FFB700] text-[#162638]" : "border border-border text-muted-foreground hover:text-[#fce1b6]",
              )}
            >
              {d.label}
            </button>
          ))}
        </div>

        <div className="rise-in rise-in-1 mt-4 overflow-hidden rounded-xl border border-border">
          {records.isLoading ? (
            <p className="bg-[#101d2b] py-16 text-center text-sm text-muted-foreground">加载举报记录中…</p>
          ) : records.error ? (
            <div className="bg-[#101d2b] py-12 text-center"><p className="text-sm font-bold text-[#EF5459]">举报记录加载失败：{records.error.message}</p><button onClick={() => records.refetch()} className="mt-3 text-xs font-bold text-[#FFB700] hover:underline">重试</button></div>
          ) : records.data?.items.length ? (
            records.data.items.map((r) => (
              <div key={r.id} className="grid gap-3 border-b border-border bg-[#101d2b] px-4 py-4 last:border-0 sm:grid-cols-[auto_minmax(0,1fr)_minmax(12rem,auto)] sm:items-center sm:gap-4 sm:px-5">
                <span className={`rounded px-2 py-1 text-xs font-bold ${r.direction === "out" ? "bg-[#176EFF]/15 text-[#7db4ff]" : "bg-[#FF6B35]/15 text-[#FF6B35]"}`}>
                  {r.direction === "out" ? "我举报" : "被举报"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-[#fce1b6]">
                    <span className="font-bold">{r.reporterDisplay}</span>
                    <span className="mx-1.5 text-muted-foreground">→</span>
                    <span className="font-bold">{r.targetDisplay}</span>
                    {r.kind === "random" && <span className="ml-2 rounded bg-[#af915f]/20 px-1.5 py-0.5 text-[10px] text-[#af915f]">随机</span>}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString("zh-CN")}</p>
                </div>
                <div className="border-t border-border/60 pt-3 text-left sm:border-0 sm:pt-0 sm:text-right">
                  <p className={`font-num text-sm font-bold ${r.success ? "text-[#00B77D]" : "text-[#EF5459]"}`}>
                    {r.success ? "成功" : "失败"}
                  </p>
                  <p className="font-num text-xs text-muted-foreground">
                    {r.direction === "out"
                      ? r.success
                        ? `+$${r.amount.toFixed(2)}`
                        : `-$${(r.amount + r.tax).toFixed(2)}`
                      : r.success
                        ? `-$${(r.amount + r.tax).toFixed(2)}`
                        : `+$${r.amount.toFixed(2)}`}
                  </p>
                  <p className="font-num mt-0.5 text-[10px] text-muted-foreground">
                    税前 ${r.grossAmount.toFixed(2)} · 税率 {(r.taxBasisPoints / 100).toFixed(2)}% · 税 ${r.tax.toFixed(2)}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {r.lowerBalance == null
                      ? "历史记录未保存结算前余额快照"
                      : `结算前：举报人 $${r.reporterBalanceBefore?.toFixed(2)} / 对方 $${r.targetBalanceBefore?.toFixed(2)} · 较低余额 $${r.lowerBalance.toFixed(2)} × 50%`}
                  </p>
                </div>
              </div>
            ))
          ) : (
            <p className="bg-[#101d2b] py-16 text-center text-sm text-muted-foreground">暂无举报记录</p>
          )}
        </div>

        {records.data && (
          <Pager
            className="mt-4"
            page={records.data.page}
            totalPages={records.data.totalPages}
            total={records.data.total}
            pageSize={pageSize}
            onPage={setPage}
            onPageSize={(s) => { setPageSize(s); setPage(1); }}
          />
        )}

        <p className="mt-4 text-center text-xs text-muted-foreground">
          金额为你视角的收支；每条记录按发生时快照的税率结算，后续改税率不影响历史
        </p>
      </main>
    </div>
  );
}
