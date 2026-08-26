import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Pager } from "@/components/Pager";

export default function Usage() {
  const models = trpc.admin.listModels.useQuery(undefined);

  const [usageModelFilter, setUsageModelFilter] = useState("");
  const [usageKeyword, setUsageKeyword] = useState("");
  const [usageCacheFilter, setUsageCacheFilter] = useState("");
  const [usageDetailId, setUsageDetailId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const usageLogs = trpc.admin.listUsagePage.useQuery({
    page, pageSize,
    model: usageModelFilter || undefined,
    keyword: usageKeyword || undefined,
    cacheStatus: (usageCacheFilter || undefined) as "hit" | "write" | "hit_write" | "miss" | "unknown" | undefined,
  });
  const changeFilter = (fn: () => void) => { fn(); setPage(1); };

  const th = "text-muted-foreground";
  const usageDetail = usageLogs.data?.items.find((log) => log.id === usageDetailId) ?? null;
  return (
    <>
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Select value={usageModelFilter} onValueChange={(v) => changeFilter(() => setUsageModelFilter(v === "__all__" ? "" : v))}>
            <SelectTrigger className="w-44 border-border bg-[hsl(var(--admin-control))]"><SelectValue placeholder="全部模型" /></SelectTrigger>
            <SelectContent className="border-border bg-card text-foreground">
              <SelectItem value="__all__">全部模型</SelectItem>
              {models.data?.map((m) => <SelectItem key={m.id} value={m.name}>{m.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input value={usageKeyword} onChange={(e) => changeFilter(() => setUsageKeyword(e.target.value))}
            placeholder="按用户名 / 群内名称筛选"
            className="w-52 border-border bg-[hsl(var(--admin-control))] placeholder:text-muted-foreground/50" />
          <Select value={usageCacheFilter} onValueChange={(v) => changeFilter(() => setUsageCacheFilter(v === "__all__" ? "" : v))}>
            <SelectTrigger className="w-36 border-border bg-[hsl(var(--admin-control))]"><SelectValue placeholder="缓存状态" /></SelectTrigger>
            <SelectContent className="border-border bg-card text-foreground">
              <SelectItem value="__all__">全部缓存状态</SelectItem><SelectItem value="hit">命中</SelectItem>
              <SelectItem value="hit_write">命中+写入</SelectItem><SelectItem value="write">写入</SelectItem>
              <SelectItem value="miss">未命中</SelectItem><SelectItem value="unknown">未知</SelectItem>
            </SelectContent>
          </Select>
          {(usageModelFilter || usageKeyword || usageCacheFilter) && (
            <button className="text-xs text-primary hover:underline"
              onClick={() => changeFilter(() => { setUsageModelFilter(""); setUsageKeyword(""); setUsageCacheFilter(""); })}>清除筛选</button>
          )}
        </div>
        <Table>
          <TableHeader><TableRow className="border-border hover:bg-transparent">
            <TableHead className={th}>时间</TableHead><TableHead className={th}>用户</TableHead>
            <TableHead className={th}>Key</TableHead>
            <TableHead className={th}>模型 / 渠道</TableHead><TableHead className={`text-right ${th}`}>入/出/缓存</TableHead>
            <TableHead className={th}>缓存</TableHead>
            <TableHead className={`text-right ${th}`}>费用</TableHead>
            <TableHead className={`text-right ${th}`}>耗时</TableHead>
            <TableHead className={`text-right ${th}`}>状态</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {usageLogs.isLoading && (
              <TableRow className="border-border"><TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">加载中…</TableCell></TableRow>
            )}
            {usageLogs.error && (
              <TableRow className="border-border"><TableCell colSpan={9} className="py-8 text-center text-sm text-[#EF5459]">{usageLogs.error.message}</TableCell></TableRow>
            )}
            {usageLogs.data?.items.map((l) => (
              <TableRow key={l.id} className="cursor-pointer border-border" onClick={() => setUsageDetailId(l.id)}>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(l.createdAt).toLocaleString("zh-CN")}</TableCell>
                <TableCell className="text-foreground">{l.groupName ?? l.username ?? "-"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{l.keyName ?? l.keyPrefix ?? "-"}</TableCell>
                <TableCell className="font-num text-muted-foreground">
                  {l.model}
                  {l.stream && <span className="ml-1 rounded bg-[#176EFF]/20 px-1 text-[10px] text-[#7db4ff]">流</span>}
                  {l.upstreamName && <span className="block text-[10px]">{l.upstreamName}</span>}
                </TableCell>
                <TableCell className="font-num text-right text-xs text-muted-foreground">
                  {l.promptTokens} / {l.completionTokens} / {l.cacheReadTokens + l.cacheWriteTokens}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{{ hit: "命中", write: "写入", hit_write: "命中+写入", miss: "未命中", unknown: "未知" }[l.cacheStatus] ?? l.cacheStatus}<span className="block text-[10px]">{l.usageSource === "upstream" ? "上游" : "估算"}</span></TableCell>
                <TableCell className="font-num text-right text-accent">
                  {l.status === "ok" ? `$${Number(l.cost).toFixed(4)}` : "—"}
                </TableCell>
                <TableCell className="font-num text-right text-xs text-muted-foreground">
                  {(l.durationMs / 1000).toFixed(1)}s
                  {l.stream && l.ttftMs > 0 && <span className="block text-[10px]">首字 {(l.ttftMs / 1000).toFixed(1)}s</span>}
                </TableCell>
                <TableCell className="text-right">
                  {l.status === "ok"
                    ? <span className="text-xs text-[#00B77D]">成功</span>
                    : <span className="text-xs text-[#EF5459]">失败</span>}
                </TableCell>
              </TableRow>
            ))}
            {usageLogs.data && !usageLogs.data.items.length && (
              <TableRow className="border-border"><TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">暂无调用记录</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        {usageLogs.data && (
          <Pager className="mt-4" page={usageLogs.data.page} totalPages={usageLogs.data.totalPages}
            total={usageLogs.data.total} pageSize={pageSize}
            onPage={setPage} onPageSize={(s) => { setPageSize(s); setPage(1); }} />
        )}
      </div>

      <Dialog open={!!usageDetail} onOpenChange={(open) => !open && setUsageDetailId(null)}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto border-border bg-card text-foreground">
          <DialogHeader><DialogTitle className="break-all">调用详情 #{usageDetail?.requestId || usageDetail?.id}</DialogTitle></DialogHeader>
          {usageDetail && <div className="space-y-4 text-xs">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <p>用户 / Key<br /><span className="text-muted-foreground">{usageDetail.groupName ?? usageDetail.username ?? "-"} · {usageDetail.keyName ?? usageDetail.keyPrefix ?? "-"}</span></p>
              <p>模型 / 渠道<br /><span className="font-num text-muted-foreground">{usageDetail.model} · {usageDetail.upstreamName ?? "-"}</span></p>
              <p>协议 / 路径<br /><span className="font-num text-muted-foreground">{usageDetail.protocol} · {usageDetail.endpoint}</span></p>
              <p>HTTP / 耗时<br /><span className="font-num text-muted-foreground">{usageDetail.httpStatus} · {usageDetail.durationMs}ms（首字 {usageDetail.ttftMs}ms）</span></p>
            </div>
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <p>输入<br /><span className="font-num">{usageDetail.promptTokens}</span></p><p>输出<br /><span className="font-num">{usageDetail.completionTokens}</span></p>
              <p>缓存写<br /><span className="font-num">{usageDetail.cacheWriteTokens}</span></p><p>缓存读<br /><span className="font-num">{usageDetail.cacheReadTokens}</span></p>
              <p>倍率<br /><span className="font-num">×{usageDetail.groupMultiplier}</span></p><p>合计<br /><span className="font-num text-accent">${Number(usageDetail.cost).toFixed(6)}</span></p>
            </div>
            <p className="text-muted-foreground">费用拆分：输入 ${Number(usageDetail.inputCost).toFixed(6)} / 输出 ${Number(usageDetail.outputCost).toFixed(6)} / 缓存写 ${Number(usageDetail.cacheWriteCost).toFixed(6)} / 缓存读 ${Number(usageDetail.cacheReadCost).toFixed(6)}</p>
            {usageDetail.errorMessage && <div className="rounded border border-[#EF5459]/30 bg-[#EF5459]/5 p-3 text-[#EF5459]">{usageDetail.errorMessage}</div>}
            <div><p className="mb-1 font-bold">输入（已脱敏，最大 64 KiB）</p><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-[hsl(var(--admin-control))] p-3 text-muted-foreground">{usageDetail.requestBody || "（未记录）"}</pre></div>
            <div><p className="mb-1 font-bold">输出（最大 64 KiB）</p><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-[hsl(var(--admin-control))] p-3 text-muted-foreground">{usageDetail.responseBody || "（未记录）"}</pre></div>
          </div>}
        </DialogContent>
      </Dialog>
    </>
  );
}
