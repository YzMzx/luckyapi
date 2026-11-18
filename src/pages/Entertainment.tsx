import { Link } from "react-router";
import { Gift, Cherry, CalendarCheck, Swords, ArrowRight, Loader2 } from "lucide-react";
import { useMe } from "@/hooks/useMe";
import { SiteNav } from "@/components/SiteNav";
import { trpc } from "@/providers/trpc";
import { cn } from "@/lib/utils";

/** 娱乐总览：三个每日/一次玩法 + 决斗场的实时状态入口 */
export default function Entertainment() {
  const { user, isLoading } = useMe({ requireAuth: true, requireOnboarded: true });
  const summary = trpc.entertainment.summary.useQuery(undefined, { enabled: !!user?.onboarded });

  if (isLoading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;

  const s = summary.data;

  const cards = [
    {
      to: "/draw",
      icon: Gift,
      title: "一次性抽奖",
      desc: s ? `中 $${s.draw.rewardRange[0]}–$${s.draw.rewardRange[1]} 随机额度 · 每个正式账号全局一次` : "每个正式账号全局一次",
      status: !s ? null : s.draw.participated
        ? { text: s.draw.result?.won ? `已中 $${Number(s.draw.result.amount).toFixed(2)}` : "已参与", cls: "border-border bg-white/5 text-muted-foreground" }
        : s.draw.canDraw
          ? { text: "可参与", cls: "border-[#00B77D]/50 bg-[#00B77D]/10 text-[#00B77D]" }
          : { text: "暂不可用", cls: "border-[#EF5459]/40 bg-[#EF5459]/10 text-[#EF5459]" },
    },
    {
      to: "/slot",
      icon: Cherry,
      title: "老虎机",
      desc: "服务端开奖 · 任意三连必中 · 公开赔付表",
      status: !s ? null : !s.slot.enabled
        ? { text: "今日未开放", cls: "border-border bg-white/5 text-muted-foreground" }
        : s.slot.remaining > 0
          ? { text: `剩余 ${s.slot.remaining}/${s.slot.dailyLimit} 次`, cls: "border-[#00B77D]/50 bg-[#00B77D]/10 text-[#00B77D]" }
          : { text: "今日次数已用完", cls: "border-[#EF5459]/40 bg-[#EF5459]/10 text-[#EF5459]" },
    },
    {
      to: "/checkin",
      icon: CalendarCheck,
      title: "每日签到",
      desc: s ? `保证获得 $${s.signin.minReward.toFixed(2)}–$${s.signin.maxReward.toFixed(2)} 额度 · 每个业务日一次` : "每个业务日一次",
      status: !s ? null : s.signin.done
        ? { text: `今日已签到${s.signin.result ? ` +$${Number(s.signin.result.reward).toFixed(2)}` : ""}`, cls: "border-[#FFB700]/50 bg-[#FFB700]/10 text-[#FFB700]" }
        : s.signin.canSignin
          ? { text: "可签到", cls: "border-[#00B77D]/50 bg-[#00B77D]/10 text-[#00B77D]" }
          : { text: s.signin.unavailableReason === "budget_exhausted" ? "预算暂时耗尽" : "暂未开放", cls: "border-border bg-white/5 text-muted-foreground" },
    },
    {
      to: "/arena",
      icon: Swords,
      title: "幸运决斗场",
      desc: "幸运骰子 / 二十一点 · 2–6 人 PVP 奖池 · 赢家税率全场公示",
      status: null,
    },
  ] as const;

  return (
    <div className="min-h-screen">
      <SiteNav user={user} />
      <main className="mx-auto max-w-3xl px-4 py-12">
        <div className="rise-in text-center">
          <p className="text-xs font-bold tracking-[0.5em] text-[#af915f]">ENTERTAINMENT</p>
          <h1 className="mt-2 text-4xl font-black"><span className="text-outline">娱乐中心</span></h1>
          {s && (
            <p className="mt-3 text-xs text-muted-foreground">
              当前业务日 {s.businessDay.key} · {new Date(s.businessDay.endsAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 结束
            </p>
          )}
        </div>

        {summary.isLoading && (
          <p className="mt-10 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> 状态加载中…
          </p>
        )}
        {summary.error && (
          <div className="rise-in mt-10 rounded-xl border border-[#EF5459]/50 bg-[#101d2b] p-6 text-center">
            <p className="text-sm font-bold text-[#EF5459]">状态加载失败：{summary.error.message}</p>
            <button onClick={() => summary.refetch()} className="mt-3 text-xs font-bold text-[#FFB700] hover:underline">重试</button>
          </div>
        )}

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {cards.map((c, i) => (
            <Link key={c.to} to={c.to} className="card-luxe rise-in group rounded-2xl p-5" style={{ animationDelay: `${i * 70}ms` }}>
              <div className="flex items-center justify-between">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#af915f]/40 bg-[#162638] text-[#FFB700] transition-colors group-hover:border-[#FFB700]">
                  <c.icon className="h-5 w-5" />
                </span>
                {c.status && (
                  <span className={cn("rounded-full border px-2.5 py-0.5 text-[10px] font-bold", c.status.cls)}>{c.status.text}</span>
                )}
              </div>
              <h2 className="mt-4 text-base font-bold text-[#fce1b6]">{c.title}</h2>
              <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{c.desc}</p>
              <p className="mt-3 flex items-center gap-1 text-xs font-bold text-[#FFB700] opacity-0 transition-opacity group-hover:opacity-100">
                进入 <ArrowRight className="h-3 w-3" />
              </p>
            </Link>
          ))}
        </div>

        <p className="mt-8 text-center text-xs text-muted-foreground">
          <Link to="/arena/leaderboard" className="font-bold text-[#FFB700] hover:underline">决斗风云榜 →</Link>
        </p>
      </main>
    </div>
  );
}
