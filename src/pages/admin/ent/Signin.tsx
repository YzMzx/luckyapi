import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pager } from "@/components/Pager";
import { Field, ConfigLoading, ConfigError } from "./shared";
import { useEntertainmentConfig, type Draft } from "./useEntertainmentConfig";

/** 每日签到：奖励配置 + 签到记录 */
export default function EntSignin() {
  const { control, form, set, save, tierTextDraft, setTierTextDraft } = useEntertainmentConfig();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const signins = trpc.admin.listDailySigninsPage.useQuery({ page, pageSize });

  if (control.error) return <ConfigError message={control.error.message} onRetry={() => control.refetch()} />;
  if (!form) return <ConfigLoading />;

  const tiersText = tierTextDraft ?? form.signinTiers.map((tier) => `${tier.reward}:${tier.probabilityPpm / 10_000}`).join("\n");

  return (
    <div className="w-full max-w-[90rem] space-y-6">
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-3"><Switch checked={form.signinEnabled} onCheckedChange={(v) => set("signinEnabled", v)} /><h2 className="t-section">每日签到</h2></div>
        <p className="mt-2 text-xs text-muted-foreground">签到保证获得奖励；默认范围 $1–$5。启用时预算不得低于单次最大风险。</p>
        <div className="mt-5 grid gap-4 md:grid-cols-5">
          <Field label="最小奖励 $" value={form.signinMinReward} min={0} step={0.01} onChange={(v) => set("signinMinReward", v)} />
          <Field label="最大奖励 $" value={form.signinMaxReward} min={0} step={0.01} onChange={(v) => set("signinMaxReward", v)} />
          <div className="space-y-2"><Label>奖励模式</Label><Select value={form.signinMode} onValueChange={(v) => set("signinMode", v as Draft["signinMode"])}>
            <SelectTrigger className="w-full border-border bg-[hsl(var(--admin-control))]"><SelectValue /></SelectTrigger><SelectContent>
              <SelectItem value="range">范围安全随机</SelectItem><SelectItem value="fixed">固定奖励</SelectItem><SelectItem value="tiers">分档概率</SelectItem>
            </SelectContent></Select></div>
          <Field label="固定奖励 $" value={form.signinFixedReward} min={0} step={0.01} onChange={(v) => set("signinFixedReward", v)} />
          <Field label="剩余活动预算 $" value={form.signinBudgetRemaining} min={0} step={0.01} onChange={(v) => set("signinBudgetRemaining", v)} />
        </div>
        {form.signinMode === "tiers" && <div className="mt-4 space-y-2"><Label>分档（每行 奖励美元:概率百分比，总计必须 100）</Label>
          <textarea value={tiersText} onChange={(event) => {
            setTierTextDraft(event.target.value);
            const tiers = event.target.value.split(/\r?\n/).filter(Boolean).map((line) => {
              const [reward, percent] = line.split(":");
              return { reward: Number(reward), probabilityPpm: Math.round(Number(percent) * 10_000) };
            });
            set("signinTiers", tiers);
          }} className="min-h-32 w-full rounded-md border border-border bg-[hsl(var(--admin-control))] p-3 font-mono text-sm" />
        </div>}
        <div className="mt-5 flex justify-end">
          <button disabled={save.isPending} onClick={() => save.mutate(form)} className="btn-3d rounded-lg bg-accent px-8 py-3 font-black text-accent-foreground disabled:opacity-50">
            {save.isPending ? "保存中…" : "保存签到配置"}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="t-section">最近签到记录</h2>
        <div className="mt-4 overflow-x-auto"><Table><TableHeader><TableRow><TableHead>业务日</TableHead><TableHead>用户</TableHead><TableHead>奖励</TableHead><TableHead>预算前 / 后</TableHead><TableHead>时间</TableHead></TableRow></TableHeader><TableBody>
          {signins.data?.items.map((row) => <TableRow key={row.id}><TableCell>{row.day}</TableCell><TableCell>{row.groupName ?? row.username}</TableCell><TableCell className="text-accent">${(row.rewardUnits / 100).toFixed(2)}</TableCell><TableCell>${(row.fundBeforeUnits / 100).toFixed(2)} / ${(row.fundAfterUnits / 100).toFixed(2)}</TableCell><TableCell>{new Date(row.createdAt).toLocaleString("zh-CN")}</TableCell></TableRow>)}
          {signins.isLoading && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">加载签到记录中…</TableCell></TableRow>}
          {signins.error && <TableRow><TableCell colSpan={5} className="py-8 text-center text-[#EF5459]">签到记录加载失败：{signins.error.message} <button onClick={() => signins.refetch()} className="ml-2 font-bold text-accent hover:underline">重试</button></TableCell></TableRow>}
          {!signins.isLoading && !signins.error && !signins.data?.items.length && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">暂无签到记录</TableCell></TableRow>}
        </TableBody></Table>
          {signins.data && (
            <Pager
              className="mt-4"
              page={signins.data.page}
              totalPages={signins.data.totalPages}
              total={signins.data.total}
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
