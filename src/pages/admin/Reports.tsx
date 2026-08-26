import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pager } from "@/components/Pager";

export default function Reports() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [kindFilter, setKindFilter] = useState("");
  const [successFilter, setSuccessFilter] = useState("");
  const [fromFilter, setFromFilter] = useState("");
  const [toFilter, setToFilter] = useState("");
  const reportSettings = trpc.admin.reportSettings.get.useQuery();
  const [draft, setDraft] = useState<null | { tax: string; targeted: string; random: string; success: string }>(null);
  const settingsDraft = draft ?? {
    tax: reportSettings.data ? String(reportSettings.data.taxPercent) : "",
    targeted: reportSettings.data ? String(reportSettings.data.targetedDailyLimit) : "",
    random: reportSettings.data ? String(reportSettings.data.randomDailyLimit) : "",
    success: reportSettings.data ? String(reportSettings.data.successRatePercent) : "",
  };
  const setRule = (key: keyof typeof settingsDraft, value: string) => setDraft({ ...settingsDraft, [key]: value });
  const [resetReason, setResetReason] = useState("");
  const saveSettings = trpc.admin.reportSettings.update.useMutation({
    onSuccess: () => { toast.success("举报规则已保存"); setDraft(null); reportSettings.refetch(); },
    onError: (error) => toast.error(error.message),
  });
  const resetToday = trpc.admin.reportSettings.resetToday.useMutation({
    onSuccess: () => { toast.success("已重置所有用户今日免费举报次数"); setResetReason(""); reportSettings.refetch(); },
    onError: (error) => toast.error(error.message),
  });
  const reportsLog = trpc.admin.listReportsPage.useQuery({
    page,
    pageSize,
    kind: (kindFilter || undefined) as "targeted" | "random" | undefined,
    success: successFilter === "" ? undefined : successFilter === "true",
    from: fromFilter ? new Date(`${fromFilter}T00:00:00`) : undefined,
    to: toFilter ? new Date(`${toFilter}T23:59:59.999`) : undefined,
  });

  const th = "text-muted-foreground";
  return (
    <div className="w-full max-w-[90rem] space-y-5">
      <section className="admin-panel p-4 sm:p-6">
        <h2 className="t-section">举报结算规则</h2>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">指定与随机举报分别计算每日免费次数；免费次数用完后才消耗永久举报卡。成功率仅后台可见，前台与公开接口不会显示。新规则只影响之后发起的举报。</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div><label className="text-xs font-bold text-muted-foreground">指定举报每日免费次数</label><Input type="number" min="0" max="100" step="1" value={settingsDraft.targeted} onChange={(event) => setRule("targeted", event.target.value)} className="admin-input mt-1.5" /></div>
          <div><label className="text-xs font-bold text-muted-foreground">随机举报每日免费次数</label><Input type="number" min="0" max="100" step="1" value={settingsDraft.random} onChange={(event) => setRule("random", event.target.value)} className="admin-input mt-1.5" /></div>
          <div><label className="text-xs font-bold text-muted-foreground">举报成功率（%，仅后台）</label><Input type="number" min="0" max="100" step="0.01" value={settingsDraft.success} onChange={(event) => setRule("success", event.target.value)} className="admin-input mt-1.5" /></div>
          <div><label className="text-xs font-bold text-muted-foreground">举报收益税率（%）</label><Input type="number" min="0" max="100" step="0.01" value={settingsDraft.tax} onChange={(event) => setRule("tax", event.target.value)} className="admin-input mt-1.5" /></div>
        </div>
        <div className="mt-4 flex justify-end">
          <button type="button" disabled={saveSettings.isPending || Object.values(settingsDraft).some((v) => v === "" || !Number.isFinite(Number(v)))} onClick={() => saveSettings.mutate({ taxPercent: Number(settingsDraft.tax), targetedDailyLimit: Number(settingsDraft.targeted), randomDailyLimit: Number(settingsDraft.random), successRatePercent: Number(settingsDraft.success) })} className="admin-primary w-full px-6 py-2.5 sm:w-auto">{saveSettings.isPending ? "保存中…" : "保存举报规则"}</button>
        </div>
        <div className="mt-6 rounded-lg border border-[#EF5459]/35 bg-[#EF5459]/5 p-4">
          <h3 className="text-sm font-black text-[#EF5459]">危险操作：重置今日免费次数</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">所有用户的指定与随机免费次数会立即恢复；历史和资金结算不变，已消耗的举报卡不会返还。</p>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row">
            <Input value={resetReason} maxLength={200} onChange={(e) => setResetReason(e.target.value)} placeholder="填写重置原因（必填，至少 2 个字）" className="admin-input flex-1" />
            <button type="button" disabled={resetToday.isPending || resetReason.trim().length < 2} onClick={() => { if (window.confirm("确认重置所有用户今天的免费举报次数？该操作会写入管理员审计日志。")) resetToday.mutate({ reason: resetReason.trim() }); }} className="rounded-lg border border-[#EF5459]/60 px-5 py-2 text-sm font-bold text-[#EF5459] disabled:opacity-40">{resetToday.isPending ? "重置中…" : "确认重置今日次数"}</button>
          </div>
        </div>
      </section>
      <section className="admin-panel overflow-hidden p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={kindFilter} onValueChange={(v) => { setKindFilter(v === "__all__" ? "" : v); setPage(1); }}>
          <SelectTrigger className="w-36 border-border bg-[hsl(var(--admin-control))]"><SelectValue placeholder="全部类型" /></SelectTrigger>
          <SelectContent className="border-border bg-card text-foreground">
            <SelectItem value="__all__">全部类型</SelectItem>
            <SelectItem value="targeted">指定</SelectItem>
            <SelectItem value="random">随机</SelectItem>
          </SelectContent>
        </Select>
        <Select value={successFilter} onValueChange={(v) => { setSuccessFilter(v === "__all__" ? "" : v); setPage(1); }}>
          <SelectTrigger className="w-36 border-border bg-[hsl(var(--admin-control))]"><SelectValue placeholder="全部结果" /></SelectTrigger>
          <SelectContent className="border-border bg-card text-foreground">
            <SelectItem value="__all__">全部结果</SelectItem>
            <SelectItem value="true">成功</SelectItem>
            <SelectItem value="false">失败</SelectItem>
          </SelectContent>
        </Select>
        <Input type="date" value={fromFilter} onChange={(e) => { setFromFilter(e.target.value); setPage(1); }}
          aria-label="开始日期" className="w-40 border-border bg-[hsl(var(--admin-control))]" />
        <span className="text-xs text-muted-foreground">至</span>
        <Input type="date" value={toFilter} onChange={(e) => { setToFilter(e.target.value); setPage(1); }}
          aria-label="结束日期" className="w-40 border-border bg-[hsl(var(--admin-control))]" />
        {(kindFilter || successFilter || fromFilter || toFilter) && (
          <button className="text-xs text-primary hover:underline"
            onClick={() => { setKindFilter(""); setSuccessFilter(""); setFromFilter(""); setToFilter(""); setPage(1); }}>清除筛选</button>
        )}
      </div>
      <div className="overflow-x-auto"><Table>
        <TableHeader><TableRow className="border-border hover:bg-transparent">
          <TableHead className={th}>时间</TableHead>
          <TableHead className={th}>举报人</TableHead>
          <TableHead className={th}>被举报人</TableHead>
          <TableHead className={th}>类型</TableHead>
          <TableHead className={th}>次数来源 / 成功率</TableHead>
          <TableHead className={`text-right ${th}`}>结果</TableHead>
          <TableHead className={`text-right ${th}`}>结算基数 / 税前扣除</TableHead>
          <TableHead className={`text-right ${th}`}>税率 / 税额</TableHead>
          <TableHead className={`text-right ${th}`}>实际到账</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {reportsLog.data?.items.map((r) => (
            <TableRow key={r.id} className="border-border">
              <TableCell className="max-w-48 text-xs text-muted-foreground">
                <p className="whitespace-nowrap">{new Date(r.createdAt).toLocaleString("zh-CN")}</p>
                {r.requestId && <p className="font-num mt-0.5 truncate text-[10px]" title={r.requestId}>{r.requestId}</p>}
              </TableCell>
              <TableCell className="text-xs text-foreground">{r.reporterName ?? r.reporterUsername ?? "未知"}</TableCell>
              <TableCell className="text-xs text-foreground">{r.targetName ?? r.targetUsername ?? "未知"}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{r.kind === "random" ? "随机" : "指定"}</TableCell>
              <TableCell className="text-xs text-muted-foreground"><span className="block">{r.quotaSource === "card" ? "举报卡" : "每日免费"}</span><span className="font-num text-[10px]">当次 {(r.successBasisPoints / 100).toFixed(2)}%</span></TableCell>
              <TableCell className="text-right">
                {r.success
                  ? <span className="text-xs text-[#00B77D]">成功</span>
                  : <span className="text-xs text-[#EF5459]">失败</span>}
              </TableCell>
              <TableCell className="font-num text-right text-xs text-muted-foreground">
                {r.lowerBalance == null
                  ? <span>历史无快照<br />${r.grossAmount.toFixed(2)} / ${r.deductedAmount.toFixed(2)}</span>
                  : <span>举 ${r.reporterBalanceBefore?.toFixed(2)} / 对 ${r.targetBalanceBefore?.toFixed(2)}<br />低 ${r.lowerBalance.toFixed(2)} × 50% = ${r.grossAmount.toFixed(2)}</span>}
              </TableCell>
              <TableCell className="font-num text-right text-xs text-muted-foreground">
                {(r.taxBasisPoints / 100).toFixed(2)}% / ${r.tax.toFixed(2)}
              </TableCell>
              <TableCell className="font-num text-right text-accent">${r.creditedAmount.toFixed(2)}</TableCell>
            </TableRow>
          ))}
          {reportsLog.isLoading && <TableRow className="border-border"><TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">加载举报记录中…</TableCell></TableRow>}
          {reportsLog.error && <TableRow className="border-border"><TableCell colSpan={9} className="py-8 text-center text-sm text-[#EF5459]">举报记录加载失败：{reportsLog.error.message} <button onClick={() => reportsLog.refetch()} className="ml-2 font-bold text-accent hover:underline">重试</button></TableCell></TableRow>}
          {!reportsLog.isLoading && !reportsLog.error && !reportsLog.data?.items.length && (
            <TableRow className="border-border"><TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">暂无举报记录</TableCell></TableRow>
          )}
        </TableBody>
      </Table></div>
      {reportsLog.data && (
        <Pager
          className="mt-4"
          page={reportsLog.data.page}
          totalPages={reportsLog.data.totalPages}
          total={reportsLog.data.total}
          pageSize={pageSize}
          onPage={setPage}
          onPageSize={(s) => { setPageSize(s); setPage(1); }}
        />
      )}
      </section>
    </div>
  );
}
