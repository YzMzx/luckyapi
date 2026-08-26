import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pager } from "@/components/Pager";

type Draft = {
  enabled: boolean;
  dailyLimit: number;
  minWatchSeconds: number;
  minReward: number;
  maxReward: number;
  dailyBudget: number;
  useFund: boolean;
  fundBalance: number;
  videoResource: string;
};

const STATUS_LABEL = { active: "观看中", ready: "待领取", claimed: "已领取", expired: "已过期" } as const;

export default function VideoRewardAdmin() {
  const utils = trpc.useUtils();
  const control = trpc.admin.getVideoRewardControl.useQuery();
  const [draftOverride, setDraftOverride] = useState<Partial<Draft>>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [businessDay, setBusinessDay] = useState("");
  const [userId, setUserId] = useState("");
  const [status, setStatus] = useState<"active" | "ready" | "claimed" | "expired" | "">("");
  const records = trpc.admin.listVideoRewardSessionsPage.useQuery({
    page,
    pageSize,
    businessDay: businessDay || undefined,
    userId: userId ? Number(userId) : undefined,
    status: status || undefined,
  });
  const config = control.data?.config;
  const draft: Draft | null = config ? {
      enabled: config.enabled,
      dailyLimit: config.dailyLimit,
      minWatchSeconds: config.minWatchSeconds,
      minReward: config.minReward,
      maxReward: config.maxReward,
      dailyBudget: config.dailyBudget,
      useFund: config.useFund,
      fundBalance: config.fundBalance,
      videoResource: config.videoResource,
      ...draftOverride,
    } : null;

  const save = trpc.admin.updateVideoRewardConfig.useMutation({
    onSuccess: () => {
      toast.success("视频红包配置已保存");
      setDraftOverride({});
      utils.admin.getVideoRewardControl.invalidate();
      utils.admin.listVideoRewardSessionsPage.invalidate();
      utils.entertainment.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const resetFilters = () => { setBusinessDay(""); setUserId(""); setStatus(""); setPage(1); };

  if (control.error) return <div className="rounded-xl border border-[#EF5459]/40 bg-card p-6 text-sm text-[#EF5459]">配置加载失败：{control.error.message}</div>;
  if (!draft || !control.data) return <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">加载视频红包配置中…</div>;

  const numberField = (key: keyof Pick<Draft, "dailyLimit" | "minWatchSeconds" | "minReward" | "maxReward" | "dailyBudget" | "fundBalance">, label: string, step: string, min = 0, max?: number) => (
    <div className="space-y-2"><Label>{label}</Label><Input type="number" min={min} max={max} step={step} value={draft[key]} onChange={(event) => setDraftOverride({ ...draftOverride, [key]: Number(event.target.value) })} className="border-border bg-[hsl(var(--admin-control))]" /></div>
  );

  return <div className="w-full max-w-[90rem] space-y-6">
    <div className="grid gap-4 sm:grid-cols-4">
      {[
        ["今日会话", control.data.stats.sessionsToday],
        ["今日已领取", control.data.stats.claimedToday],
        ["今日发放", `$${control.data.stats.dailySpent.toFixed(6)}`],
        ["业务日", control.data.businessDay.key],
      ].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-border bg-card p-5"><p className="text-xs text-muted-foreground">{label}</p><p className="font-num mt-2 text-xl font-black text-accent">{value}</p></div>)}
    </div>

    <form className="rounded-xl border border-border bg-card p-6" onSubmit={(event) => { event.preventDefault(); save.mutate(draft); }}>
      <div className="flex items-center justify-between gap-4"><div><h2 className="t-section">每日看视频领红包</h2><p className="mt-2 text-xs text-muted-foreground">每位正式用户每天可领取 1–100 次；次数按统一业务日计数。0 预算表示关闭发放；最少观看固定不得低于 15 秒。只允许 public 下的本地资源路径。</p></div><Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraftOverride({ ...draftOverride, enabled })} /></div>
      <div className="mt-5 grid gap-4 md:grid-cols-4">
        {numberField("dailyLimit", "每人每天可领取次数", "1", 1, 100)}
        {numberField("minWatchSeconds", "最少观看秒数", "1", 15)}
        {numberField("minReward", "最小奖励 $（6位小数）", "0.000001", 0.000001)}
        {numberField("maxReward", "最大奖励 $（6位小数）", "0.000001", 0.000001)}
        {numberField("dailyBudget", "每日总预算 $（0=关闭）", "0.000001")}
        <div className="space-y-2"><Label>视频资源</Label><Input value={draft.videoResource} onChange={(event) => setDraftOverride({ ...draftOverride, videoResource: event.target.value })} className="border-border bg-[hsl(var(--admin-control))]" /></div>
        <div className="space-y-2"><Label>基金余额 $</Label><Input type="number" min={0} step="0.000001" value={draft.fundBalance} disabled={!draft.useFund} onChange={(event) => setDraftOverride({ ...draftOverride, fundBalance: Number(event.target.value) })} className="border-border bg-[hsl(var(--admin-control))] disabled:opacity-50" /></div>
        <div className="flex items-end"><label className="flex h-10 items-center gap-3"><Switch checked={draft.useFund} onCheckedChange={(useFund) => setDraftOverride({ ...draftOverride, useFund })} /><span className="text-sm">启用独立基金硬限制</span></label></div>
      </div>
      <div className="mt-5 flex justify-end"><button type="submit" disabled={save.isPending} className="btn-3d rounded-lg bg-accent px-8 py-3 font-black text-accent-foreground disabled:opacity-50">{save.isPending ? "保存中…" : "保存视频红包配置"}</button></div>
    </form>

    <div className="rounded-xl border border-border bg-card p-6">
      <h2 className="t-section">观看与领取审计</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <Input placeholder="业务日 YYYY-MM-DD" value={businessDay} onChange={(event) => { setBusinessDay(event.target.value); setPage(1); }} className="border-border bg-[hsl(var(--admin-control))]" />
        <Input type="number" min={1} placeholder="用户 ID" value={userId} onChange={(event) => { setUserId(event.target.value); setPage(1); }} className="border-border bg-[hsl(var(--admin-control))]" />
        <select value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setPage(1); }} className="h-10 rounded-md border border-border bg-[hsl(var(--admin-control))] px-3 text-sm"><option value="">全部状态</option>{Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <button type="button" onClick={resetFilters} className="rounded-lg border border-border text-sm font-bold text-muted-foreground hover:border-accent hover:text-accent">重置筛选</button>
      </div>
      <div className="mt-4 overflow-x-auto"><Table><TableHeader><TableRow><TableHead>时间</TableHead><TableHead>用户</TableHead><TableHead>业务日</TableHead><TableHead>状态/进度</TableHead><TableHead>奖励</TableHead><TableHead>审计</TableHead></TableRow></TableHeader><TableBody>
        {records.data?.items.map((row) => <TableRow key={row.id}><TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(row.startedAt).toLocaleString("zh-CN")}</TableCell><TableCell><p className="font-bold text-foreground">{row.groupName ?? row.username ?? `#${row.userId}`}</p><p className="text-[10px] text-muted-foreground">用户 #{row.userId}</p></TableCell><TableCell className="font-num text-xs">{row.businessDay}</TableCell><TableCell><p className="text-xs font-bold text-accent">{STATUS_LABEL[row.status]}</p><p className="font-num text-[10px] text-muted-foreground">{(row.watchedMs / 1000).toFixed(1)}s · seq {row.lastSequence}</p></TableCell><TableCell className="font-num">{row.reward === null ? "—" : `$${row.reward.toFixed(6)}`}</TableCell><TableCell className="text-[10px] text-muted-foreground">token {row.tokenPrefix}…<br />{row.claimRequestId ?? row.startRequestId}</TableCell></TableRow>)}
        {records.isLoading && <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">加载审计记录中…</TableCell></TableRow>}
        {records.error && <TableRow><TableCell colSpan={6} className="py-10 text-center text-[#EF5459]">记录加载失败：{records.error.message}</TableCell></TableRow>}
        {!records.isLoading && !records.error && !records.data?.items.length && <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">暂无记录</TableCell></TableRow>}
      </TableBody></Table></div>
      {records.data && <Pager className="mt-4" page={records.data.page} totalPages={records.data.totalPages} total={records.data.total} pageSize={pageSize} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} />}
    </div>
  </div>;
}
