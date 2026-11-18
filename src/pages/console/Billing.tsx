import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { ConsoleLayout } from "@/components/ConsoleLayout";
import { Pager } from "@/components/Pager";
import { cn } from "@/lib/utils";

const KINDS = [
  { v: "", label: "全部" },
  { v: "draw", label: "抽奖" },
  { v: "checkin", label: "签到" },
  { v: "redeem", label: "兑换" },
  { v: "credit_expire", label: "限时到期" },
  { v: "adjust", label: "调整" },
  { v: "usage", label: "调用" },
  { v: "duel", label: "决斗" },
] as const;

const KIND_LABEL: Record<string, string> = { draw: "抽奖", checkin: "签到", redeem: "兑换", credit_expire: "限时额度到期", adjust: "调整", usage: "调用", duel: "决斗" };
const KIND_STYLE: Record<string, string> = {
  draw: "bg-[#FFB700]/15 text-[#FFB700]",
  checkin: "bg-[#35e0c8]/15 text-[#35e0c8]",
  redeem: "bg-[#176EFF]/15 text-[#7db4ff]",
  credit_expire: "bg-[#EF5459]/15 text-[#ff8f93]",
  adjust: "bg-white/10 text-muted-foreground",
  usage: "bg-[#8b5cf6]/15 text-[#a78bfa]",
  duel: "bg-[#FFB700]/15 text-[#FFB700]",
};

export default function ConsoleBilling() {
  const { data: user } = trpc.auth.me.useQuery();
  const [kind, setKind] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const { data } = trpc.member.myTransactions.useQuery({ page, pageSize, kind: (kind || undefined) as never });

  if (!user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;

  return (
    <ConsoleLayout user={user} title="额度流水" desc="每一笔余额变动都有记录，可追溯来源">
      <div className="mb-4 flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <button key={k.v} onClick={() => { setKind(k.v); setPage(1); }}
            className={cn("rounded-full px-3 py-1 text-xs font-semibold transition-colors",
              kind === k.v ? "bg-[#FFB700] text-[#162638]" : "border border-border text-muted-foreground hover:text-[#fce1b6]")}>
            {k.label}
          </button>
        ))}
      </div>
      <section className="rounded-xl border border-border bg-[#101d2b] p-4 sm:p-6">
        <div className="space-y-2">
          {(data?.rows ?? []).map((t) => (
            <div key={t.id} className="flex items-center gap-3 rounded-lg border border-border bg-[#162638] p-3">
              <span className={cn("w-12 shrink-0 rounded-full py-0.5 text-center text-xs font-semibold", KIND_STYLE[t.kind])}>{KIND_LABEL[t.kind]}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-[#fce1b6]">{t.note}</p>
                <p className="text-xs text-muted-foreground">{new Date(t.createdAt).toLocaleString("zh-CN")} · 余额 {t.balanceAfter.toFixed(2)}</p>
              </div>
              <span className={cn("font-num shrink-0 text-sm font-bold", t.amount >= 0 ? "text-[#00B77D]" : "text-[#EF5459]")}>
                {t.amount >= 0 ? "+" : ""}{t.amount.toFixed(2)}
              </span>
            </div>
          ))}
          {(data?.rows ?? []).length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">暂无流水记录</p>}
        </div>
        {data && (
          <Pager
            className="mt-4"
            page={data.page}
            totalPages={data.totalPages}
            total={data.total}
            pageSize={pageSize}
            onPage={setPage}
            onPageSize={(s) => { setPageSize(s); setPage(1); }}
          />
        )}
      </section>
    </ConsoleLayout>
  );
}
