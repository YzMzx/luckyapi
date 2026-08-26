import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pager } from "@/components/Pager";

type Draft = {
  id?: number;
  title: string;
  content: string;
  status: "draft" | "published" | "withdrawn";
  severity: "info" | "important" | "urgent";
  pinned: boolean;
  sortOrder: number;
  publishedAt: string;
  endsAt: string;
};

const emptyDraft: Draft = { title: "", content: "", status: "draft", severity: "info", pinned: false, sortOrder: 0, publishedAt: "", endsAt: "" };
const toLocal = (date: Date | null) => date ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "";

const STATUS_BADGE: Record<Draft["status"], { label: string; cls: string }> = {
  published: { label: "已发布", cls: "border-[#00B77D]/50 bg-[#00B77D]/10 text-[#00B77D]" },
  draft: { label: "草稿", cls: "border-border bg-white/5 text-muted-foreground" },
  withdrawn: { label: "已撤回", cls: "border-[#EF5459]/40 bg-[#EF5459]/10 text-[#EF5459]" },
};
const SEVERITY_BADGE: Record<Draft["severity"], { label: string; cls: string }> = {
  urgent: { label: "紧急", cls: "border-[#EF5459]/60 bg-[#EF5459]/10 text-[#EF5459]" },
  important: { label: "重要", cls: "border-accent/60 bg-accent/10 text-accent" },
  info: { label: "普通", cls: "border-primary/50 text-primary" },
};

export default function Announcements() {
  const utils = trpc.useUtils();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const list = trpc.admin.listAnnouncementsPage.useQuery({ page, pageSize });
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const refresh = () => { utils.admin.listAnnouncementsPage.invalidate(); utils.entertainment.invalidate(); };
  const fail = (error: { message: string }) => toast.error(error.message);
  const create = trpc.admin.createAnnouncement.useMutation({ onSuccess: () => { toast.success("公告已创建"); setDraft(emptyDraft); refresh(); }, onError: fail });
  const update = trpc.admin.updateAnnouncement.useMutation({ onSuccess: () => { toast.success("公告已更新"); setDraft(emptyDraft); refresh(); }, onError: fail });
  const publish = trpc.admin.publishAnnouncement.useMutation({ onSuccess: () => { toast.success("公告已发布"); refresh(); }, onError: fail });
  const withdraw = trpc.admin.withdrawAnnouncement.useMutation({ onSuccess: () => { toast.success("公告已撤回"); refresh(); }, onError: fail });
  const remove = trpc.admin.deleteAnnouncement.useMutation({ onSuccess: () => { toast.success("公告已删除"); refresh(); }, onError: fail });
  const payload = () => ({
    title: draft.title,
    content: draft.content,
    status: draft.status,
    severity: draft.severity,
    pinned: draft.pinned,
    sortOrder: draft.sortOrder,
    publishedAt: draft.publishedAt ? new Date(draft.publishedAt) : null,
    endsAt: draft.endsAt ? new Date(draft.endsAt) : null,
  });

  if (list.error) return <div className="rounded-xl border border-[#EF5459]/50 bg-card p-6 text-center"><p className="text-sm font-bold text-[#EF5459]">公告列表加载失败：{list.error.message}</p><button onClick={() => list.refetch()} className="mt-3 text-xs font-bold text-accent hover:underline">重试</button></div>;
  if (list.isLoading) return <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">加载公告列表中…</div>;

  return <div className="grid w-full max-w-[90rem] gap-6 xl:grid-cols-[420px_1fr]">
    <form className="h-fit rounded-xl border border-border bg-card p-6" onSubmit={(event) => {
      event.preventDefault();
      if (draft.id) update.mutate({ id: draft.id, ...payload() }); else create.mutate(payload());
    }}>
      <h2 className="t-section">{draft.id ? `编辑公告 #${draft.id}` : "新建公告"}</h2>
      <div className="mt-5 space-y-4">
        <div className="space-y-2"><Label>标题（最多 120 字）</Label><Input value={draft.title} maxLength={120} required onChange={(e) => setDraft({ ...draft, title: e.target.value })} className="border-border bg-[hsl(var(--admin-control))]" /></div>
        <div className="space-y-2"><Label>正文（纯文本，最多 10,000 字）</Label><Textarea value={draft.content} maxLength={10_000} required rows={10} onChange={(e) => setDraft({ ...draft, content: e.target.value })} className="border-border bg-[hsl(var(--admin-control))]" /></div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2"><Label>状态</Label><Select value={draft.status} onValueChange={(v) => setDraft({ ...draft, status: v as Draft["status"] })}><SelectTrigger className="w-full border-border bg-[hsl(var(--admin-control))]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="draft">草稿</SelectItem><SelectItem value="published">发布</SelectItem><SelectItem value="withdrawn">撤回</SelectItem></SelectContent></Select></div>
          <div className="space-y-2"><Label>重要级别</Label><Select value={draft.severity} onValueChange={(v) => setDraft({ ...draft, severity: v as Draft["severity"] })}><SelectTrigger className="w-full border-border bg-[hsl(var(--admin-control))]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="info">普通</SelectItem><SelectItem value="important">重要</SelectItem><SelectItem value="urgent">紧急</SelectItem></SelectContent></Select></div>
        </div>
        <div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label>发布时间（留空即发布时刻）</Label><Input type="datetime-local" value={draft.publishedAt} onChange={(e) => setDraft({ ...draft, publishedAt: e.target.value })} className="border-border bg-[hsl(var(--admin-control))]" /></div><div className="space-y-2"><Label>可选下线时间</Label><Input type="datetime-local" value={draft.endsAt} onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })} className="border-border bg-[hsl(var(--admin-control))]" /></div></div>
        <div className="flex items-center justify-between"><div className="flex items-center gap-2"><Switch checked={draft.pinned} onCheckedChange={(v) => setDraft({ ...draft, pinned: v })} /><Label>置顶</Label></div><div className="flex items-center gap-2"><Label>排序</Label><Input type="number" value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) })} className="w-24 border-border bg-[hsl(var(--admin-control))]" /></div></div>
      </div>
      <div className="mt-6 flex gap-3"><button type="submit" className="btn-3d flex-1 rounded-lg bg-accent py-2.5 font-black text-accent-foreground">{draft.id ? "保存修改" : "创建公告"}</button>{draft.id && <button type="button" onClick={() => setDraft(emptyDraft)} className="rounded-lg border border-border px-4 text-sm">取消</button>}</div>
    </form>

    <div className="rounded-xl border border-border bg-card p-6">
      <h2 className="t-section">公告列表</h2>
      <p className="mt-2 text-xs text-muted-foreground">用户只会看到处于发布状态、已到发布时间且未到下线时间的公告。</p>
      <div className="mt-4 overflow-x-auto"><Table><TableHeader><TableRow><TableHead>标题</TableHead><TableHead>状态</TableHead><TableHead>级别</TableHead><TableHead>窗口</TableHead><TableHead>排序</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>
        {list.data?.items.map((row) => <TableRow key={row.id}><TableCell><div className="font-bold">{row.pinned ? "[置顶] " : ""}{row.title}</div><div className="mt-1 max-w-md truncate text-xs text-muted-foreground">{row.content}</div></TableCell><TableCell><span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold ${STATUS_BADGE[row.status].cls}`}>{STATUS_BADGE[row.status].label}</span></TableCell><TableCell><span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold ${SEVERITY_BADGE[row.severity].cls}`}>{SEVERITY_BADGE[row.severity].label}</span></TableCell><TableCell className="text-xs">{row.publishedAt ? new Date(row.publishedAt).toLocaleString("zh-CN") : "未设置"}<br />{row.endsAt ? `至 ${new Date(row.endsAt).toLocaleString("zh-CN")}` : "长期"}</TableCell><TableCell>{row.sortOrder}</TableCell><TableCell><div className="flex justify-end gap-2">
          <button onClick={() => setDraft({ id: row.id, title: row.title, content: row.content, status: row.status, severity: row.severity, pinned: row.pinned, sortOrder: row.sortOrder, publishedAt: toLocal(row.publishedAt), endsAt: toLocal(row.endsAt) })} className="text-xs text-[#7db4ff]">编辑</button>
          {row.status !== "published" ? <button onClick={() => publish.mutate({ id: row.id })} className="text-xs text-[#35e0c8]">发布</button> : <button onClick={() => withdraw.mutate({ id: row.id })} className="text-xs text-accent">撤回</button>}
          <button onClick={() => window.confirm(`确认删除公告「${row.title}」？`) && remove.mutate({ id: row.id })} className="text-xs text-[#EF5459]">删除</button>
        </div></TableCell></TableRow>)}
        {!list.data?.items.length && <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">暂无公告</TableCell></TableRow>}
      </TableBody></Table></div>
      {list.data && (
        <Pager
          className="mt-4"
          page={list.data.page}
          totalPages={list.data.totalPages}
          total={list.data.total}
          pageSize={pageSize}
          onPage={setPage}
          onPageSize={(s) => { setPageSize(s); setPage(1); }}
        />
      )}
    </div>
  </div>;
}
