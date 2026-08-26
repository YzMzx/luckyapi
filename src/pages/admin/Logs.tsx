import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Pager } from "@/components/Pager";

export default function Logs() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const adminLogs = trpc.admin.listAdminLogsPage.useQuery({ page, pageSize });

  return (
    <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
      <p className="mb-4 text-xs text-muted-foreground">后台关键操作留痕</p>
      <div className="space-y-2">
        {adminLogs.data?.items.map((l) => (
          <div key={l.id} className="flex items-center gap-3 rounded-lg border border-border bg-[hsl(var(--admin-control))] px-4 py-2.5">
            <span className="shrink-0 rounded bg-accent/15 px-2 py-0.5 text-xs font-bold text-accent">{l.action}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">{l.detail}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{new Date(l.createdAt).toLocaleString("zh-CN")}</span>
          </div>
        ))}
        {adminLogs.isLoading && <p className="py-10 text-center text-sm text-muted-foreground">加载操作日志中…</p>}
        {adminLogs.error && (
          <p className="py-10 text-center text-sm text-[#EF5459]">操作日志加载失败：{adminLogs.error.message}
            <button onClick={() => adminLogs.refetch()} className="ml-2 font-bold text-accent hover:underline">重试</button>
          </p>
        )}
        {!adminLogs.isLoading && !adminLogs.error && !adminLogs.data?.items.length && <p className="py-10 text-center text-sm text-muted-foreground">暂无操作日志</p>}
      </div>
      {adminLogs.data && (
        <Pager
          className="mt-4"
          page={adminLogs.data.page}
          totalPages={adminLogs.data.totalPages}
          total={adminLogs.data.total}
          pageSize={pageSize}
          onPage={setPage}
          onPageSize={(s) => { setPageSize(s); setPage(1); }}
        />
      )}
    </div>
  );
}
