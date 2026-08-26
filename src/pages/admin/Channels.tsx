import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { emptyUpstream, type UpstreamForm } from "./shared";
import { Pager } from "@/components/Pager";

export default function Channels() {
  const utils = trpc.useUtils();
  const [upPage, setUpPage] = useState(1);
  const [upPageSize, setUpPageSize] = useState(20);
  const upstreamList = trpc.admin.listUpstreamsPage.useQuery({ page: upPage, pageSize: upPageSize });
  const models = trpc.admin.listModels.useQuery(undefined);
  const groupList = trpc.admin.listGroups.useQuery(undefined);

  const [upstreamForm, setUpstreamForm] = useState<UpstreamForm | null>(null);
  // 上游「获取模型 → 勾选批量添加」弹窗
  const [modelPicker, setModelPicker] = useState<{ upstreamId: number; upstreamName: string } | null>(null);
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);
  const [modelPickSel, setModelPickSel] = useState<string[]>([]);
  const [modelPickGroups, setModelPickGroups] = useState<string[]>([]);
  const [modelPickApiType, setModelPickApiType] = useState<"chat" | "responses" | "claude" | "gemini">("chat");

  const ok = (msg: string) => () => { toast.success(msg); utils.admin.invalidate(); };
  const fail = (e: { message: string }) => toast.error(e.message);

  const upsertUpstream = trpc.admin.upsertUpstream.useMutation({
    onSuccess: () => { toast.success("已保存"); setUpstreamForm(null); utils.admin.invalidate(); },
    onError: fail,
  });
  const deleteUpstream = trpc.admin.deleteUpstream.useMutation({ onSuccess: ok("已删除"), onError: fail });
  const testUpstream = trpc.admin.testUpstream.useMutation({
    onSuccess: (r) => { utils.admin.listUpstreamsPage.invalidate(); return r.ok ? toast.success(r.message) : toast.error(r.message); },
    onError: fail,
  });
  const fetchModels = trpc.admin.fetchUpstreamModels.useMutation({
    onSuccess: (r) => {
      if (!r.ok) { toast.error(r.message); setFetchedModels([]); return; }
      setFetchedModels(r.models);
      // 默认勾选尚未添加的模型
      const existing = new Set((models.data ?? []).map((m) => m.name));
      setModelPickSel(r.models.filter((n) => !existing.has(n)));
    },
    onError: fail,
  });
  const batchAddModels = trpc.admin.upsertModel.useMutation({
    onSuccess: (r) => {
      toast.success(`新建 ${r.created} 个模型${r.skipped ? `，跳过重名 ${r.skipped} 个` : ""}，去「模型与定价」页设置价格`);
      setModelPicker(null); setFetchedModels(null); setModelPickSel([]); setModelPickGroups([]);
      utils.admin.invalidate();
    },
    onError: fail,
  });

  return (
    <>
      <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            上游 = 中转站 / 官方接口的地址 + 密钥。配一次，多个模型共用。地址填域名或域名/v1 均可，网关自动归一。
          </p>
          <button onClick={() => setUpstreamForm({ ...emptyUpstream })}
            className="btn-3d rounded-lg bg-accent px-5 py-2 text-sm font-black text-accent-foreground">+ 添加上游</button>
        </div>
        <div className="mt-6 space-y-3">
          {upstreamList.data?.items.length ? upstreamList.data.items.map((u) => (
            <div key={u.id} className="rounded-lg border border-border bg-[hsl(var(--admin-control))] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold text-foreground">
                    {u.name}
                    <span className="ml-2 rounded bg-[#176EFF]/15 px-2 py-0.5 text-[10px] font-bold text-[#7db4ff]">{u.modelCount} 个模型</span>
                    {!u.enabled && <span className="ml-2 rounded bg-[#EF5459]/15 px-2 py-0.5 text-[10px] font-bold text-[#EF5459]">已停用</span>}
                  </p>
                  <p className="font-num mt-1 break-all text-xs text-muted-foreground">{u.baseUrl} · {u.apiKeyMasked}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    超时 {u.timeoutMs}ms · 健康状态：{u.lastTestedAt ? (u.lastTestOk ? "正常" : "异常") : "未测试"}
                    {u.lastTestLatencyMs !== null && ` · ${u.lastTestLatencyMs}ms`}
                    {u.lastTestedAt && ` · ${new Date(u.lastTestedAt).toLocaleString("zh-CN")}`}
                  </p>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <Switch checked={u.enabled}
                    onCheckedChange={(v) => upsertUpstream.mutate({ id: u.id, name: u.name, baseUrl: u.baseUrl, apiKey: "", enabled: v, timeoutMs: u.timeoutMs })} />
                  <button className="font-bold text-accent hover:underline"
                    onClick={() => {
                      setModelPicker({ upstreamId: u.id, upstreamName: u.name });
                      setFetchedModels(null); setModelPickSel([]); setModelPickGroups([]);
                      fetchModels.mutate({ id: u.id });
                    }}>＋模型</button>
                  <button className="text-[#00B77D] hover:underline" disabled={testUpstream.isPending}
                    onClick={() => testUpstream.mutate({ id: u.id })}>{testUpstream.isPending ? "测试中…" : "测试"}</button>
                  <button className="text-primary hover:underline"
                    onClick={() => setUpstreamForm({ id: u.id, name: u.name, baseUrl: u.baseUrl, apiKey: "", enabled: u.enabled, timeoutMs: String(u.timeoutMs) })}>编辑</button>
                  <button className="text-[#EF5459] hover:underline"
                    onClick={() => { if (confirm(`删除上游 ${u.name}？`)) deleteUpstream.mutate({ id: u.id }); }}>删除</button>
                </div>
              </div>
            </div>
          )) : <p className="py-10 text-center text-sm text-muted-foreground">还没有上游，先添加一个（比如你的中转站地址 + 密钥）</p>}
        </div>
        {upstreamList.data && (
          <Pager
            className="mt-4"
            page={upstreamList.data.page}
            totalPages={upstreamList.data.totalPages}
            total={upstreamList.data.total}
            pageSize={upPageSize}
            onPage={setUpPage}
            onPageSize={(s) => { setUpPageSize(s); setUpPage(1); }}
          />
        )}
      </div>

      {/* 上游编辑弹窗 */}
      <Dialog open={!!upstreamForm} onOpenChange={(o) => !o && setUpstreamForm(null)}>
        <DialogContent className="border-border bg-card text-foreground">
          <DialogHeader><DialogTitle>{upstreamForm?.id ? "编辑上游" : "添加上游"}</DialogTitle></DialogHeader>
          {upstreamForm && (
            <form className="space-y-4" onSubmit={(e) => {
              e.preventDefault();
              upsertUpstream.mutate({
                id: upstreamForm.id, name: upstreamForm.name.trim(),
                baseUrl: upstreamForm.baseUrl.trim(), apiKey: upstreamForm.apiKey.trim(),
                enabled: upstreamForm.enabled,
                timeoutMs: Number(upstreamForm.timeoutMs),
              });
            }}>
              <div className="space-y-1.5"><Label className="text-xs text-primary">名称（备注用）</Label>
                <Input value={upstreamForm.name} onChange={(e) => setUpstreamForm({ ...upstreamForm, name: e.target.value })}
                  placeholder="如：NB 中转站" className="border-border bg-[hsl(var(--admin-control))]" required /></div>
              <div className="space-y-1.5"><Label className="text-xs text-primary">Base URL</Label>
                <Input value={upstreamForm.baseUrl} onChange={(e) => setUpstreamForm({ ...upstreamForm, baseUrl: e.target.value })}
                  placeholder="https://api.example.com/v1" className="border-border bg-[hsl(var(--admin-control))]" required />
                <p className="text-[11px] text-[#8a7a56]">填域名或域名/v1 均可，网关自动归一：chat/responses/claude 透传到 /v1/xxx，Gemini 透传到 /v1beta/xxx</p></div>
              <div className="space-y-1.5"><Label className="text-xs text-primary">API Key</Label>
                <Input value={upstreamForm.apiKey} onChange={(e) => setUpstreamForm({ ...upstreamForm, apiKey: e.target.value })}
                  placeholder={upstreamForm.id ? "留空保留现有密钥" : "sk-..."} className="border-border bg-[hsl(var(--admin-control))]" required={!upstreamForm.id} />
                {upstreamForm.id && <p className="text-[11px] text-muted-foreground">出于安全考虑，后台不回显上游密钥；只有填写新值时才会替换。</p>}</div>
              <div className="space-y-1.5"><Label className="text-xs text-primary">请求超时（毫秒）</Label>
                <Input type="number" min="1000" max="300000" step="1000" value={upstreamForm.timeoutMs}
                  onChange={(e) => setUpstreamForm({ ...upstreamForm, timeoutMs: e.target.value })}
                  className="border-border bg-[hsl(var(--admin-control))]" required /></div>
              <button type="submit" disabled={upsertUpstream.isPending}
                className="btn-3d w-full rounded-lg bg-accent py-2.5 font-black text-accent-foreground disabled:opacity-50">
                {upsertUpstream.isPending ? "保存中…" : "保存"}
              </button>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* 上游模型拉取 / 批量添加弹窗 */}
      <Dialog open={!!modelPicker} onOpenChange={(o) => { if (!o) { setModelPicker(null); setFetchedModels(null); } }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-card text-foreground">
          <DialogHeader><DialogTitle>从「{modelPicker?.upstreamName}」添加模型</DialogTitle></DialogHeader>
          {modelPicker && (
            <div className="space-y-4">
              {fetchedModels === null ? (
                <p className="py-8 text-center text-sm text-muted-foreground">正在从上游拉取模型列表…</p>
              ) : fetchedModels.length === 0 ? (
                <div className="py-6 text-center">
                  <p className="text-sm text-muted-foreground">没拉到模型，请检查上游地址和密钥</p>
                  <button className="mt-3 text-xs text-accent hover:underline"
                    onClick={() => { setFetchedModels(null); fetchModels.mutate({ id: modelPicker.upstreamId }); }}>重试</button>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-primary">上游共 {fetchedModels.length} 个模型，已添加的会标灰锁定</p>
                    <div className="space-x-3 text-xs">
                      <button className="text-accent hover:underline" onClick={() => setModelPickSel([...fetchedModels])}>全选</button>
                      <button className="text-muted-foreground hover:underline" onClick={() => setModelPickSel([])}>清空</button>
                    </div>
                  </div>
                  <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto rounded-lg border border-border bg-[hsl(var(--admin-control))] p-3 sm:grid-cols-2">
                    {fetchedModels.map((n) => {
                      const exists = (models.data ?? []).some((m) => m.name === n);
                      return (
                        <label key={n} className={`flex items-center gap-2 rounded px-1.5 py-1 text-xs ${exists ? "text-muted-foreground/50" : "cursor-pointer text-foreground hover:bg-white/5"}`}>
                          <Checkbox disabled={exists}
                            checked={exists || modelPickSel.includes(n)}
                            onCheckedChange={(v) =>
                              setModelPickSel(v ? [...modelPickSel, n] : modelPickSel.filter((x) => x !== n))
                            } />
                          <span className="font-num break-all">{n}</span>
                          {exists && <span className="shrink-0 text-[10px]">已添加</span>}
                        </label>
                      );
                    })}
                  </div>
                  <div className="space-y-1.5"><Label className="text-xs text-primary">接口类型</Label>
                    <Select value={modelPickApiType} onValueChange={(v) => setModelPickApiType(v as typeof modelPickApiType)}>
                      <SelectTrigger className="border-border bg-[hsl(var(--admin-control))]"><SelectValue /></SelectTrigger>
                      <SelectContent className="border-border bg-card text-foreground">
                        <SelectItem value="chat">chat/completions</SelectItem>
                        <SelectItem value="responses">responses (Codex)</SelectItem>
                        <SelectItem value="claude">claude messages</SelectItem>
                        <SelectItem value="gemini">gemini</SelectItem>
                      </SelectContent>
                    </Select></div>
                  <div className="space-y-1.5"><Label className="text-xs text-primary">放入分组（不勾 = 全部分组可用）</Label>
                    <div className="flex flex-wrap gap-3 rounded-lg border border-border bg-[hsl(var(--admin-control))] p-3">
                      {groupList.data?.length ? groupList.data.map((g) => (
                        <label key={g.id} className="flex cursor-pointer items-center gap-1.5 text-xs text-foreground">
                          <Checkbox
                            checked={modelPickGroups.includes(g.name)}
                            onCheckedChange={(v) =>
                              setModelPickGroups(v ? [...modelPickGroups, g.name] : modelPickGroups.filter((x) => x !== g.name))
                            }
                          />
                          {g.name} <span className="text-primary">×{g.multiplier}</span>
                        </label>
                      )) : <p className="text-xs text-muted-foreground">暂无分组，可先去「分组」页创建</p>}
                    </div></div>
                  <button disabled={!modelPickSel.length || batchAddModels.isPending}
                    onClick={() => batchAddModels.mutate({
                      name: modelPickSel.join("\n"),
                      upstreamId: modelPicker.upstreamId,
                      upstreamModel: "",
                      apiType: modelPickApiType,
                      priceInput: null, priceOutput: null, priceCacheWrite: null, priceCacheRead: null,
                      allowedGroups: modelPickGroups.join(","),
                      enabled: true,
                    })}
                    className="btn-3d w-full rounded-lg bg-accent py-2.5 font-black text-accent-foreground disabled:opacity-50">
                    {batchAddModels.isPending ? "添加中…" : `添加所选 ${modelPickSel.length} 个模型（价格稍后设）`}
                  </button>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
