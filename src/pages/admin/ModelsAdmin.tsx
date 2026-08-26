import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { toast } from "sonner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Pager } from "@/components/Pager";
import { modelPayload, pf, ps, type ModelForm } from "./shared";

export default function ModelsAdmin() {
  const utils = trpc.useUtils();
  const upstreamList = trpc.admin.listUpstreams.useQuery(undefined);
  const groupList = trpc.admin.listGroups.useQuery(undefined);

  const [modelForm, setModelForm] = useState<ModelForm | null>(null);
  const [keyword, setKeyword] = useState("");
  const [upstreamId, setUpstreamId] = useState("");
  const [enabledFilter, setEnabledFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const models = trpc.admin.listModelsPage.useQuery({
    page,
    pageSize,
    keyword: keyword.trim() || undefined,
    upstreamId: upstreamId ? Number(upstreamId) : undefined,
    enabled: enabledFilter === "enabled" ? true : enabledFilter === "disabled" ? false : undefined,
  });
  const changeFilter = (fn: () => void) => { fn(); setPage(1); };

  const fail = (e: { message: string }) => toast.error(e.message);

  const upsertModel = trpc.admin.upsertModel.useMutation({
    onSuccess: (r, input) => {
      toast.success(r.created || r.skipped ? `新建 ${r.created} 个${r.skipped ? `，跳过重名 ${r.skipped} 个` : ""}` : "已保存");
      const leavesCurrentFilter = !!input.id && (
        (!!keyword.trim() && !input.name.toLowerCase().includes(keyword.trim().toLowerCase()))
        || (!!upstreamId && input.upstreamId !== Number(upstreamId))
        || (enabledFilter === "enabled" && !input.enabled)
        || (enabledFilter === "disabled" && input.enabled)
      );
      if (leavesCurrentFilter && models.data?.items.length === 1 && page > 1) setPage((current) => Math.max(1, current - 1));
      setModelForm(null); utils.admin.invalidate();
    },
    onError: fail,
  });
  const deleteModel = trpc.admin.deleteModel.useMutation({
    onSuccess: () => {
      toast.success("已删除");
      if (models.data?.items.length === 1 && page > 1) setPage((current) => Math.max(1, current - 1));
      utils.admin.invalidate();
    },
    onError: fail,
  });

  const th = "text-muted-foreground";
  return (
    <>
      <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            在这里逐个给模型设置价格（美元 / 每百万 token，留空 = 该档位不计费）。新增模型请去「上游渠道」页点对应渠道的「＋模型」。
          </p>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Input value={keyword} onChange={(event) => changeFilter(() => setKeyword(event.target.value))}
            placeholder="按模型名搜索" className="w-52 border-border bg-[hsl(var(--admin-control))] placeholder:text-muted-foreground/50" />
          <Select value={upstreamId || "__all__"} onValueChange={(value) => changeFilter(() => setUpstreamId(value === "__all__" ? "" : value))}>
            <SelectTrigger className="w-44 border-border bg-[hsl(var(--admin-control))]"><SelectValue placeholder="全部上游" /></SelectTrigger>
            <SelectContent className="border-border bg-card text-foreground">
              <SelectItem value="__all__">全部上游</SelectItem>
              {upstreamList.data?.map((upstream) => <SelectItem key={upstream.id} value={String(upstream.id)}>{upstream.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={enabledFilter || "__all__"} onValueChange={(value) => changeFilter(() => setEnabledFilter(value === "__all__" ? "" : value))}>
            <SelectTrigger className="w-32 border-border bg-[hsl(var(--admin-control))]"><SelectValue placeholder="全部状态" /></SelectTrigger>
            <SelectContent className="border-border bg-card text-foreground">
              <SelectItem value="__all__">全部状态</SelectItem><SelectItem value="enabled">已启用</SelectItem><SelectItem value="disabled">已停用</SelectItem>
            </SelectContent>
          </Select>
          {(keyword || upstreamId || enabledFilter) && <button type="button" className="text-xs text-primary hover:underline"
            onClick={() => changeFilter(() => { setKeyword(""); setUpstreamId(""); setEnabledFilter(""); })}>清除筛选</button>}
        </div>
        <Table className="mt-6">
          <TableHeader><TableRow className="border-border hover:bg-transparent">
            <TableHead className={th}>模型</TableHead><TableHead className={th}>上游</TableHead>
            <TableHead className={th}>接口</TableHead>
            <TableHead className={`text-right ${th}`}>输入</TableHead>
            <TableHead className={`text-right ${th}`}>输出</TableHead>
            <TableHead className={`text-right ${th}`}>写缓存</TableHead>
            <TableHead className={`text-right ${th}`}>读缓存</TableHead>
            <TableHead className={th}>启用</TableHead><TableHead className={th}></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {models.data?.items.map((m) => (
              <TableRow key={m.id} className="border-border">
                <TableCell className="font-num text-accent">{m.name}
                  {m.upstreamModel !== m.name && <span className="block text-[10px] text-muted-foreground">→ {m.upstreamModel}</span>}
                </TableCell>
                <TableCell className="max-w-[180px] truncate text-xs text-muted-foreground">
                  {m.upstreamName ?? "（未关联）"}
                  {m.allowedGroups && <span className="block text-primary">限组：{m.allowedGroups}</span>}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{m.apiType}</TableCell>
                <TableCell className="font-num text-right text-foreground">{pf(m.priceInput)}</TableCell>
                <TableCell className="font-num text-right text-foreground">{pf(m.priceOutput)}</TableCell>
                <TableCell className="font-num text-right text-foreground">{pf(m.priceCacheWrite)}</TableCell>
                <TableCell className="font-num text-right text-foreground">{pf(m.priceCacheRead)}</TableCell>
                <TableCell><Switch checked={m.enabled}
                  onCheckedChange={(v) => upsertModel.mutate({
                    id: m.id, name: m.name, upstreamId: m.upstreamId ?? 0,
                    upstreamModel: m.upstreamModel, apiType: m.apiType,
                    priceInput: m.priceInput, priceOutput: m.priceOutput,
                    priceCacheWrite: m.priceCacheWrite, priceCacheRead: m.priceCacheRead,
                    allowedGroups: m.allowedGroups,
                    enabled: v,
                  })} /></TableCell>
                <TableCell className="space-x-3 text-right text-xs">
                  <button className="text-primary hover:underline" onClick={() => setModelForm({
                    id: m.id, name: m.name, upstreamId: String(m.upstreamId ?? ""),
                    upstreamModel: m.upstreamModel === m.name ? "" : m.upstreamModel, apiType: m.apiType,
                    priceInput: ps(m.priceInput), priceOutput: ps(m.priceOutput),
                    priceCacheWrite: ps(m.priceCacheWrite), priceCacheRead: ps(m.priceCacheRead),
                    groupSel: m.allowedGroups ? m.allowedGroups.split(",").map((s) => s.trim()).filter(Boolean) : [],
                    enabled: m.enabled,
                  })}>编辑</button>
                  <button className="text-[#EF5459] hover:underline"
                    onClick={() => { if (confirm(`删除模型 ${m.name}？`)) deleteModel.mutate({ id: m.id }); }}>删除</button>
                </TableCell>
              </TableRow>
            ))}
            {models.isLoading && (
              <TableRow className="border-border"><TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">加载中…</TableCell></TableRow>
            )}
            {models.error && (
              <TableRow className="border-border"><TableCell colSpan={9} className="py-8 text-center text-sm text-[#EF5459]">{models.error.message}</TableCell></TableRow>
            )}
            {models.data && !models.data.items.length && (
              <TableRow className="border-border"><TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">{keyword || upstreamId || enabledFilter ? "没有符合筛选条件的模型" : "尚未配置上游模型"}</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        {models.data && <Pager className="mt-4" page={models.data.page} totalPages={models.data.totalPages}
          total={models.data.total} pageSize={pageSize} onPage={setPage}
          onPageSize={(size) => { setPageSize(size); setPage(1); }} />}
      </div>

      {/* 模型编辑弹窗 */}
      <Dialog open={!!modelForm} onOpenChange={(o) => !o && setModelForm(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-card text-foreground">
          <DialogHeader><DialogTitle>设置模型价格</DialogTitle></DialogHeader>
          {modelForm && (
            <form className="space-y-4" onSubmit={(e) => {
              e.preventDefault();
              upsertModel.mutate(modelPayload(modelForm));
            }}>
              <div className="rounded-lg border border-border bg-[hsl(var(--admin-control))] px-3 py-2 text-sm">
                <span className="font-num font-bold text-accent">{modelForm.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  上游：{upstreamList.data?.find((u) => String(u.id) === modelForm.upstreamId)?.name ?? "（未关联）"}
                </span>
              </div>
              <div className="space-y-1.5"><Label className="text-xs text-primary">上游模型名（可选）</Label>
                <Input value={modelForm.upstreamModel} onChange={(e) => setModelForm({ ...modelForm, upstreamModel: e.target.value })}
                  placeholder="默认同对外模型名" className="border-border bg-[hsl(var(--admin-control))] placeholder:text-muted-foreground/40" /></div>
              <div className="space-y-1.5"><Label className="text-xs text-primary">接口类型</Label>
                <Select value={modelForm.apiType} onValueChange={(v) => setModelForm({ ...modelForm, apiType: v as "chat" | "responses" | "claude" | "gemini" })}>
                  <SelectTrigger className="border-border bg-[hsl(var(--admin-control))]"><SelectValue /></SelectTrigger>
                  <SelectContent className="border-border bg-card text-foreground">
                    <SelectItem value="chat">chat/completions</SelectItem>
                    <SelectItem value="responses">responses (Codex)</SelectItem>
                    <SelectItem value="claude">claude messages</SelectItem>
                    <SelectItem value="gemini">gemini</SelectItem>
                  </SelectContent>
                </Select></div>
              <p className="-mt-2 text-[10px] text-muted-foreground">类型仅作标注：你的域名下四种协议入口全部开放，调用不限于此处选择</p>
              <div className="space-y-1.5"><Label className="text-xs text-primary">限定分组（不勾 = 全部分组可用）</Label>
                <div className="flex flex-wrap gap-3 rounded-lg border border-border bg-[hsl(var(--admin-control))] p-3">
                  {groupList.data?.map((g) => (
                    <label key={g.id} className="flex cursor-pointer items-center gap-1.5 text-xs text-foreground">
                      <Checkbox
                        checked={modelForm.groupSel.includes(g.name)}
                        onCheckedChange={(v) =>
                          setModelForm({
                            ...modelForm,
                            groupSel: v ? [...modelForm.groupSel, g.name] : modelForm.groupSel.filter((x) => x !== g.name),
                          })
                        }
                      />
                      {g.name} <span className="text-primary">×{g.multiplier}</span>
                    </label>
                  ))}
                </div></div>
              <div>
                <p className="mb-2 text-xs text-primary">计费单价（美元 / 每百万 token，留空不计费）</p>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {([
                    ["priceInput", "输入"], ["priceOutput", "输出"],
                    ["priceCacheWrite", "写缓存"], ["priceCacheRead", "读缓存"],
                  ] as const).map(([field, label]) => (
                    <div key={field} className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">{label}</Label>
                      <Input type="number" step="0.0001" min="0" value={modelForm[field]}
                        onChange={(e) => setModelForm({ ...modelForm, [field]: e.target.value })}
                        placeholder="留空" className="border-border bg-[hsl(var(--admin-control))] placeholder:text-muted-foreground/40" />
                    </div>
                  ))}
                </div>
              </div>
              <button type="submit" disabled={upsertModel.isPending}
                className="btn-3d w-full rounded-lg bg-accent py-2.5 font-black text-accent-foreground disabled:opacity-50">
                {upsertModel.isPending ? "保存中…" : "保存"}
              </button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
