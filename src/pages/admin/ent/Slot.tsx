import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pager } from "@/components/Pager";
import { SLOT_SYMBOLS } from "@contracts/slot-machine";
import { Field, ConfigLoading, ConfigError } from "./shared";
import { useEntertainmentConfig } from "./useEntertainmentConfig";
import SlotOperations from "../Settings";

const slotGlyph: Record<string, string> = Object.fromEntries(SLOT_SYMBOLS.map((symbol) => [symbol.id, symbol.glyph]));

/** 老虎机：每日次数限制（显眼）+ 启用开关 + 结算审计 */
export default function EntSlot() {
  const { control, form, set, save } = useEntertainmentConfig();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const slotRounds = trpc.admin.listSlotRoundsPage.useQuery({ page, pageSize });

  if (control.error) return <ConfigError message={control.error.message} onRetry={() => control.refetch()} />;
  if (!form || !control.data) return <ConfigLoading />;

  const th = "text-muted-foreground";
  return (
    <div className="w-full max-w-[90rem] space-y-6">
      <div className="rounded-xl border border-accent/40 bg-card p-6">
        <h2 className="t-section">老虎机每日次数限制</h2>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          当前每个业务日 {control.data.config.slotDailyLimit} 次，今日已开 {control.data.stats.slotToday} 局。0 = 关闭（不消耗额度与次数）。赔付表、RTP 与放水活动在本页下方配置。
        </p>
        <div className="mt-5 grid max-w-md gap-4">
          <Field label="每日次数限制（0=关闭）" value={form.slotDailyLimit} min={0} max={100} onChange={(v) => set("slotDailyLimit", v)} />
        </div>
        <div className="mt-4 flex items-center gap-3"><Switch checked={form.slotEnabled} onCheckedChange={(v) => set("slotEnabled", v)} /><Label>启用老虎机</Label></div>
        <div className="mt-5 flex justify-end">
          <button disabled={save.isPending} onClick={() => save.mutate(form)} className="btn-3d rounded-lg bg-accent px-8 py-3 font-black text-accent-foreground disabled:opacity-50">
            {save.isPending ? "保存中…" : "保存老虎机配置"}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <h2 className="t-section">老虎机结算审计</h2>
        <p className="mt-2 text-xs text-muted-foreground">记录服务端最终符号、下注、倍率、返还、净变化和概率配置版本。</p>
        <div className="mt-4 overflow-x-auto">
          <Table>
            <TableHeader><TableRow className="border-border hover:bg-transparent">
              <TableHead className={th}>时间 / 用户</TableHead><TableHead className={th}>符号</TableHead>
              <TableHead className={`text-right ${th}`}>下注</TableHead><TableHead className={`text-right ${th}`}>倍率 / 返还</TableHead>
              <TableHead className={`text-right ${th}`}>净变化</TableHead><TableHead className={th}>配置 / 资金快照</TableHead>
            </TableRow></TableHeader>
            <TableBody>{slotRounds.data?.items.map((round) => <TableRow key={round.id} className="border-border">
              <TableCell>
                <p className="text-xs text-muted-foreground">{new Date(round.createdAt).toLocaleString("zh-CN")}</p>
                <p className="text-foreground">{round.groupName ?? round.username ?? "-"}</p>
              </TableCell>
              <TableCell className="font-num text-sm">{round.symbols
                ? round.symbols.split(",").map((id) => slotGlyph[id] ?? id).join(" / ")
                : "旧版未记录"}</TableCell>
              <TableCell className="font-num text-right">${Number(round.bet).toFixed(2)}</TableCell>
              <TableCell className="font-num text-right">×{round.payoutMultiplier} / ${Number(round.grossPayout).toFixed(2)}</TableCell>
              <TableCell className={`font-num text-right ${round.netChange >= 0 ? "text-[#00B77D]" : "text-[#EF5459]"}`}>
                {round.netChange >= 0 ? "+" : ""}${Number(round.netChange).toFixed(2)}
              </TableCell>
              <TableCell className="max-w-[18rem] text-xs leading-5 text-muted-foreground">
                <p className="font-num break-all text-foreground">{round.configVersion}</p>
                <p>档位 {round.prizeTier} · 中奖率 {(round.winRatePpm / 10_000).toFixed(2)}% · RTP {(round.rtpPpm / 10_000).toFixed(2)}%</p>
                {round.fundBeforeUnits !== null && round.fundAfterUnits !== null && (
                  <p className="font-num">奖金池 ${(round.fundBeforeUnits / 100).toFixed(2)} → ${(round.fundAfterUnits / 100).toFixed(2)}</p>
                )}
                {round.promotionId && <p>活动 #{round.promotionId} · 预算 ${(Number(round.promotionBudgetBeforeUnits) / 100).toFixed(2)} → ${(Number(round.promotionBudgetAfterUnits) / 100).toFixed(2)}</p>}
              </TableCell>
            </TableRow>)}
            {slotRounds.isLoading && <TableRow className="border-border"><TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">加载老虎机记录中…</TableCell></TableRow>}
            {slotRounds.error && <TableRow className="border-border"><TableCell colSpan={6} className="py-8 text-center text-sm text-[#EF5459]">老虎机记录加载失败：{slotRounds.error.message} <button onClick={() => slotRounds.refetch()} className="ml-2 font-bold text-accent hover:underline">重试</button></TableCell></TableRow>}
            {!slotRounds.isLoading && !slotRounds.error && !slotRounds.data?.items.length && <TableRow className="border-border"><TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">暂无老虎机记录</TableCell></TableRow>}</TableBody>
          </Table>
          {slotRounds.data && (
            <Pager
              className="mt-4"
              page={slotRounds.data.page}
              totalPages={slotRounds.data.totalPages}
              total={slotRounds.data.total}
              pageSize={pageSize}
              onPage={setPage}
              onPageSize={(s) => { setPageSize(s); setPage(1); }}
            />
          )}
        </div>
      </div>
      <SlotOperations />
    </div>
  );
}
