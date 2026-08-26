import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pager } from "@/components/Pager";

const SCALE = 1_000_000;
const money = (units: number | null | undefined) => `$${((units ?? 0) / SCALE).toFixed(6)}`;
const time = (value: string | Date | null | undefined) => value ? new Date(value).toLocaleString("zh-CN") : "—";
const STATUS: Record<string, string> = { offer: "待接受", active: "履约中", overdue: "逾期追缴", repaid: "已还清", rejected: "已拒绝", cancelled: "已取消", expired: "接收超时" };

function LoanLedger({ loanId }: { loanId: number }) {
  const [page, setPage] = useState(1);
  const ledger = trpc.admin.listPeerLoanLedgerPage.useQuery({ loanId, page, pageSize: 20 });
  return <div className="rounded-lg border border-border bg-[hsl(var(--admin-surface))] p-3">
    <p className="mb-3 text-xs font-bold text-accent">贷款 #{loanId} 逐笔台账（只读）</p>
    <div className="space-y-2">{ledger.data?.items.map((row) => <div key={row.id} className="grid gap-1 rounded-lg border border-border/60 p-3 text-xs sm:grid-cols-[150px_1fr_auto]">
      <span className="text-muted-foreground">{time(row.createdAt)}</span>
      <div className="min-w-0"><p className="font-bold text-foreground">{row.type} · {row.note || "—"}</p><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={row.requestId}>requestId: {row.requestId}</p><p className="mt-1 text-muted-foreground">本金 {money(row.principalUnits)} / 利息 {money(row.interestUnits)} / 税 {money(row.taxUnits)}</p></div>
      <span className="font-mono font-bold text-accent">{money(row.amountUnits)}</span>
    </div>)}{ledger.isLoading && <p className="py-5 text-center text-xs text-muted-foreground">加载台账中…</p>}{ledger.error && <p className="py-5 text-center text-xs text-[#EF5459]">台账加载失败：{ledger.error.message}</p>}{!ledger.isLoading && !ledger.error && !ledger.data?.items.length && <p className="py-5 text-center text-xs text-muted-foreground">暂无台账</p>}</div>
    {ledger.data && <Pager className="mt-3" page={ledger.data.page} totalPages={ledger.data.totalPages} total={ledger.data.total} pageSize={20} onPage={setPage} />}
  </div>;
}

export default function Loans() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState("");
  const [party, setParty] = useState("");
  const [loanId, setLoanId] = useState("");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const query = trpc.admin.listPeerLoansPage.useQuery({
    page, pageSize,
    status: (status || undefined) as "offer" | "active" | "overdue" | "repaid" | "rejected" | "cancelled" | "expired" | undefined,
    party: party.trim() || undefined,
    loanId: /^\d+$/.test(loanId) ? Number(loanId) : undefined,
    dueFrom: dueFrom ? new Date(`${dueFrom}T00:00:00`) : undefined,
    dueTo: dueTo ? new Date(`${dueTo}T23:59:59.999`) : undefined,
  });
  const reset = () => { setStatus(""); setParty(""); setLoanId(""); setDueFrom(""); setDueTo(""); setPage(1); };
  return <div className="space-y-4">
    <div className="rounded-xl border border-border bg-card p-4 sm:p-6">
      <div className="flex flex-wrap gap-3">
        <Select value={status} onValueChange={(value) => { setStatus(value === "all" ? "" : value); setPage(1); }}><SelectTrigger className="w-40 border-border bg-[hsl(var(--admin-control))]"><SelectValue placeholder="全部状态" /></SelectTrigger><SelectContent>{<SelectItem value="all">全部状态</SelectItem>}{Object.entries(STATUS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select>
        <Input value={party} onChange={(e) => { setParty(e.target.value.slice(0, 64)); setPage(1); }} placeholder="双方账号 ID / 群内名称" className="w-full border-border bg-[hsl(var(--admin-control))] sm:w-56" />
        <Input value={loanId} onChange={(e) => { setLoanId(e.target.value.replace(/\D/g, "")); setPage(1); }} inputMode="numeric" placeholder="贷款 ID" className="w-32 border-border bg-[hsl(var(--admin-control))]" />
        <Input type="date" value={dueFrom} onChange={(e) => { setDueFrom(e.target.value); setPage(1); }} aria-label="到期开始" className="w-40 border-border bg-[hsl(var(--admin-control))]" />
        <Input type="date" value={dueTo} onChange={(e) => { setDueTo(e.target.value); setPage(1); }} aria-label="到期结束" className="w-40 border-border bg-[hsl(var(--admin-control))]" />
        {(status || party || loanId || dueFrom || dueTo) && <button type="button" onClick={reset} className="text-xs font-bold text-accent">清除筛选</button>}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">只读财务审计：本页不能调整余额、修改合同或伪造结清。</p>
    </div>

    <div className="space-y-3">{query.data?.items.map((loan) => <article key={loan.id} className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-xs text-muted-foreground">贷款 #{loan.id}</p><h2 className="mt-1 font-bold text-foreground">贷：{loan.lenderGroupName || loan.lenderUsername} <span className="font-mono text-xs text-muted-foreground">({loan.lenderAccountId})</span> → 借：{loan.borrowerGroupName || loan.borrowerUsername} <span className="font-mono text-xs text-muted-foreground">({loan.borrowerAccountId})</span></h2></div><span className="rounded-full border border-primary/50 px-3 py-1 text-xs font-bold text-accent">{STATUS[loan.auditStatus] ?? loan.auditStatus}</span></div>
      <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div><p className="text-muted-foreground">本金 / 月利率</p><p className="mt-1 font-mono font-bold">{money(loan.principalUnits)} / {(loan.monthlyRateBasisPoints / 100).toFixed(2)}%</p></div>
        <div><p className="text-muted-foreground">当前应计总额</p><p className="mt-1 font-mono font-bold">{money(loan.accruedTotalUnits)} <span className="text-muted-foreground">(利息 {money(loan.currentInterestUnits)})</span></p></div>
        <div><p className="text-muted-foreground">已还本金 / 利息 / 利息税</p><p className="mt-1 font-mono font-bold">{money(loan.paidPrincipalUnits)} / {money(loan.paidInterestUnits)} / {money(loan.taxPaidUnits)}</p><p className="mt-1 text-[10px] text-muted-foreground">当前应计利息税 {money(loan.currentInterestTaxUnits)}</p></div>
        <div><p className="text-muted-foreground">未偿欠款</p><p className="mt-1 font-mono font-bold text-[#EF5459]">{money(loan.outstandingUnits)}</p></div>
      </div>
      <div className="mt-4 grid gap-2 border-t border-border pt-3 text-[11px] text-muted-foreground sm:grid-cols-2 lg:grid-cols-5"><span>创建：{time(loan.offeredAt)}</span><span>5 分钟截止：{time(loan.offerExpiresAt)}</span><span>接受：{time(loan.acceptedAt)}</span><span>到期：{time(loan.dueAt)}</span><span>结清/终止：{time(loan.settledAt)}</span></div>
      <button type="button" onClick={() => setExpanded(expanded === loan.id ? null : loan.id)} className="mt-4 flex items-center gap-1 text-xs font-bold text-accent">{expanded === loan.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />} {expanded === loan.id ? "收起逐笔台账" : "展开逐笔台账"}</button>
      {expanded === loan.id && <div className="mt-3"><LoanLedger loanId={loan.id} /></div>}
    </article>)}
    {query.isLoading && <p className="rounded-xl border border-border bg-card py-16 text-center text-sm text-muted-foreground">加载贷款记录中…</p>}{query.error && <p className="rounded-xl border border-border bg-card py-16 text-center text-sm text-[#EF5459]">加载失败：{query.error.message}</p>}{!query.isLoading && !query.error && !query.data?.items.length && <p className="rounded-xl border border-border bg-card py-16 text-center text-sm text-muted-foreground">没有符合筛选的贷款记录</p>}</div>
    {query.data && <Pager page={query.data.page} totalPages={query.data.totalPages} total={query.data.total} pageSize={pageSize} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} />}
  </div>;
}
