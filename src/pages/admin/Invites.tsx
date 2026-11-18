import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { toast } from "sonner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Pager } from "@/components/Pager";

export default function Invites() {
  const utils = trpc.useUtils();
  const [codeStatus, setCodeStatus] = useState<"active" | "archived" | "all">("active");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const invites = trpc.admin.listInvitesPage.useQuery({ page, pageSize, status: codeStatus });

  const [inviteCount, setInviteCount] = useState(10);
  const [codeType, setCodeType] = useState<"invite" | "redeem">("invite");
  const [codeAmount, setCodeAmount] = useState("5");
  const [codeMode, setCodeMode] = useState<"single" | "reusable">("single");
  const [maxUses, setMaxUses] = useState("");
  const [balanceBelow, setBalanceBelow] = useState("");
  const [creditExpiresAt, setCreditExpiresAt] = useState("");
  const [historyCode, setHistoryCode] = useState<{ id: number; code: string } | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(20);
  const cleanup = trpc.admin.previewUsedCodeCleanup.useQuery(undefined);
  const history = trpc.admin.listCodeRedemptionsPage.useQuery(
    { codeId: historyCode?.id ?? 0, page: historyPage, pageSize: historyPageSize },
    { enabled: !!historyCode },
  );

  const ok = (msg: string) => () => { toast.success(msg); utils.admin.invalidate(); };
  const fail = (e: { message: string }) => toast.error(e.message);

  const genInvites = trpc.admin.generateInvites.useMutation({ onSuccess: ok("已生成"), onError: fail });
  const delInvite = trpc.admin.deleteInvite.useMutation({
    onSuccess: (result) => {
      toast.success(result.action === "archive" ? "已安全归档，历史兑换记录保留" : "未使用码已物理删除");
      utils.admin.invalidate();
    },
    onError: fail,
  });
  const archiveUsed = trpc.admin.archiveUsedCodes.useMutation({
    onSuccess: (result) => {
      toast.success(result.archivedCount ? `已归档 ${result.archivedCount} 个已使用单次码` : "没有可归档的码");
      utils.admin.invalidate();
    },
    onError: fail,
  });
  const updateThreshold = trpc.admin.updateInviteBalanceThreshold.useMutation({
    onSuccess: ok("余额门槛已更新"), onError: fail,
  });

  const requestDelete = (code: NonNullable<typeof invites.data>["items"][number]) => {
    if (!code.canDelete || !code.deleteAction) return;
    const reusableStillAvailable = code.mode === "reusable"
      && (code.maxUses === null || code.redemptionCount < code.maxUses);
    const message = code.deleteAction === "archive"
      ? `确认删除 ${code.code}？\n\n该码已有兑换记录，将执行安全归档。${reusableStillAvailable ? "即使仍有剩余次数或不限次数，归档后也会立即停止后续兑换。" : "归档后将继续保持不可兑换。"}\n历史兑换记录会完整保留。`
      : `确认永久删除从未使用的码 ${code.code}？\n\n该码没有兑换审计，将从数据库物理删除。`;
    if (window.confirm(message)) delInvite.mutate({ id: code.id });
  };

  const th = "text-muted-foreground";
  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Label className="text-primary">批量生成</Label>
        <Select value={codeType} onValueChange={(v) => setCodeType(v as "invite" | "redeem")}>
          <SelectTrigger className="w-36 border-border bg-[hsl(var(--admin-control))]"><SelectValue /></SelectTrigger>
          <SelectContent className="border-border bg-card text-foreground">
            <SelectItem value="invite">邀请码</SelectItem>
            <SelectItem value="redeem">兑换码（充值）</SelectItem>
          </SelectContent>
        </Select>
        {codeType !== "invite" && (
          <>
            <Label className="text-muted-foreground">面额 $</Label>
            <Input type="number" min={0.01} step={0.01} value={codeAmount}
              onChange={(e) => setCodeAmount(e.target.value)}
              className="w-24 border-border bg-[hsl(var(--admin-control))]" />
            <Select value={codeMode} onValueChange={(v) => setCodeMode(v as "single" | "reusable") }>
              <SelectTrigger className="w-44 border-border bg-[hsl(var(--admin-control))]"><SelectValue /></SelectTrigger>
              <SelectContent className="border-border bg-card text-foreground">
                <SelectItem value="single">全局单次</SelectItem>
                <SelectItem value="reusable">多账号可重复</SelectItem>
              </SelectContent>
            </Select>
            {codeMode === "reusable" && <Input type="number" min={2} step={1} value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)} placeholder="总次数（留空不限）"
              className="w-40 border-border bg-[hsl(var(--admin-control))]" />}
            <Input type="number" min={0} step={0.01} value={balanceBelow}
              onChange={(e) => setBalanceBelow(e.target.value)} placeholder="余额低于（留空不限制）"
              className="w-48 border-border bg-[hsl(var(--admin-control))]" />
            <div className="space-y-1"><Label className="text-[10px] text-muted-foreground">额度失效时间（北京时间，留空永久）</Label><Input type="datetime-local" value={creditExpiresAt}
              onChange={(e) => setCreditExpiresAt(e.target.value)}
              className="w-56 border-border bg-[hsl(var(--admin-control))]" /></div>
          </>
        )}
        <Label className="text-muted-foreground">数量</Label>
        <Input type="number" min={1} max={100} value={inviteCount}
          onChange={(e) => setInviteCount(Number(e.target.value))}
          className="w-24 border-border bg-[hsl(var(--admin-control))]" />
        <button
          onClick={() => genInvites.mutate({
            count: inviteCount, type: codeType,
            amount: codeType !== "invite" ? Number(codeAmount) : undefined,
            mode: codeType !== "invite" ? codeMode : "single",
            maxUses: codeType !== "invite" && codeMode === "reusable" && maxUses
              ? Number(maxUses)
              : null,
            balanceBelow: codeType === "redeem" && balanceBelow !== "" ? Number(balanceBelow) : null,
            creditExpiresAt: codeType === "redeem" && creditExpiresAt
              ? Date.parse(`${creditExpiresAt}${creditExpiresAt.length === 16 ? ":00" : ""}+08:00`)
              : null,
          })}
          className="btn-3d rounded-lg bg-accent px-5 py-2 text-sm font-black text-accent-foreground">生成</button>
        <button type="button" disabled={!cleanup.data?.eligibleCount || archiveUsed.isPending}
          onClick={() => {
            const count = cleanup.data?.eligibleCount ?? 0;
            if (!count) return;
            const confirmed = window.confirm(
              `将归档 ${count} 个已使用的全局单次码。可重复兑换码与全部兑换审计不会被删除，是否继续？`,
            );
            if (confirmed) archiveUsed.mutate({ expectedCount: count, confirmation: "ARCHIVE_USED_CODES" });
          }}
          className="rounded-lg border border-[#EF5459]/50 px-4 py-2 text-xs font-bold text-[#EF5459] disabled:cursor-not-allowed disabled:opacity-40">
          一键归档已用单次码{cleanup.data ? `（${cleanup.data.eligibleCount}）` : ""}
        </button>
        <Select value={codeStatus} onValueChange={(value) => { setCodeStatus(value as typeof codeStatus); setPage(1); }}>
          <SelectTrigger className="ml-auto w-32 border-border bg-[hsl(var(--admin-control))]"><SelectValue /></SelectTrigger>
          <SelectContent className="border-border bg-card text-foreground">
            <SelectItem value="active">有效码</SelectItem>
            <SelectItem value="archived">已归档</SelectItem>
            <SelectItem value="all">全部</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        多账号可重复模式下，同一账号对同一码只能兑换一次；总次数可限制或留空表示不限。
      </p>
      <Table className="mt-6">
        <TableHeader><TableRow className="border-border hover:bg-transparent">
          <TableHead className={th}>码</TableHead><TableHead className={th}>类型</TableHead>
          <TableHead className={th}>模式</TableHead><TableHead className={`text-right ${th}`}>面额</TableHead><TableHead className={th}>余额门槛</TableHead><TableHead className={th}>到账额度失效</TableHead>
          <TableHead className={th}>兑换次数</TableHead><TableHead className={th}>状态</TableHead>
          <TableHead className={th}>创建时间</TableHead><TableHead className={th}></TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {invites.isLoading && <TableRow className="border-border"><TableCell colSpan={10} className="py-10 text-center text-sm text-muted-foreground">加载额度码中…</TableCell></TableRow>}
          {invites.error && <TableRow className="border-border"><TableCell colSpan={10} className="py-10 text-center text-sm text-[#EF5459]">额度码加载失败：{invites.error.message} <button onClick={() => invites.refetch()} className="ml-2 font-bold text-accent hover:underline">重试</button></TableCell></TableRow>}
          {invites.data?.items.map((c) => {
            const exhausted = c.mode === "single"
              ? c.redemptionCount > 0 || !!c.usedBy
              : c.maxUses !== null && c.redemptionCount >= c.maxUses;
            const creditDeadlinePassed = c.type === "redeem" && !!c.creditExpiresAt && new Date(c.creditExpiresAt).getTime() <= invites.dataUpdatedAt;
            return (
            <TableRow key={c.id} className="border-border">
              <TableCell className="font-num text-accent">{c.code}</TableCell>
              <TableCell>
                {c.type === "redeem"
                  ? <span className="rounded bg-[#00B77D]/20 px-1.5 py-0.5 text-xs text-[#00B77D]">兑换码</span>
                  : <span className="rounded bg-[#176EFF]/20 px-1.5 py-0.5 text-xs text-[#7db4ff]">邀请码</span>}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{c.mode === "reusable" ? "多账号可重复" : "全局单次"}</TableCell>
              <TableCell className="font-num text-right text-foreground">{c.amount ? `$${c.amount}` : "—"}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{c.type === "redeem" ? (c.balanceBelow === null ? "无" : `< $${Number(c.balanceBelow).toFixed(2)}`) : "—"}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{c.type !== "redeem" ? "—" : c.creditExpiresAt ? <><span className="block text-accent">{new Date(c.creditExpiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</span><span className="text-[10px]">北京时间</span></> : "永久"}</TableCell>
              <TableCell className="font-num text-xs text-muted-foreground">
                {c.redemptionCount}{c.mode === "reusable" ? ` / ${c.maxUses ?? "不限"}` : " / 1"}
              </TableCell>
              <TableCell>{c.archivedAt ? <span className="text-[#EF5459]">已归档</span> : creditDeadlinePassed ? <span className="text-[#EF5459]">额度失效点已到</span> : exhausted ? <span className="text-muted-foreground">已用完</span> : <span className="text-[#00B77D]">可用</span>}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                <span className="block">{new Date(c.createdAt).toLocaleString("zh-CN")}</span>
                {c.archivedAt && <span className="mt-0.5 block text-[#EF5459]">删除于 {new Date(c.archivedAt).toLocaleString("zh-CN")}</span>}
              </TableCell>
              <TableCell className="text-right">
                {!exhausted && !creditDeadlinePassed && !c.archivedAt && <button className="mr-3 text-xs text-primary hover:underline"
                  onClick={() => { navigator.clipboard.writeText(c.code); toast.success("已复制"); }}>复制</button>}
                {c.auditCount > 0 && <button className="mr-3 text-xs text-primary hover:underline"
                  onClick={() => { setHistoryPage(1); setHistoryCode({ id: c.id, code: c.code }); }}>记录</button>}
                {c.type === "redeem" && !c.archivedAt && <button className="mr-3 text-xs text-[#7db4ff] hover:underline"
                  onClick={() => {
                    const value = window.prompt("仅当当前余额严格低于多少美元时可兑换？留空表示取消门槛。", c.balanceBelow === null ? "" : String(c.balanceBelow));
                    if (value === null) return;
                    if (value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0)) return toast.error("门槛必须是非负金额");
                    updateThreshold.mutate({ id: c.id, balanceBelow: value === "" ? null : Number(value) });
                  }}>门槛</button>}
                {c.canDelete && <button disabled={delInvite.isPending} className="mr-3 text-xs text-[#EF5459] hover:underline disabled:opacity-40"
                  title={c.deleteAction === "archive" ? "安全归档并保留历史记录" : "物理删除未使用码"}
                  onClick={() => requestDelete(c)}>删除</button>}
              </TableCell>
            </TableRow>
          );})}
          {!invites.isLoading && !invites.error && invites.data?.items.length === 0 && <TableRow className="border-border"><TableCell colSpan={10} className="py-10 text-center text-sm text-muted-foreground">当前筛选下暂无额度码</TableCell></TableRow>}
        </TableBody>
      </Table>
      {invites.data && (
        <Pager
          className="mt-4"
          page={invites.data.page}
          totalPages={invites.data.totalPages}
          total={invites.data.total}
          pageSize={pageSize}
          onPage={setPage}
          onPageSize={(s) => { setPageSize(s); setPage(1); }}
        />
      )}

      <Dialog open={!!historyCode} onOpenChange={(open) => !open && setHistoryCode(null)}>
        <DialogContent className="max-w-2xl border-border bg-card text-foreground">
          <DialogHeader><DialogTitle>兑换记录 · {historyCode?.code}</DialogTitle></DialogHeader>
          <div className="max-h-[60vh] overflow-auto">
            <Table><TableHeader><TableRow className="border-border hover:bg-transparent">
              <TableHead className="text-muted-foreground">用户</TableHead><TableHead className="text-right text-muted-foreground">到账内容</TableHead><TableHead className="text-muted-foreground">兑换时余额 / 门槛</TableHead><TableHead className="text-muted-foreground">失效时间</TableHead><TableHead className="text-muted-foreground">临时额度桶</TableHead><TableHead className="text-muted-foreground">兑换时间</TableHead>
            </TableRow></TableHeader><TableBody>
              {history.data?.items.map((row) => <TableRow key={row.id} className="border-border">
                <TableCell>{row.groupName ?? row.username ?? `用户 #${row.userId}`}</TableCell>
                <TableCell className="font-num text-right">${Number(row.amount).toFixed(2)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{row.balanceBefore === null ? "旧记录" : `$${Number(row.balanceBefore).toFixed(2)}`} / {row.balanceBelow === null ? "无" : `< $${Number(row.balanceBelow).toFixed(2)}`}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{row.creditExpiresAt ? new Date(row.creditExpiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "永久"}</TableCell>
                <TableCell className="font-num text-[10px] text-muted-foreground">{row.grantStatus ? `原 $${((row.grantOriginalUnits ?? 0) / 1_000_000).toFixed(6)} / 已用 $${((row.grantConsumedUnits ?? 0) / 1_000_000).toFixed(6)} / 剩余 $${((row.grantRemainingUnits ?? 0) / 1_000_000).toFixed(6)} / 清退 $${((row.grantExpiredUnits ?? 0) / 1_000_000).toFixed(6)} · ${row.grantStatus}` : "永久额度"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{new Date(row.redeemedAt).toLocaleString("zh-CN")}</TableCell>
              </TableRow>)}
              {history.data?.items.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">暂无记录</TableCell></TableRow>}
            </TableBody></Table>
            {history.data && history.data.total > 0 && (
              <Pager
                className="mt-3"
                page={history.data.page}
                totalPages={history.data.totalPages}
                total={history.data.total}
                pageSize={historyPageSize}
                onPage={setHistoryPage}
                onPageSize={(s) => { setHistoryPageSize(s); setHistoryPage(1); }}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
