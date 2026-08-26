import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router";
import { ArrowRightLeft, BadgeDollarSign, Check, HandCoins, Landmark, Search, ShieldCheck, UserRound } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { ConsoleLayout } from "@/components/ConsoleLayout";
import { sanitizeMoneyInput, transferInputProblem } from "@/lib/finance-input";

const inputClass = "w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary";
const cardClass = "rounded-2xl border border-border bg-card p-5 shadow-sm";
const money = (units: number) => `$${(units / 1_000_000).toFixed(6)}`;
const dateText = (value: string | Date | null) => value ? new Date(value).toLocaleString("zh-CN") : "—";
const statusText: Record<string, string> = { pending: "待借款方接受", active: "履约中", collecting: "持续追缴", defaulted: "已违约", fulfilled: "已履约", cancelled: "已取消" };
function Pager({ page, total, onChange }: { page: number; total: number; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / 20));
  return <div className="mt-4 flex items-center justify-end gap-2 text-xs text-muted-foreground"><span>第 {page}/{pages} 页 · 共 {total} 条</span><button className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</button><button className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40" disabled={page >= pages} onClick={() => onChange(page + 1)}>下一页</button></div>;
}

type AccountOption = {
  id: number;
  accountId: string;
  username: string;
  displayName: string;
  groupName: string | null;
  avatarUrl: string;
  isSelf: boolean;
};

const accountName = (account: AccountOption) => account.groupName || account.displayName || account.username;

function AccountPicker({ label, placeholder, selected, onSelect }: { label: string; placeholder: string; selected: AccountOption | null; onSelect: (account: AccountOption | null) => void }) {
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(text.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [text]);
  const matches = trpc.finance.searchAccounts.useQuery({ query: debounced }, {
    enabled: open && debounced.length > 0,
    staleTime: 10_000,
  });
  const choose = (account: AccountOption) => {
    if (account.isSelf) return;
    onSelect(account);
    setOpen(false);
  };
  return <label className="relative block text-sm">
    {label}
    <span className="relative mt-1 block"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><input className={`${inputClass} pl-9`} autoComplete="off" value={selected ? `${accountName(selected)} · ${selected.accountId}` : text} role="combobox" aria-expanded={open && debounced.length > 0} aria-autocomplete="list" onFocus={() => !selected && setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 100)} onChange={(event) => { setText(event.target.value.slice(0, 64)); onSelect(null); setOpen(true); }} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); if (event.key === "Enter") { const first = matches.data?.find((account) => !account.isSelf); if (first) { event.preventDefault(); choose(first); } } }} placeholder={placeholder} /></span>
    {selected && <span className="mt-2 flex items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-xs"><Check className="h-3.5 w-3.5 shrink-0 text-primary" /><b className="min-w-0 flex-1 truncate">已选择：{accountName(selected)}</b><span className="shrink-0 font-mono text-muted-foreground">ID {selected.accountId}</span></span>}
    {open && debounced.length > 0 && <span role="listbox" className="absolute left-0 right-0 top-full z-50 mt-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-2xl">
      {matches.isFetching && <span className="block px-3 py-4 text-center text-xs text-muted-foreground">正在查找匹配玩家…</span>}
      {matches.isError && <span className="block px-3 py-4 text-center text-xs text-destructive">搜索失败，请稍后重试</span>}
      {!matches.isFetching && !matches.isError && matches.data?.map((account) => <button key={account.id} type="button" role="option" aria-selected={selected?.id === account.id} disabled={account.isSelf} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(account)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45">
        {account.avatarUrl ? <img src={account.avatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" /> : <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted"><UserRound className="h-4 w-4" /></span>}
        <span className="min-w-0 flex-1"><span className="block truncate font-bold">{accountName(account)}{account.isSelf && "（你自己）"}</span><span className="block truncate text-xs text-muted-foreground">@{account.username}</span></span><span className="shrink-0 font-mono text-xs text-muted-foreground">ID {account.accountId}</span>
      </button>)}
      {!matches.isFetching && !matches.isError && matches.data?.length === 0 && <span className="block px-3 py-4 text-center text-xs text-muted-foreground">没有找到匹配的正式玩家</span>}
    </span>}
  </label>;
}

export default function Finance() {
  const location = useLocation();
  const utils = trpc.useUtils();
  const { data: user } = trpc.auth.me.useQuery();
  const [accountId, setAccountId] = useState("");
  const [recipientPickerKey, setRecipientPickerKey] = useState(0);
  const [recipient, setRecipient] = useState<AccountOption | null>(null);
  const [amount, setAmount] = useState("");
  const [borrowerAccountId, setBorrowerAccountId] = useState("");
  const [borrowerPickerKey, setBorrowerPickerKey] = useState(0);
  const [borrower, setBorrower] = useState<AccountOption | null>(null);
  const [principal, setPrincipal] = useState("");
  const [rate, setRate] = useState("3");
  const [dueAt, setDueAt] = useState("");
  const [historyPage, setHistoryPage] = useState(1);
  const [rankPage, setRankPage] = useState(1);
  const finance = trpc.finance.myFinance.useQuery({ page: historyPage, pageSize: 20 }, { refetchInterval: 5_000 });
  const leaderboard = trpc.finance.creditLeaderboard.useQuery({ page: rankPage, pageSize: 20 }, { refetchInterval: 15_000 });
  const refresh = () => { utils.finance.invalidate(); utils.auth.me.invalidate(); };
  const fail = (error: { message: string }) => toast.error(error.message);
  const transfer = trpc.finance.transfer.useMutation({ onSuccess: (result) => { toast.success(`已转出 $${result.amount.toFixed(6)}，手续费 $${result.fee.toFixed(6)}`); setAmount(""); setAccountId(""); setRecipient(null); setRecipientPickerKey((key) => key + 1); refresh(); }, onError: fail });
  const createLoan = trpc.finance.createLoan.useMutation({ onSuccess: (result) => { toast.success(`借贷合同 #${result.id} 已发送，本金已冻结；对方须在 5 分钟内接收`); setPrincipal(""); setBorrowerAccountId(""); setBorrower(null); setBorrowerPickerKey((key) => key + 1); refresh(); }, onError: fail });
  const accept = trpc.finance.acceptLoan.useMutation({ onSuccess: () => { toast.success("合同已生效，本金已到账"); refresh(); }, onError: fail });
  const cancel = trpc.finance.rejectOrCancelLoan.useMutation({ onSuccess: () => { toast.success("待接受合同已取消"); refresh(); }, onError: fail });
  const repay = trpc.finance.repayEarly.useMutation({ onSuccess: (result) => { toast.success(`提前还款完成：共 $${result.total.toFixed(6)}，利息 $${result.interest?.toFixed(6) ?? "0.000000"}`); refresh(); }, onError: fail });
  const normalizedAmount = Number(amount);
  const transferProblem = recipient ? transferInputProblem(accountId, amount) : "请先从搜索结果中选择收款人";
  const fee = useMemo(() => Number(amount) > 0 ? Math.ceil(Number(amount) * 1_000_000 * 0.03) / 1_000_000 : 0, [amount]);

  useEffect(() => {
    if (!user || location.hash !== "#credit-board") return;
    const frame = requestAnimationFrame(() => document.getElementById("credit-board")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [location.hash, user]);

  if (!user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;
  return <ConsoleLayout user={user} title="资金与借贷" desc="按昵称或账号 ID 选择玩家、签订借贷合同并查看信用记录"><div className="space-y-6">
    <div><h1 className="flex items-center gap-2 text-2xl font-black"><Landmark className="text-primary" />资金中心</h1><p className="mt-1 text-sm text-muted-foreground">转账、玩家借贷与信用记录。输入公开昵称、Linux.do 用户名或账号 ID 后，从匹配结果中选择玩家。</p></div>

    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/25 bg-primary/5 px-5 py-4">
      <div><p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">我的 Linux.do 站账号 ID</p><p className="mt-1 font-mono text-xl font-black text-primary">{user.linuxdoId}</p><p className="mt-1 text-xs text-muted-foreground">别人向你转移额度时，需要填写这个账号 ID。</p></div>
      <button type="button" className="rounded-xl border border-primary/30 bg-background px-4 py-2 text-sm font-bold text-primary hover:bg-primary/10" onClick={async () => { await navigator.clipboard.writeText(user.linuxdoId); toast.success("Linux.do 账号 ID 已复制"); }}>复制账号 ID</button>
    </div>

    <div className="grid gap-5 xl:grid-cols-2">
      <section className={cardClass}>
        <h2 className="flex items-center gap-2 text-lg font-bold"><ArrowRightLeft className="h-5 w-5 text-primary" />资金转移</h2>
        <p className="mt-1 text-xs text-muted-foreground">收款方收到填写金额；转出方另付 3% 手续费。临时限时额度不可转移。</p>
        <div className="mt-4 grid items-start gap-3 sm:grid-cols-2"><AccountPicker key={recipientPickerKey} label="收款人昵称或账号 ID" placeholder="输入昵称、用户名或 ID" selected={recipient} onSelect={(account) => { setRecipient(account); setAccountId(account?.accountId ?? ""); }} /><label className="text-sm">到账金额<input className={`${inputClass} mt-1`} inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(sanitizeMoneyInput(e.target.value))} placeholder="0.000000" /></label></div>
        <div className="mt-3 rounded-xl bg-muted/50 p-3 text-sm"><span>{recipient ? <>收款人：<b>{accountName(recipient)}</b>（ID {recipient.accountId}）</> : "输入昵称或 ID，并从下方匹配列表选择收款人"}</span><div className="mt-1 text-xs text-muted-foreground">到账 ${Number(amount || 0).toFixed(6)} + 手续费 ${fee.toFixed(6)} = 共扣 ${(Number(amount || 0) + fee).toFixed(6)}</div></div>
        <button className="mt-4 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50" disabled={Boolean(transferProblem) || transfer.isPending} onClick={() => !transferProblem && transfer.mutate({ accountId, amount: normalizedAmount, requestId: crypto.randomUUID() })}>{transfer.isPending ? "正在转移…" : "确认转移"}</button>
        {(transferProblem || transfer.isPending) && <p className="mt-2 text-xs text-muted-foreground">{transfer.isPending ? "服务器正在事务核验账号、余额与 requestId，请勿重复提交。" : `暂不可提交：${transferProblem}`}</p>}
      </section>

      <section className={cardClass}>
        <h2 className="flex items-center gap-2 text-lg font-bold"><HandCoins className="h-5 w-5 text-primary" />发起民间贷</h2>
        <p className="mt-1 text-xs text-muted-foreground">输入昵称或账号 ID 精确选择借款人。合同发出时立即冻结本金；对方须在 5 分钟内接收，否则合同作废并自动退回本金。月息按 30 天和实际经过时间折算，利息的 10% 归平台。</p>
        <div className="mt-4 grid items-start gap-3 sm:grid-cols-2"><AccountPicker key={borrowerPickerKey} label="借款人昵称或账号 ID" placeholder="输入昵称、用户名或 ID" selected={borrower} onSelect={(account) => { setBorrower(account); setBorrowerAccountId(account?.accountId ?? ""); }} /><label className="text-sm">本金<input className={`${inputClass} mt-1`} type="number" min="0.01" step="0.000001" value={principal} onChange={(e) => setPrincipal(e.target.value)} /></label><label className="text-sm">月利率（%）<input className={`${inputClass} mt-1`} type="number" min="0" max="100" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} /></label><label className="text-sm">还款到期时间<input className={`${inputClass} mt-1`} type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} /></label></div>
        <div className="mt-3 rounded-xl bg-muted/50 p-3 text-sm">{borrower ? <>借款人：<b>{accountName(borrower)}</b>（ID {borrower.accountId}）</> : <span className="text-muted-foreground">请搜索并选择借款人</span>}</div>
        <button className="mt-4 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground disabled:opacity-50" disabled={!borrower || !/^\d{1,32}$/.test(borrowerAccountId) || !(Number(principal) >= .01) || !dueAt || createLoan.isPending} onClick={() => createLoan.mutate({ borrowerAccountId, principal: Number(principal), monthlyRatePercent: Number(rate), dueAt: new Date(dueAt), requestId: crypto.randomUUID() })}>{createLoan.isPending ? "正在冻结并发送…" : "冻结本金并发送合同"}</button>
      </section>
    </div>

    <section className={cardClass}><h2 className="flex items-center gap-2 text-lg font-bold"><BadgeDollarSign className="h-5 w-5 text-primary" />我的借贷合同</h2><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[980px] text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="p-2">合同</th><th className="p-2">双方</th><th className="p-2">本金 / 月息</th><th className="p-2">到期</th><th className="p-2">状态</th><th className="p-2">待收</th><th className="p-2">操作</th></tr></thead><tbody>{finance.data?.loans.map(({ loan, lenderName, borrowerName, lenderAccountId, borrowerAccountId }) => { const isBorrower = loan.borrowerId === finance.data.meId; return <tr key={loan.id} className="border-t border-border"><td className="p-2 font-mono">#{loan.id}</td><td className="p-2">贷：{lenderName}（{lenderAccountId}）<br />借：{borrowerName}（{borrowerAccountId}）</td><td className="p-2">{money(loan.principalUnits)}<br /><span className="text-xs text-muted-foreground">{(loan.monthlyRateBasisPoints / 100).toFixed(2)}%</span></td><td className="p-2">{dateText(loan.dueAt)}</td><td className="p-2"><span className="rounded-full bg-muted px-2 py-1 text-xs font-bold">{statusText[loan.status] ?? loan.status}</span>{loan.status === "pending" && <div className="mt-1 text-xs text-amber-600">接收截止：{dateText(loan.offerExpiresAt)}</div>}</td><td className="p-2">{money(loan.outstandingPrincipalUnits + loan.outstandingInterestUnits)}</td><td className="p-2"><div className="flex flex-wrap gap-2">{loan.status === "pending" && isBorrower && <button className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground" onClick={() => accept.mutate({ loanId: loan.id })}>接受</button>}{loan.status === "active" && isBorrower && <button className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground" onClick={() => repay.mutate({ loanId: loan.id, requestId: crypto.randomUUID() })}>提前还清</button>}{loan.status === "pending" && <button className="rounded-lg border border-border px-3 py-1.5 text-xs" onClick={() => cancel.mutate({ loanId: loan.id })}>取消/拒绝</button>}</div></td></tr>; })}</tbody></table>{!finance.data?.loans.length && <p className="py-8 text-center text-sm text-muted-foreground">暂无借贷合同</p>}</div><Pager page={historyPage} total={finance.data?.loanTotal ?? 0} onChange={setHistoryPage} /></section>

    <section className={cardClass}><h2 className="flex items-center gap-2 text-lg font-bold"><ArrowRightLeft className="h-5 w-5 text-primary" />转移记录</h2><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="p-2">时间</th><th className="p-2">转出</th><th className="p-2">转入</th><th className="p-2">到账</th><th className="p-2">手续费</th></tr></thead><tbody>{finance.data?.transfers.map(({ transfer: row, senderName, recipientName, senderAccountId, recipientAccountId }) => <tr key={row.id} className="border-t border-border"><td className="p-2">{dateText(row.createdAt)}</td><td className="p-2">{senderName}（{senderAccountId}）</td><td className="p-2">{recipientName}（{recipientAccountId}）</td><td className="p-2 font-mono">{money(row.amountUnits)}</td><td className="p-2 font-mono">{money(row.feeUnits)}</td></tr>)}</tbody></table></div><Pager page={historyPage} total={finance.data?.transferTotal ?? 0} onChange={setHistoryPage} /></section>

    <section id="credit-board" className={`${cardClass} scroll-mt-24`}><h2 className="flex items-center gap-2 text-lg font-bold"><ShieldCheck className="h-5 w-5 text-primary" />信用榜</h2><p className="mt-1 text-xs text-muted-foreground">按履约次数优先、违约次数较少优先排序；不公开登录账号 ID 与余额。</p>{leaderboard.data?.myRank && <div className="mt-3 rounded-xl border border-primary/25 bg-primary/5 p-3 text-sm">我的排名：第 <b>{leaderboard.data.myRank.rank}</b> 名 · 借贷 {leaderboard.data.myRank.loanCount} · 履约 {leaderboard.data.myRank.fulfilledCount} · 违约 {leaderboard.data.myRank.defaultCount}</div>}<div className="mt-4 overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="p-2">排名</th><th className="p-2">玩家</th><th className="p-2">借贷次数</th><th className="p-2">履约次数</th><th className="p-2">违约次数</th></tr></thead><tbody>{leaderboard.data?.items.map((row) => <tr key={row.userId} className="border-t border-border"><td className="p-2 font-black">#{row.rank}</td><td className="p-2 font-bold">{row.groupName || row.username}</td><td className="p-2">{row.loanCount}</td><td className="p-2 text-emerald-600">{row.fulfilledCount}</td><td className="p-2 text-destructive">{row.defaultCount}</td></tr>)}</tbody></table></div><Pager page={rankPage} total={leaderboard.data?.total ?? 0} onChange={setRankPage} /></section>
  </div></ConsoleLayout>;
}
