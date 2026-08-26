import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useMe } from "@/hooks/useMe";
import { ConsoleLayout } from "@/components/ConsoleLayout";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pager } from "@/components/Pager";
import { cn } from "@/lib/utils";

const ACTIVE_FILTERS = [
  { v: "all", label: "全部" },
  { v: "on", label: "已启用" },
  { v: "off", label: "已停用" },
] as const;

export default function ConsoleKeys() {
  const { user, isLoading } = useMe({ requireAuth: true, requireOnboarded: true });
  const utils = trpc.useUtils();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [active, setActive] = useState<"all" | "on" | "off">("all");
  const keys = trpc.member.listKeysPage.useQuery(
    { page, pageSize, active: active === "all" ? undefined : active === "on" },
    { enabled: !!user?.onboarded },
  );
  const groupList = trpc.member.listGroups.useQuery(undefined, { enabled: !!user?.onboarded });

  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [name, setName] = useState("");
  const [groupId, setGroupId] = useState("0");
  const [quota, setQuota] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [keyEdit, setKeyEdit] = useState<{
    id: number; name: string; groupId: string; quota: string; expiresAt: string;
  } | null>(null);

  const createKey = trpc.member.createKey.useMutation({
    onSuccess: (d) => { setNewKey(d.key); setCreating(false); setName(""); setQuota(""); setExpiresAt(""); utils.member.listKeysPage.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const revokeKey = trpc.member.revokeKey.useMutation({
    onSuccess: (r) => { toast.success(r.active ? "已启用" : "已停用"); utils.member.listKeysPage.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const updateKey = trpc.member.updateKey.useMutation({
    onSuccess: () => { toast.success("密钥设置已更新"); setKeyEdit(null); utils.member.listKeysPage.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const deleteKey = trpc.member.deleteKey.useMutation({
    onSuccess: () => { toast.success("密钥已永久删除"); utils.member.listKeysPage.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  if (isLoading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;

  return (
    <ConsoleLayout user={user} title="API 密钥" desc="密钥只完整显示一次，请立即保存。请求头：Authorization: Bearer sk-xxx">
      <div className="space-y-6">
        {/* 新建 */}
        <section className="rounded-xl border border-border bg-[#101d2b] p-5 sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="t-section">我的密钥</h2>
            <button onClick={() => setCreating(!creating)}
              className="btn-3d rounded-lg bg-[#FFB700] px-5 py-2 text-sm font-black text-[#162638]">+ 新建密钥</button>
          </div>

          {creating && (
            <form className="mt-5 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-[#162638] p-4" onSubmit={(e) => {
              e.preventDefault();
              createKey.mutate({
                name: name || "默认 Key",
                groupId: groupId === "0" ? null : Number(groupId),
                quota: quota.trim() === "" ? null : Number(quota),
                expiresAt: expiresAt ? new Date(expiresAt) : null,
              });
            }}>
              <div className="w-full space-y-1.5 sm:w-48"><Label className="text-xs text-muted-foreground">名称</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：测试项目" className="border-border bg-[#101d2b]" /></div>
              <div className="w-full space-y-1.5 sm:w-44"><Label className="text-xs text-muted-foreground">分组</Label>
                <Select value={groupId} onValueChange={setGroupId}>
                  <SelectTrigger className="border-border bg-[#101d2b]"><SelectValue /></SelectTrigger>
                  <SelectContent className="border-border bg-[#101d2b] text-[#fce1b6]">
                    <SelectItem value="0">默认分组</SelectItem>
                    {groupList.data?.map((g) => <SelectItem key={g.id} value={String(g.id)}>{g.name}（×{g.multiplier}）</SelectItem>)}
                  </SelectContent>
                </Select></div>
              <div className="w-full space-y-1.5 sm:w-40"><Label className="text-xs text-muted-foreground">独立额度 $（留空不限）</Label>
                <Input type="number" min="0" step="0.01" value={quota} onChange={(e) => setQuota(e.target.value)} placeholder="不限" className="border-border bg-[#101d2b] placeholder:text-muted-foreground/40" /></div>
              <div className="w-full space-y-1.5 sm:w-52"><Label className="text-xs text-muted-foreground">过期时间（留空永久）</Label>
                <Input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="border-border bg-[#101d2b]" /></div>
              <button type="submit" disabled={createKey.isPending}
                className="btn-3d rounded-lg bg-[#FFB700] px-6 py-2 text-sm font-black text-[#162638] disabled:opacity-50">
                {createKey.isPending ? "创建中…" : "创建"}
              </button>
            </form>
          )}

          {newKey && (
            <div className="mt-5 rounded-lg border border-[#FFB700]/40 bg-[#FFB700]/5 p-4">
              <p className="text-xs text-[#FFB700]">密钥只显示这一次，请立即复制保存：</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="font-num break-all text-sm text-[#00B77D]">{newKey}</code>
                <button className="shrink-0 text-xs text-[#af915f] hover:underline"
                  onClick={() => { navigator.clipboard.writeText(newKey); toast.success("已复制"); }}>复制</button>
                <button className="shrink-0 text-xs text-muted-foreground hover:underline" onClick={() => setNewKey("")}>我已保存</button>
              </div>
            </div>
          )}

          {/* 筛选 */}
          <div className="mt-5 flex flex-wrap gap-2">
            {ACTIVE_FILTERS.map((f) => (
              <button key={f.v} onClick={() => { setActive(f.v); setPage(1); }}
                className={cn("rounded-full px-3 py-1 text-xs font-semibold transition-colors",
                  active === f.v ? "bg-[#FFB700] text-[#162638]" : "border border-border text-muted-foreground hover:text-[#fce1b6]")}>
                {f.label}
              </button>
            ))}
          </div>

          {/* 密钥列表 */}
          <div className="mt-4 space-y-3">
            {keys.isLoading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">加载密钥中…</p>
            ) : keys.error ? (
              <div className="py-8 text-center"><p className="text-sm font-bold text-[#EF5459]">密钥列表加载失败：{keys.error.message}</p><button onClick={() => keys.refetch()} className="mt-3 text-xs font-bold text-[#FFB700] hover:underline">重试</button></div>
            ) : keys.data?.items.length ? keys.data.items.map((k) => (
              <div key={k.id} className="rounded-lg border border-border bg-[#162638] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-bold text-[#fce1b6]">
                      {k.name}
                      {!k.active && <span className="ml-2 rounded bg-[#EF5459]/15 px-2 py-0.5 text-[10px] font-bold text-[#EF5459]">已停用</span>}
                    </p>
                    <p className="font-num mt-1 text-xs text-muted-foreground">{k.prefix}…</p>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <Switch checked={k.active} onCheckedChange={() => revokeKey.mutate({ id: k.id })} />
                    <button className="text-[#af915f] hover:underline" onClick={() => setKeyEdit({
                      id: k.id,
                      name: k.name,
                      groupId: k.groupId === null ? "0" : String(k.groupId),
                      quota: k.quota === null ? "" : String(k.quota),
                      expiresAt: k.expiresAt ? new Date(k.expiresAt.getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "",
                    })}>编辑</button>
                    <button className="text-[#EF5459] hover:underline" onClick={() => {
                      if (confirm(`永久删除密钥「${k.name}」？历史调用日志会保留。`)) deleteKey.mutate({ id: k.id });
                    }}>删除</button>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>分组：<span className="text-[#fce1b6]">{k.groupName ?? "默认"}</span>{k.groupMultiplier !== null && k.groupMultiplier !== undefined && <span className="text-[#af915f]">（×{k.groupMultiplier}）</span>}</span>
                  <span>额度：
                    {k.quota === null
                      ? <span className="text-[#00B77D]">不限</span>
                      : <span className={Number(k.quota) > 0 ? "font-num text-[#FFB700]" : "font-num text-[#EF5459]"}>${Number(k.quota).toFixed(4)}</span>}
                  </span>
                  <span>累计 {k.usageCalls} 次 / ${Number(k.usageCost).toFixed(4)}</span>
                  <span>过期：{k.expiresAt ? new Date(k.expiresAt).toLocaleString("zh-CN") : "永不过期"}</span>
                  {k.lastUsedAt && <span>最近使用 {new Date(k.lastUsedAt).toLocaleString("zh-CN")}</span>}
                  {k.lastUsedIp && <span className="font-num">IP {k.lastUsedIp}</span>}
                </div>
                {keyEdit?.id === k.id && (
                  <form className="mt-3 grid gap-2 rounded-lg border border-border bg-[#101d2b] p-3 sm:grid-cols-2 lg:grid-cols-5" onSubmit={(e) => {
                    e.preventDefault();
                    updateKey.mutate({
                      id: k.id,
                      name: keyEdit.name.trim(),
                      groupId: keyEdit.groupId === "0" ? null : Number(keyEdit.groupId),
                      quota: keyEdit.quota.trim() === "" ? null : Number(keyEdit.quota),
                      expiresAt: keyEdit.expiresAt ? new Date(keyEdit.expiresAt) : null,
                    });
                  }}>
                    <Input value={keyEdit.name} onChange={(e) => setKeyEdit({ ...keyEdit, name: e.target.value })} placeholder="名称" required />
                    <Select value={keyEdit.groupId} onValueChange={(value) => setKeyEdit({ ...keyEdit, groupId: value })}>
                      <SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
                        <SelectItem value="0">默认分组</SelectItem>
                        {groupList.data?.map((g) => <SelectItem key={g.id} value={String(g.id)}>{g.name}（×{g.multiplier}）</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Input type="number" min="0" step="0.01" value={keyEdit.quota} onChange={(e) => setKeyEdit({ ...keyEdit, quota: e.target.value })} placeholder="额度：留空不限" />
                    <Input type="datetime-local" value={keyEdit.expiresAt} onChange={(e) => setKeyEdit({ ...keyEdit, expiresAt: e.target.value })} />
                    <div className="flex items-center gap-2">
                      <button type="submit" disabled={updateKey.isPending} className="rounded bg-[#FFB700] px-3 py-1.5 text-xs font-bold text-[#162638]">保存</button>
                      <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => setKeyEdit(null)}>取消</button>
                    </div>
                  </form>
                )}
              </div>
            )) : (
              <p className="py-8 text-center text-sm text-muted-foreground">暂无密钥，点右上角创建一个</p>
            )}
            {keys.data && (
              <Pager
                className="pt-2"
                page={keys.data.page}
                totalPages={keys.data.totalPages}
                total={keys.data.total}
                pageSize={pageSize}
                onPage={setPage}
                onPageSize={(s) => { setPageSize(s); setPage(1); }}
              />
            )}
          </div>
        </section>
      </div>
    </ConsoleLayout>
  );
}
