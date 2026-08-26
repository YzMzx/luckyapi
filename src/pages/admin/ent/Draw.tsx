import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pager } from "@/components/Pager";
import { Field, ConfigLoading, ConfigError } from "./shared";
import { useEntertainmentConfig } from "./useEntertainmentConfig";

/** 一次性抽奖：配置 + 参与审计 */
export default function EntDraw() {
  const { control, form, set, save } = useEntertainmentConfig();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const draws = trpc.admin.listDrawsPage.useQuery({ page, pageSize });

  if (control.error) return <ConfigError message={control.error.message} onRetry={() => control.refetch()} />;
  if (!form) return <ConfigLoading />;

  const th = "text-muted-foreground";
  return (
    <div className="w-full max-w-[90rem] space-y-6">
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-3"><Switch checked={form.drawEnabled} onCheckedChange={(v) => set("drawEnabled", v)} /><h2 className="t-section">一次性抽奖</h2></div>
        <p className="mt-2 text-xs text-muted-foreground">正式注册账号全局仅参与一次；0 总量表示不限制总参与人数，预算仍为硬限制。</p>
        <div className="mt-5 grid gap-4 md:grid-cols-5">
          <Field label="中奖率 %" value={form.drawWinRatePercent} min={0} max={100} step={0.01} onChange={(v) => set("drawWinRatePercent", v)} />
          <Field label="最小奖励 $" value={form.drawMinReward} min={0} step={0.01} onChange={(v) => set("drawMinReward", v)} />
          <Field label="最大奖励 $" value={form.drawMaxReward} min={0} step={0.01} onChange={(v) => set("drawMaxReward", v)} />
          <Field label="总参与上限（0=不限）" value={form.drawTotalLimit} min={0} onChange={(v) => set("drawTotalLimit", v)} />
          <Field label="剩余活动预算 $" value={form.drawBudgetRemaining} min={0} step={0.01} onChange={(v) => set("drawBudgetRemaining", v)} />
        </div>
        <div className="mt-5 flex justify-end">
          <button disabled={save.isPending} onClick={() => save.mutate(form)} className="btn-3d rounded-lg bg-accent px-8 py-3 font-black text-accent-foreground disabled:opacity-50">
            {save.isPending ? "保存中…" : "保存抽奖配置"}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="t-section">抽奖记录</h2>
        <p className="mt-2 text-xs text-muted-foreground">结果与资金快照作为审计记录永久保留，IP 仅用于安全审计。</p>
        <div className="mt-4 overflow-x-auto">
          <Table>
            <TableHeader><TableRow className="border-border hover:bg-transparent">
              <TableHead className={th}>时间</TableHead><TableHead className={th}>IP</TableHead>
              <TableHead className={th}>用户</TableHead><TableHead className={th}>结果</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {draws.data?.items.map((d) => (
                <TableRow key={d.id} className="border-border">
                  <TableCell className="text-xs text-muted-foreground">{new Date(d.createdAt).toLocaleString("zh-CN")}</TableCell>
                  <TableCell className="font-num text-xs text-muted-foreground">{d.ip}</TableCell>
                  <TableCell className="text-foreground">{d.groupName ?? "-"}</TableCell>
                  <TableCell>{d.won ? <span className="font-num text-accent">中 ${d.amount}</span> : <span className="text-[#EF5459]">未中</span>}</TableCell>
                </TableRow>
              ))}
              {draws.isLoading && <TableRow className="border-border"><TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">加载抽奖记录中…</TableCell></TableRow>}
              {draws.error && <TableRow className="border-border"><TableCell colSpan={4} className="py-8 text-center text-sm text-[#EF5459]">抽奖记录加载失败：{draws.error.message} <button onClick={() => draws.refetch()} className="ml-2 font-bold text-accent hover:underline">重试</button></TableCell></TableRow>}
              {!draws.isLoading && !draws.error && !draws.data?.items.length && (
                <TableRow className="border-border"><TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">暂无抽奖记录</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
          {draws.data && (
            <Pager
              className="mt-4"
              page={draws.data.page}
              totalPages={draws.data.totalPages}
              total={draws.data.total}
              pageSize={pageSize}
              onPage={setPage}
              onPageSize={(s) => { setPageSize(s); setPage(1); }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
