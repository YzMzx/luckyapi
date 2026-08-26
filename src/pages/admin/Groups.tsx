import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { toast } from "sonner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Pager } from "@/components/Pager";

export default function Groups() {
  const utils = trpc.useUtils();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const groupList = trpc.admin.listGroupsPage.useQuery({ page, pageSize });

  const [groupForm, setGroupForm] = useState<{ id?: number; name: string; multiplier: string; rpmLimit: string; description: string } | null>(null);

  const ok = (msg: string) => () => { toast.success(msg); utils.admin.invalidate(); };
  const fail = (e: { message: string }) => toast.error(e.message);

  const upsertGroup = trpc.admin.upsertGroup.useMutation({
    onSuccess: () => { toast.success("已保存"); setGroupForm(null); utils.admin.invalidate(); },
    onError: fail,
  });
  const deleteGroup = trpc.admin.deleteGroup.useMutation({ onSuccess: ok("已删除"), onError: fail });

  const th = "text-muted-foreground";
  return (
    <>
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">分组决定 Key 的计费倍率：实际费用 = 模型单价 × 倍率。用户创建 Key 时选择分组。</p>
          <button onClick={() => setGroupForm({ name: "", multiplier: "1", rpmLimit: "0", description: "" })}
            className="btn-3d rounded-lg bg-accent px-5 py-2 text-sm font-black text-accent-foreground">+ 新建分组</button>
        </div>
        <Table className="mt-6">
          <TableHeader><TableRow className="border-border hover:bg-transparent">
            <TableHead className={th}>分组名</TableHead><TableHead className={`text-right ${th}`}>倍率</TableHead>
            <TableHead className={`text-right ${th}`}>RPM 限流</TableHead>
            <TableHead className={th}>说明</TableHead><TableHead className={`text-right ${th}`}>Key 数</TableHead>
            <TableHead className={`text-right ${th}`}>限定模型</TableHead>
            <TableHead className={th}></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {groupList.data?.items.map((g) => (
              <TableRow key={g.id} className="border-border">
                <TableCell className="font-num text-accent">{g.name}</TableCell>
                <TableCell className="font-num text-right text-foreground">×{g.multiplier}</TableCell>
                <TableCell className="font-num text-right text-muted-foreground">{g.rpmLimit === 0 ? "不限" : g.rpmLimit}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{g.description || "—"}</TableCell>
                <TableCell className="font-num text-right text-muted-foreground">{g.keyCount}</TableCell>
                <TableCell className="font-num text-right text-muted-foreground">{g.modelCount}</TableCell>
                <TableCell className="space-x-3 text-right text-xs">
                  <button className="text-primary hover:underline"
                    onClick={() => setGroupForm({ id: g.id, name: g.name, multiplier: String(g.multiplier), rpmLimit: String(g.rpmLimit), description: g.description })}>编辑</button>
                  {g.name !== "default" && (
                    <button className="text-[#EF5459] hover:underline"
                      onClick={() => { if (confirm(`删除分组 ${g.name}？`)) deleteGroup.mutate({ id: g.id }); }}>删除</button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!groupList.data?.items.length && (
              <TableRow className="border-border"><TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">暂无分组</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        {groupList.data && (
          <Pager
            className="mt-4"
            page={groupList.data.page}
            totalPages={groupList.data.totalPages}
            total={groupList.data.total}
            pageSize={pageSize}
            onPage={setPage}
            onPageSize={(s) => { setPageSize(s); setPage(1); }}
          />
        )}
      </div>

      {/* 分组编辑弹窗 */}
      <Dialog open={!!groupForm} onOpenChange={(o) => !o && setGroupForm(null)}>
        <DialogContent className="border-border bg-card text-foreground">
          <DialogHeader><DialogTitle>{groupForm?.id ? "编辑分组" : "新建分组"}</DialogTitle></DialogHeader>
          {groupForm && (
            <form className="space-y-4" onSubmit={(e) => {
              e.preventDefault();
              upsertGroup.mutate({
                id: groupForm.id, name: groupForm.name.trim(),
                multiplier: Number(groupForm.multiplier), rpmLimit: Number(groupForm.rpmLimit),
                description: groupForm.description,
              });
            }}>
              <div className="space-y-1.5"><Label className="text-xs text-primary">分组名</Label>
                <Input value={groupForm.name} onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
                  placeholder="如 vip" className="border-border bg-[hsl(var(--admin-control))]" required /></div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5"><Label className="text-xs text-primary">计费倍率（0.8 = 八折）</Label>
                  <Input type="number" step="0.01" min="0" value={groupForm.multiplier}
                    onChange={(e) => setGroupForm({ ...groupForm, multiplier: e.target.value })}
                    className="border-border bg-[hsl(var(--admin-control))]" required /></div>
                <div className="space-y-1.5"><Label className="text-xs text-primary">RPM 限流（0 = 不限）</Label>
                  <Input type="number" step="1" min="0" value={groupForm.rpmLimit}
                    onChange={(e) => setGroupForm({ ...groupForm, rpmLimit: e.target.value })}
                    className="border-border bg-[hsl(var(--admin-control))]" required /></div>
              </div>
              <div className="space-y-1.5"><Label className="text-xs text-primary">说明</Label>
                <Input value={groupForm.description} onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })}
                  placeholder="可选" className="border-border bg-[hsl(var(--admin-control))] placeholder:text-muted-foreground/40" /></div>
              <button type="submit" disabled={upsertGroup.isPending}
                className="btn-3d w-full rounded-lg bg-accent py-2.5 font-black text-accent-foreground disabled:opacity-50">
                {upsertGroup.isPending ? "保存中…" : "保存"}
              </button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
