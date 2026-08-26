import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useMe } from "@/hooks/useMe";
import { ConsoleLayout } from "@/components/ConsoleLayout";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Pager } from "@/components/Pager";

const cacheLabel: Record<string, string> = {
  hit: "命中",
  write: "写入",
  hit_write: "命中+写入",
  miss: "未命中",
  unknown: "未知",
};

export default function ConsoleUsage() {
  const { user, isLoading } = useMe({ requireAuth: true, requireOnboarded: true });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const usage = trpc.member.myUsage.useQuery({ page, pageSize }, { enabled: !!user?.onboarded });
  const [detailId, setDetailId] = useState<number | null>(null);

  if (isLoading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;

  const s = usage.data?.summary;
  const cards = [
    { label: "今日调用", value: `${s?.todayCalls ?? 0} 次`, sub: `消耗 $${Number(s?.todayCost ?? 0).toFixed(4)}` },
    { label: "本月调用", value: `${s?.monthCalls ?? 0} 次`, sub: `消耗 $${Number(s?.monthCost ?? 0).toFixed(4)}` },
    { label: "累计调用", value: `${s?.totalCalls ?? 0} 次`, sub: `消耗 $${Number(s?.totalCost ?? 0).toFixed(4)}` },
    { label: "累计 Tokens", value: `${(Number(s?.totalPrompt ?? 0) + Number(s?.totalCompletion ?? 0)).toLocaleString()}`, sub: `输入 ${Number(s?.totalPrompt ?? 0).toLocaleString()} / 输出 ${Number(s?.totalCompletion ?? 0).toLocaleString()}` },
    { label: "缓存命中率", value: Number(s?.cacheKnownCalls ?? 0) ? `${(Number(s?.cacheHitCalls ?? 0) / Number(s?.cacheKnownCalls ?? 1) * 100).toFixed(1)}%` : "暂无", sub: `读 ${Number(s?.totalCacheRead ?? 0).toLocaleString()} / 写 ${Number(s?.totalCacheWrite ?? 0).toLocaleString()} tokens` },
    { label: "平均耗时", value: `${(Number(s?.averageDurationMs ?? 0) / 1000).toFixed(2)}s`, sub: "按全部历史调用计算" },
  ];
  const detail = usage.data?.logs.find((log) => log.id === detailId) ?? null;

  return (
    <ConsoleLayout user={user} title="消耗记录" desc="API 调用明细，支持分页查看">
      <div className="space-y-6">
        {/* 汇总卡片 */}
        <section className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-3 xl:grid-cols-6">
          {cards.map((c) => (
            <div key={c.label} className="bg-[#101d2b] p-4 sm:p-6">
              <p className="text-xs text-muted-foreground">{c.label}</p>
              <p className="font-num mt-2 text-xl font-black text-[#FFB700] sm:text-2xl">{c.value}</p>
              <p className="mt-1 text-[11px] text-[#af915f]">{c.sub}</p>
            </div>
          ))}
        </section>

        {/* 明细表 */}
        <section className="overflow-x-auto rounded-xl border border-border bg-[#101d2b] p-2 sm:p-4">
          <Table>
            <TableHeader><TableRow className="border-border hover:bg-transparent">
              <TableHead className="text-muted-foreground">时间</TableHead>
              <TableHead className="text-muted-foreground">密钥</TableHead>
              <TableHead className="text-muted-foreground">模型</TableHead>
              <TableHead className="text-right text-muted-foreground">Tokens</TableHead>
              <TableHead className="text-muted-foreground">缓存</TableHead>
              <TableHead className="text-right text-muted-foreground">费用</TableHead>
              <TableHead className="text-right text-muted-foreground">耗时</TableHead>
              <TableHead className="text-muted-foreground">状态</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {usage.data?.logs.map((l) => (
                <TableRow key={l.id} className="cursor-pointer border-border" onClick={() => setDetailId(l.id)}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {new Date(l.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{l.keyName ?? l.keyPrefix ?? "-"}</TableCell>
                  <TableCell className="font-num text-xs text-[#fce1b6]">
                    {l.model}
                    {l.stream && <span className="ml-1 rounded bg-[#176EFF]/20 px-1 text-[10px] text-[#7db4ff]">流</span>}
                  </TableCell>
                  <TableCell className="font-num text-right text-xs text-muted-foreground">
                    {l.promptTokens}+{l.completionTokens}
                    {(l.cacheReadTokens ?? 0) > 0 && <span className="block text-[10px]">缓存读 {l.cacheReadTokens}</span>}
                  </TableCell>
                  <TableCell className="text-xs">
                    <span className={l.cacheStatus === "unknown" ? "text-muted-foreground" : l.cacheStatus === "miss" ? "text-[#af915f]" : "text-[#00B77D]"}>
                      {cacheLabel[l.cacheStatus] ?? l.cacheStatus}
                    </span>
                    <span className="block text-[10px] text-muted-foreground">{l.usageSource === "upstream" ? "上游明细" : "本地估算"}</span>
                  </TableCell>
                  <TableCell className="font-num text-right text-xs text-[#FFB700]">${Number(l.cost).toFixed(6)}</TableCell>
                  <TableCell className="font-num text-right text-xs text-muted-foreground">{(l.durationMs / 1000).toFixed(1)}s</TableCell>
                  <TableCell className={`text-xs ${l.status === "ok" ? "text-[#00B77D]" : "text-[#EF5459]"}`}>
                    {l.status === "ok" ? "成功" : "失败"}
                  </TableCell>
                </TableRow>
              ))}
              {!usage.data?.logs.length && (
                <TableRow className="border-border"><TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">暂无调用记录</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
          {usage.data && usage.data.total > 0 && (
            <Pager
              className="mt-3 px-2 pb-2"
              page={usage.data.page}
              totalPages={usage.data.totalPages}
              total={usage.data.total}
              pageSize={pageSize}
              onPage={setPage}
              onPageSize={(s) => { setPageSize(s); setPage(1); }}
            />
          )}
        </section>
        <section className="rounded-xl border border-border bg-[#101d2b] p-4 text-xs text-muted-foreground">
          <p className="font-bold text-[#fce1b6]">缓存判定规则</p>
          <p className="mt-1">缓存读 tokens &gt; 0 为“命中”；缓存写 tokens &gt; 0 为“写入”；上游明确返回缓存字段且读写均为 0 为“未命中”；上游未提供缓存字段或 tokens 只能本地估算时显示“未知”，不会再把未知误判为未命中。</p>
        </section>
      </div>

      <Dialog open={!!detail} onOpenChange={(open) => !open && setDetailId(null)}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto border-border bg-[#101d2b] text-[#fce1b6]">
          <DialogHeader><DialogTitle className="break-all">调用详情 #{detail?.requestId || detail?.id}</DialogTitle></DialogHeader>
          {detail && <div className="space-y-4 text-xs">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <p>协议 / 路径<br /><span className="font-num text-muted-foreground">{detail.protocol} · {detail.endpoint || "-"}</span></p>
              <p>HTTP / 状态<br /><span className="font-num text-muted-foreground">{detail.httpStatus} · {detail.status}</span></p>
              <p>总耗时 / 首字<br /><span className="font-num text-muted-foreground">{detail.durationMs}ms / {detail.ttftMs}ms</span></p>
              <p>缓存<br /><span className="text-muted-foreground">{cacheLabel[detail.cacheStatus]}（{detail.usageSource === "upstream" ? "上游报告" : "本地估算"}）</span></p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <p>普通输入费用<br /><span className="font-num">${Number(detail.inputCost).toFixed(6)}</span></p>
              <p>输出费用<br /><span className="font-num">${Number(detail.outputCost).toFixed(6)}</span></p>
              <p>缓存写 / 读费用<br /><span className="font-num">${Number(detail.cacheWriteCost).toFixed(6)} / ${Number(detail.cacheReadCost).toFixed(6)}</span></p>
              <p>分组倍率 / 合计<br /><span className="font-num">×{detail.groupMultiplier} / ${Number(detail.cost).toFixed(6)}</span></p>
            </div>
            {detail.errorMessage && <div className="rounded border border-[#EF5459]/30 bg-[#EF5459]/5 p-3 text-[#EF5459]">{detail.errorMessage}</div>}
            <div><p className="mb-1 font-bold">输入（已脱敏，最大 64 KiB）</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-[#162638] p-3 text-muted-foreground">{detail.requestBody || "（未记录）"}</pre></div>
            <div><p className="mb-1 font-bold">输出（最大 64 KiB）</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-[#162638] p-3 text-muted-foreground">{detail.responseBody || "（未记录）"}</pre></div>
            {detail.upstreamRequestId && <p className="font-num text-muted-foreground">上游 Request ID：{detail.upstreamRequestId}</p>}
          </div>}
        </DialogContent>
      </Dialog>
    </ConsoleLayout>
  );
}
