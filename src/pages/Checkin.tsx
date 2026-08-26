import { useRef, useState } from "react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { useMe } from "@/hooks/useMe";
import { SiteNav } from "@/components/SiteNav";

export default function Checkin() {
  const { user, isLoading } = useMe({ requireAuth: true, requireOnboarded: true });
  const utils = trpc.useUtils();
  const status = trpc.entertainment.signinStatus.useQuery(undefined, { enabled: !!user?.onboarded });
  const signinRequestId = useRef<string | null>(null);
  const [reward, setReward] = useState<number | null>(null);

  const signin = trpc.entertainment.signin.useMutation({
    onSuccess: (value) => {
      signinRequestId.current = null;
      setReward(value.reward);
      utils.entertainment.invalidate();
      utils.auth.me.invalidate();
    },
  });

  if (isLoading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;

  const s = status.data;
  const shownReward = reward ?? s?.result?.reward ?? null;

  return (
    <div className="min-h-screen">
      <SiteNav user={user} />
      <main className="mx-auto flex max-w-3xl flex-col items-center px-4 py-14">
        <p className="rise-in text-xs font-bold tracking-[0.45em] text-[#af915f]">DAILY CHECK-IN</p>
        <h1 className="rise-in rise-in-1 mt-3 text-center text-4xl font-black tracking-tight sm:text-5xl">
          <span className="text-outline">每日签到</span>
        </h1>
        <p className="rise-in rise-in-1 mt-3 text-xs text-muted-foreground">
          <Link to="/entertainment" className="font-bold text-[#FFB700] hover:underline">← 返回娱乐中心</Link>
        </p>

        {status.isLoading && <div className="rise-in rise-in-2 mt-10 w-full max-w-lg rounded-xl border border-border bg-[#101d2b] p-6 text-center text-sm text-muted-foreground">加载签到状态中…</div>}
        {status.error && <div className="rise-in rise-in-2 mt-10 w-full max-w-lg rounded-xl border border-[#EF5459]/50 bg-[#101d2b] p-6 text-center">
          <p className="text-sm font-bold text-[#EF5459]">签到状态加载失败：{status.error.message}</p>
          <button onClick={() => status.refetch()} className="mt-3 text-xs font-bold text-[#FFB700] hover:underline">重试</button>
        </div>}

        {s && (
          <div className="rise-in rise-in-2 mt-10 w-full max-w-lg rounded-xl border border-border bg-[#101d2b] p-5 text-center sm:p-8">
            <p className="text-xs text-muted-foreground">
              保证获得 ${s.minReward.toFixed(2)}–${s.maxReward.toFixed(2)} 额度 · 每个业务日一次
            </p>
            <div className="mt-8 flex min-h-[110px] flex-col items-center justify-center">
              {!s.enabled ? (
                <div className="rounded-xl border border-border bg-[#162638] p-5">
                  <p className="text-sm font-bold text-[#fce1b6]">每日签到暂未开放</p>
                  <p className="mt-1.5 text-xs text-muted-foreground">请留意公告或稍后再来</p>
                </div>
              ) : s.unavailableReason === "budget_exhausted" ? (
                <div className="rounded-xl border border-[#EF5459]/50 bg-[#162638] p-5">
                  <p className="text-sm font-bold text-[#EF5459]">签到活动预算已用完</p>
                  <p className="mt-1.5 text-xs text-muted-foreground">请等待管理员补充预算后再来</p>
                </div>
              ) : shownReward !== null ? (
                <div className="rise-in">
                  <p className="text-xs font-bold text-[#00B77D]">今日已签到</p>
                  <div className="font-num mt-2 text-5xl font-black text-[#FFB700]" style={{ textShadow: "0 0 32px #FFB70055" }}>
                    +${Number(shownReward).toFixed(2)}
                  </div>
                  {s.nextDayAt && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      下个业务日 {new Date(s.nextDayAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 开始
                    </p>
                  )}
                </div>
              ) : (
                <>
                  <button
                    disabled={signin.isPending || !s.canSignin}
                    onClick={() => {
                      signinRequestId.current ??= crypto.randomUUID();
                      signin.mutate({ requestId: signinRequestId.current });
                    }}
                    className="btn-3d glow-gold rounded-lg bg-[#FFB700] px-14 py-4 text-xl font-black text-[#162638] disabled:opacity-50"
                  >
                    {signin.isPending ? "签到中…" : "立即签到"}
                  </button>
                  {signin.error && <p className="mt-3 text-xs text-[#EF5459]">{signin.error.message}</p>}
                </>
              )}
            </div>
          </div>
        )}

        <div className="mt-10 w-full max-w-lg">
          <Link
            to="/entertainment"
            className="flex items-center justify-between rounded-xl border border-[#af915f]/40 bg-[#101d2b] px-5 py-4 transition-colors hover:border-[#FFB700]"
          >
            <div>
              <p className="text-sm font-bold text-[#fce1b6]">更多玩法</p>
              <p className="mt-0.5 text-xs text-muted-foreground">一次性抽奖 / 老虎机 / 幸运决斗场</p>
            </div>
            <span className="font-num text-lg font-black text-[#FFB700]">→</span>
          </Link>
        </div>
      </main>
    </div>
  );
}
