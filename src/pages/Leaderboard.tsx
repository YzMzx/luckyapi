import { useRef, useState } from "react";
import { Link } from "react-router";
import { Flag, History } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { useMe } from "@/hooks/useMe";
import { SiteNav } from "@/components/SiteNav";
import { toast } from "sonner";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Pager } from "@/components/Pager";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const MEDAL = ["#FFB700", "#c0c8d4", "#cd7f32"];

export default function ReportCenter() {
  const { user, isLoading } = useMe({ requireAuth: true, requireOnboarded: true });
  const utils = trpc.useUtils();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const board = trpc.member.leaderboard.useQuery({ page, pageSize }, { enabled: !!user?.onboarded });
  const quota = trpc.member.reportQuota.useQuery(undefined, { enabled: !!user?.onboarded });
  const [target, setTarget] = useState<{ id: number; name: string } | null>(null);
  const [randomOpen, setRandomOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const reportRequestIds = useRef(new Map<string, string>());
  const stableRequestId = (key: string) => {
    const existing = reportRequestIds.current.get(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    reportRequestIds.current.set(key, created);
    return created;
  };

  const report = trpc.member.report.useMutation({
    onSuccess: (res, variables) => {
      const description = `${res.targetName ? `对象：${res.targetName}。` : ""}${res.message}${res.quotaSource === "card" ? "（已使用 1 次举报卡）" : ""}`;
      if (res.success) toast.success(res.title, {
        description,
        className: "report-toast report-toast-success",
      });
      else toast.warning(res.title, {
        description,
        className: "report-toast report-toast-warning",
      });
      reportRequestIds.current.delete(variables.targetUserId ? `targeted:${variables.targetUserId}` : "random");
      utils.invalidate();
    },
    onError: (e) => toast.error("举报未完成", {
      description: e.message,
      className: "report-toast report-toast-error",
    }),
    onSettled: () => setReporting(false),
  });

  if (isLoading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;

  return (
    <div className="min-h-screen">
      <SiteNav user={user} />
      <main className="mx-auto max-w-5xl px-4 py-8 sm:py-12">
        <div className="rise-in flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold tracking-[0.5em] text-[#af915f]">REPORT CENTER</p>
            <h1 className="mt-2 flex items-center gap-3 text-3xl font-black sm:text-4xl"><Flag className="h-8 w-8 text-[#EF5459]" /><span className="text-outline">举报中心</span></h1>
            <p className="mt-3 text-sm text-muted-foreground">从公开候选人中指定举报，或者让系统随机选择一位。</p>
          </div>
          <div className="grid w-full grid-cols-2 gap-2 text-xs text-muted-foreground sm:flex sm:w-auto sm:flex-wrap sm:justify-end">
            <div className="rounded-lg border border-border bg-[#101d2b] px-3 py-2 sm:px-4">指定免费：<span className="font-num text-lg font-bold text-[#FFB700]">{quota.data?.targeted.remaining ?? "…"}</span>{quota.data && <span> / {quota.data.targeted.dailyLimit}</span>}</div>
            <div className="rounded-lg border border-border bg-[#101d2b] px-3 py-2 sm:px-4">随机免费：<span className="font-num text-lg font-bold text-[#FFB700]">{quota.data?.random.remaining ?? "…"}</span>{quota.data && <span> / {quota.data.random.dailyLimit}</span>}</div>
            <div className="rounded-lg border border-[#af915f]/40 bg-[#101d2b] px-3 py-2 sm:px-4">举报卡：<span className="font-num text-lg font-bold text-[#fce1b6]">{quota.data?.cardRemaining ?? "…"}</span> 次</div>
            <Link to="/reports" className="flex items-center gap-2 rounded-lg border border-border bg-[#101d2b] px-4 py-2 font-bold text-[#fce1b6] transition hover:border-[#FFB700]/60 hover:text-[#FFB700]"><History className="h-4 w-4" />举报记录</Link>
          </div>
        </div>

        <p className="rise-in rise-in-1 mt-4 text-xs leading-5 text-muted-foreground">
          排名口径：{board.data?.ranking.description ?? "按账户永久可用额度从高到低排名。"}
          榜单展示所有已完善群内名称且未封禁的正式用户，包括永久额度为零或负数的用户；未到期临时额度不计入排名。
          <br />
          举报风险额：仅双方永久可用额度都大于 0 时可举报，结算时取双方永久可用额度中较低的一方，再取其 50%。举报成立由对方扣，未成立由举报人扣，但金额始终相同。
          赢家从该税前金额中扣 {quota.data?.tax.percent ?? "…"}% 举报税后到账。指定与随机举报分别计算每日免费次数；对应免费次数用完后，自动消耗 1 次永久举报卡，举报卡可用于任一类型且不过期。前台不公开判定概率。
          {quota.data?.tax && <> 示例：税前 ${quota.data.tax.exampleGross.toFixed(2)}，税 ${quota.data.tax.exampleTax.toFixed(2)}，实际到账 ${quota.data.tax.exampleCredited.toFixed(2)}。</>}
        </p>
        {quota.error && <div className="mt-4 rounded-lg border border-[#EF5459]/40 bg-[#101d2b] p-3 text-center text-xs text-[#EF5459]">举报额度加载失败：{quota.error.message} <button onClick={() => quota.refetch()} className="ml-2 font-bold text-[#FFB700] hover:underline">重试</button></div>}
        {quota.data?.unavailableReason && <div className="mt-4 rounded-lg border border-[#FFB700]/30 bg-[#FFB700]/5 p-3 text-center text-xs font-bold text-[#FFB700]">当前不可举报：{quota.data.unavailableReason}</div>}

        {board.data?.mine && (
          <div className="rise-in rise-in-1 mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#FFB700]/40 bg-[#FFB700]/5 px-5 py-4">
            <div>
              <p className="text-xs text-muted-foreground">我的排名</p>
              <p className="font-num mt-1 text-xl font-black text-[#FFB700]">
                #{board.data.mine.rank}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">永久可用额度</p>
              <p className="font-num mt-1 text-lg font-bold text-[#fce1b6]">${Number(board.data.mine.balance).toFixed(2)}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {board.data.mine.isOnPage ? "已在当前页高亮" : "不在当前页，仍单独显示名次"}
              </p>
            </div>
          </div>
        )}

        <div className="rise-in rise-in-2 mt-8 overflow-hidden rounded-xl border border-border">
          {board.isLoading ? (
            <p className="bg-[#101d2b] py-16 text-center text-sm text-muted-foreground">加载额度榜中…</p>
          ) : board.error ? (
            <div className="bg-[#101d2b] py-12 text-center"><p className="text-sm font-bold text-[#EF5459]">额度榜加载失败：{board.error.message}</p><button onClick={() => board.refetch()} className="mt-3 text-xs font-bold text-[#FFB700] hover:underline">重试</button></div>
          ) : board.data?.rows.length ? (
            board.data.rows.map((row) => {
              const rank = row.rank;
              return (
              <div
                key={row.id}
                className={`grid grid-cols-[2rem_2.5rem_minmax(0,1fr)] items-center gap-3 border-b border-border px-4 py-4 last:border-0 sm:grid-cols-[2.5rem_2.5rem_minmax(0,1fr)_8rem_auto] sm:gap-4 sm:px-5 ${row.id === user.id ? "bg-[#FFB700]/10" : "bg-[#101d2b]"}`}
              >
                <span
                  className="font-num w-8 text-center text-sm font-black sm:text-xl"
                  style={{ color: rank <= 3 ? MEDAL[rank - 1] : "#3d5570" }}
                >
                  #{rank}
                </span>
                <Avatar className="h-9 w-9 border border-[#af915f]/40">
                  <AvatarImage src={row.avatarUrl} />
                  <AvatarFallback className="bg-[#1d3145] text-xs text-[#fce1b6]">
                    {(row.groupName ?? "?").slice(0, 1)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 sm:col-auto">
                  <p className="truncate font-bold text-[#fce1b6]">{row.groupName}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(row.createdAt).toLocaleDateString("zh-CN")} 入场 · 举报 {row.reportCount} 次 / 成功 {row.reportWins} 次
                  </p>
                </div>
                <div className="col-span-3 flex items-end justify-between border-t border-border/60 pt-3 text-right sm:col-span-1 sm:block sm:border-0 sm:pt-0">
                  <span className="text-xs text-muted-foreground sm:hidden">永久可用额度</span>
                  <span><span className={`font-num block text-xl font-black ${Number(row.balance) <= 0 ? "text-[#EF5459]" : "text-[#FFB700]"}`}>${Number(row.balance).toFixed(2)}</span><span className="block text-[10px] text-muted-foreground">永久可用</span></span>
                </div>
                {row.id !== user.id && Number(row.balance) > 0 && (
                  <button
                    onClick={() => setTarget({ id: row.id, name: row.groupName ?? "对方" })}
                    disabled={!quota.data || !quota.data.targeted.canReport || !quota.data.canReport}
                    className="col-span-3 w-full rounded border border-[#EF5459]/50 px-4 py-2.5 text-xs font-bold text-[#EF5459] transition-colors hover:bg-[#EF5459] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 sm:col-span-1 sm:w-auto sm:py-1.5"
                  >
                    举报
                  </button>
                )}
              </div>
              );
            })
          ) : (
            <p className="bg-[#101d2b] py-16 text-center text-sm text-muted-foreground">暂无符合条件的正式用户</p>
          )}
        </div>

        {/* 分页 */}
        {board.data && (
          <Pager
            className="mt-4"
            page={board.data.page}
            totalPages={board.data.totalPages}
            total={board.data.total}
            pageSize={pageSize}
            unit="人"
            onPage={setPage}
            onPageSize={(s) => { setPageSize(s); setPage(1); }}
          />
        )}

        {/* 随机举报入口 */}
        <div className="rise-in rise-in-3 mt-6 flex justify-center">
          <button
            onClick={() => setRandomOpen(true)}
            disabled={!quota.data || !quota.data.random.canReport || !quota.data.canReport}
            className="btn-3d w-full rounded-lg border border-[#af915f] bg-[#1d3145] px-6 py-3 text-sm font-bold text-[#fce1b6] disabled:opacity-40 sm:w-auto"
          >
            随机举报一位幸运儿
          </button>
        </div>
      </main>

      {/* 指定举报确认 */}
      <AlertDialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <AlertDialogContent className="border-border bg-[#101d2b] text-[#fce1b6]">
          <AlertDialogHeader>
            <AlertDialogTitle>举报「{target?.name}」？</AlertDialogTitle>
            <AlertDialogDescription className="leading-6 text-muted-foreground">
              结算先取双方永久可用额度中的较低值，再取其 <span className="text-[#FFB700]">50%</span> 作为固定风险额。
              成功由对方扣，未成立由你扣；无论哪方输金额都相同。获益方需缴 {quota.data?.tax.percent ?? "…"}% 举报税。
              指定举报免费次数还剩 {quota.data?.targeted.remaining ?? 0} / {quota.data?.targeted.dailyLimit ?? 0} 次；免费次数用完后会消耗 1 次举报卡（当前 {quota.data?.cardRemaining ?? 0} 次）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border bg-transparent text-[#fce1b6] hover:bg-[#1d3145]">算了</AlertDialogCancel>
            <AlertDialogAction
              disabled={reporting || !quota.data || !quota.data.targeted.canReport || !quota.data.canReport}
              className="bg-[#EF5459] font-bold text-white hover:bg-[#d94449]"
              onClick={(e) => {
                e.preventDefault();
                if (!target) return;
                setReporting(true);
                report.mutate({ requestId: stableRequestId(`targeted:${target.id}`), targetUserId: target.id });
                setTarget(null);
              }}
            >
              {reporting ? "判定中…" : "确认举报"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 随机举报确认 */}
      <AlertDialog open={randomOpen} onOpenChange={setRandomOpen}>
        <AlertDialogContent className="border-border bg-[#101d2b] text-[#fce1b6]">
          <AlertDialogHeader>
            <AlertDialogTitle>随机举报？</AlertDialogTitle>
            <AlertDialogDescription className="leading-6 text-muted-foreground">
              系统将从当前可用额度榜上<span className="text-[#FFB700]">随机抽一位</span>作为举报对象，规则与指定举报相同。
              随机举报免费次数还剩 {quota.data?.random.remaining ?? 0} / {quota.data?.random.dailyLimit ?? 0} 次；免费次数用完后会消耗 1 次举报卡（当前 {quota.data?.cardRemaining ?? 0} 次）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border bg-transparent text-[#fce1b6] hover:bg-[#1d3145]">算了</AlertDialogCancel>
            <AlertDialogAction
              disabled={reporting || !quota.data || !quota.data.random.canReport || !quota.data.canReport}
              className="bg-[#EF5459] font-bold text-white hover:bg-[#d94449]"
              onClick={(e) => {
                e.preventDefault();
                setReporting(true);
                report.mutate({ requestId: stableRequestId("random") });
                setRandomOpen(false);
              }}
            >
              {reporting ? "判定中…" : "开始随机"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
