import { Link } from "react-router";
import { useCallback, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";
import { toast } from "sonner";
import { SiteNav } from "@/components/SiteNav";
import { useMe } from "@/hooks/useMe";
import { trpc } from "@/providers/trpc";
import { DuelBoard } from "@/components/home/DuelBoard";
import { VideoRedEnvelopeDialog, VideoRedEnvelopeEntry } from "@/components/VideoRedEnvelope";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dices, Spade, Cherry, CalendarCheck, Gift, Boxes, KeyRound, Trophy,
  ShieldCheck, Percent, ReceiptText, ArrowRight, Leaf,
} from "lucide-react";
import { mergeVideoSession } from "@/lib/video-reward-state";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type VideoRewardSession = NonNullable<RouterOutputs["entertainment"]["videoRewardStatus"]["session"]>;

/** 热门娱乐入口 */
const GAMES = [
  { to: "/arena", icon: Dices, title: "幸运骰子", desc: "2–6 人同房三骰比大小，豹子通吃，并列加赛", tag: "PVP 奖池" },
  { to: "/arena", icon: Spade, title: "二十一点对决", desc: "多人 PVP 托管奖池，最接近 21 点者平分秋色", tag: "PVP 奖池" },
  { to: "/slot", icon: Cherry, title: "老虎机", desc: "服务端安全开奖，任意三连必中，公开赔付表", tag: "每日" },
  { to: "/checkin", icon: CalendarCheck, title: "每日签到", desc: "动动手指领额度，天天有份", tag: "每日" },
  { to: "/draw", icon: Gift, title: "新客抽奖", desc: "每个正式账号一次机会，随机额度直接入账", tag: "限一次" },
] as const;

/** 服务入口 */
const SERVICES = [
  { to: "/console/badges", icon: Leaf, title: "铭牌殿堂", desc: "查看各类铭牌的获取方式与获授成员" },
  { to: "/models", icon: Boxes, title: "模型广场", desc: "全部上游模型与定价一览" },
  { to: "/console", icon: KeyRound, title: "API 控制台", desc: "生成 Key、查看调用与额度流水" },
  { to: "/leaderboard", icon: Trophy, title: "榜单中心", desc: "额度、决斗战绩与借贷信用排行" },
] as const;

const FAIRNESS = [
  { icon: ShieldCheck, title: "可验证公平", desc: "对局开局前公开种子承诺哈希，结算后揭示种子，结果可自行校验，平台无法中途改牌。" },
  { icon: Percent, title: "税率全场公示", desc: "决斗场赢家税率由后台版本化配置，创建、加入与结算全程展示毛奖池、税额与税后实收。" },
  { icon: ReceiptText, title: "流水笔笔可查", desc: "每一次冻结、派彩、退款都写入额度流水，控制台与后台审计双向可查。" },
] as const;

const ANNOUNCEMENT_SEVERITY = {
  urgent: { label: "紧急", cls: "border-[#EF5459]/60 bg-[#EF5459]/10 text-[#EF5459]" },
  important: { label: "重要", cls: "border-[#FFB700]/60 bg-[#FFB700]/10 text-[#FFB700]" },
  info: { label: "公告", cls: "border-[#af915f]/50 text-[#af915f]" },
} as const;

export default function Home() {
  const { user } = useMe();
  const { data: cfg } = trpc.auth.publicConfig.useQuery();
  const onboarded = !!user?.onboarded;
  const summary = trpc.entertainment.summary.useQuery(undefined, { enabled: onboarded });
  const utils = trpc.useUtils();
  const [videoOpen, setVideoOpen] = useState(false);
  const [videoSession, setVideoSession] = useState<VideoRewardSession | null>(null);
  const startVideo = trpc.entertainment.startVideoRewardSession.useMutation({
    onSuccess: (result) => {
      const session = result.session;
      if (session) setVideoSession((current) => mergeVideoSession(current, session));
      setVideoOpen(true);
    },
    onError: (error) => toast.error(error.message),
  });
  const heartbeat = trpc.entertainment.heartbeatVideoReward.useMutation({
    onSuccess: (result) => {
      const session = result.session;
      if (session) setVideoSession((current) => mergeVideoSession(current, session));
    },
    onError: (error) => {
      if (error.data?.code !== "TOO_MANY_REQUESTS") toast.error(error.message);
      if (error.data?.code === "CONFLICT" || error.data?.code === "PRECONDITION_FAILED") void summary.refetch();
    },
  });
  const claimVideo = trpc.entertainment.claimVideoReward.useMutation({
    onSuccess: async (result) => {
      if (result) toast.success(`红包领取成功：$${result.reward.toFixed(6)}`);
      setVideoOpen(false);
      setVideoSession(null);
      await Promise.all([utils.entertainment.summary.invalidate(), utils.auth.me.invalidate()]);
      await summary.refetch();
      claimVideo.reset();
    },
    onError: (error) => toast.error(error.message),
  });
  const videoReward = summary.data?.videoReward;
  const summarySession = videoReward?.session;
  const sameDayLocal = videoSession && (!videoReward || videoSession.businessDay === videoReward.businessDay) ? videoSession : null;
  const currentSession = summarySession ? mergeVideoSession(sameDayLocal, summarySession) : sameDayLocal;
  const limitReached = (videoReward?.remainingCount ?? 0) <= 0 || videoReward?.unavailableReason === "daily_limit_reached";
  const sessionClaimed = !!claimVideo.data || currentSession?.status === "claimed";
  const openVideoReward = () => {
    if (!videoReward) return;
    if (limitReached) {
      toast.success(`今日已领取 ${videoReward.claimedCount}/${videoReward.dailyLimit} 次，明天再来`);
      return;
    }
    if (currentSession && (currentSession.status === "active" || currentSession.status === "ready")) {
      setVideoOpen(true);
      return;
    }
    if (!videoReward.canStart) {
      const labels: Record<string, string> = {
        disabled: "视频红包暂未开放",
        budget_disabled: "今日视频红包预算未开放",
        daily_budget_exhausted: "今日视频红包预算已领完",
        fund_exhausted: "视频红包基金余额不足",
        already_claimed: "今日视频红包已经领取",
        daily_limit_reached: `今日 ${videoReward.dailyLimit} 次红包已全部领取，明天再来`,
      };
      toast.error(labels[videoReward.unavailableReason ?? ""] ?? "视频红包暂不可用");
      return;
    }
    claimVideo.reset();
    setVideoSession(null);
    startVideo.mutate({ requestId: crypto.randomUUID() });
  };
  const sendHeartbeat = useCallback(() => {
    if (!currentSession?.sessionToken || currentSession.status !== "active" || heartbeat.isPending) return;
    heartbeat.mutate({ sessionToken: currentSession.sessionToken, sequence: currentSession.lastSequence + 1 });
  }, [currentSession, heartbeat]);
  const claim = useCallback(() => {
    if (!currentSession?.sessionToken || currentSession.status !== "ready" || claimVideo.isPending) return;
    claimVideo.mutate({ sessionToken: currentSession.sessionToken, requestId: crypto.randomUUID() });
  }, [currentSession, claimVideo]);
  const range = summary.data
    ? `$${summary.data.draw.rewardRange[0]}–$${summary.data.draw.rewardRange[1]}`
    : `$${cfg?.drawMin ?? 5}–$${cfg?.drawMax ?? 10}`;

  return (
    <div className="min-h-screen">
      <SiteNav user={user} />

      {/* ===== Hero：娱乐大堂 ===== */}
      <section className="lobby-hero-bg relative overflow-hidden">
        {/* 缓慢流动的舞台环境光 */}
        <div aria-hidden="true" className="lobby-aurora lobby-aurora-wine pointer-events-none absolute" />
        <div aria-hidden="true" className="lobby-aurora lobby-aurora-emerald pointer-events-none absolute" />
        <div aria-hidden="true" className="lobby-grain pointer-events-none absolute inset-0" />
        {/* 聚光灯 */}
        <div aria-hidden="true" className="spotlight pointer-events-none absolute inset-x-0 top-0 h-[420px]" />
        {/* 拱门穹顶 */}
        <div aria-hidden="true" className="lobby-arches pointer-events-none absolute inset-x-0 bottom-0 mx-auto hidden h-[540px] w-[min(92vw,880px)] sm:block">
          <div className="lobby-arch lobby-arch-outer absolute inset-0" />
          <div className="lobby-arch lobby-arch-middle absolute inset-x-8 top-10 bottom-0" />
          <div className="lobby-arch lobby-arch-inner absolute inset-x-16 top-20 bottom-0" />
        </div>
        {/* 两侧与舞台底部的微光浮尘 */}
        <div aria-hidden="true" className="lobby-dust pointer-events-none absolute inset-0">
          <i /><i /><i /><i /><i /><i /><i /><i /><i /><i />
        </div>
        <div aria-hidden="true" className="lobby-edge-fade pointer-events-none absolute inset-0" />

        <div className="relative z-10 mx-auto flex max-w-5xl flex-col items-center px-4 pb-24 pt-20 text-center sm:pt-28">
          <p className="rise-in text-xs font-bold text-[#e8c475]">
            <span className="tracking-[0.5em]">LUCKY GRAND</span> · 幸运娱乐大堂
          </p>
          <h1 className="rise-in rise-in-1 mt-6">
            <span className="jackpot-gradient font-num block text-[18vw] font-black leading-[0.95] tracking-tight sm:text-8xl">LUCKY</span>
            <span className="text-outline mt-2 block text-[9vw] font-black sm:text-5xl">幸运在此开牌</span>
          </h1>
          <p className="rise-in rise-in-2 mt-7 max-w-xl text-balance text-sm leading-7 text-muted-foreground sm:text-base">
            抽奖赢额度、决斗分奖池、老虎机天天开 —— 娱乐之余，
            这里的每一分额度都能换成真实的 API 调用。
          </p>

          <div className="rise-in rise-in-3 mt-10 flex flex-wrap items-center justify-center gap-4">
            {!user && (
              <a href={`/api/oauth/login?origin=${encodeURIComponent(window.location.origin)}`} className="btn-3d rounded-xl bg-[#FFB700] px-10 py-4 text-lg font-black text-[#162638]">
                使用 LINUX DO 登录
              </a>
            )}
            {user && !onboarded && (
              <Link to="/onboarding" className="btn-3d rounded-xl bg-[#FFB700] px-10 py-4 text-lg font-black text-[#162638]">
                完成入驻，领取新客礼遇
              </Link>
            )}
            {onboarded && (
              <>
                <Link to="/arena" className="btn-3d rounded-xl bg-[#FFB700] px-10 py-4 text-lg font-black text-[#162638]">
                  进入幸运决斗场
                </Link>
                <Link to="/entertainment" className="rounded-xl border border-[#af915f]/60 px-8 py-4 text-sm font-bold text-[#fce1b6] transition-colors hover:border-[#FFB700] hover:text-[#FFB700]">
                  今日手气 →
                </Link>
              </>
            )}
          </div>

          {/* 迎宾灯牌 */}
          <div className="rise-in rise-in-3 signboard mt-14 w-full max-w-2xl overflow-hidden rounded-full bg-[#0b1420]/80 px-6 py-2.5">
            <div className="animate-marquee flex w-max whitespace-nowrap text-xs font-bold">
              {[0, 1].map((k) => (
                <span key={k} className="signboard-text pr-12">
                  ✦ 欢迎光临幸运娱乐大堂 ✦ 新客抽奖 {range} 随机额度 ✦ 决斗场赢家税率全场公示 ✦ 老虎机 · 任意三连必中 ✦ 可验证公平 · 结算流水可查
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <main className="mx-auto max-w-6xl space-y-14 px-4 py-14">
        {onboarded && !!summary.data?.announcements.length && <section className="rounded-2xl border border-[#FFB700]/30 bg-[#101d2b] p-5 sm:p-6">
          <p className="text-xs font-bold tracking-[0.35em] text-[#af915f]">ANNOUNCEMENTS</p>
          <div className="mt-4 space-y-3">{summary.data.announcements.map((notice) => <Link key={notice.id} to={`/announcements/${notice.id}`} className="flex items-start justify-between gap-4 rounded-xl border border-border bg-[#162638]/50 p-4 transition-colors hover:border-[#FFB700]/60">
            <div><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${ANNOUNCEMENT_SEVERITY[notice.severity].cls}`}>{ANNOUNCEMENT_SEVERITY[notice.severity].label}</span><p className="font-bold text-[#fce1b6]">{notice.pinned ? "[置顶] " : ""}{notice.title}</p></div><p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{notice.content}</p></div>
            <span className="shrink-0 text-xs text-[#FFB700]">详情 →</span>
          </Link>)}</div>
        </section>}
        {/* ===== 已登录：快捷状态 ===== */}
        {onboarded && user && (
          <section className="rise-in card-luxe light-sweep flex flex-wrap items-center gap-4 rounded-2xl p-5 sm:p-6">
            <Avatar className="h-12 w-12 border border-[#af915f]/60">
              <AvatarImage src={user.avatarUrl} />
              <AvatarFallback className="bg-[#1d3145] text-sm text-[#fce1b6]">{(user.groupName ?? "U").slice(0, 1)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-[#fce1b6]">{user.groupName ?? user.username}，欢迎回来</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                当前余额 <span className="font-num font-bold text-[#FFB700]">${Number(user.balance).toFixed(2)}</span>
                <span className="mx-2 text-border">|</span>
                累计赢取 <span className="font-num text-[#00B77D]">${Number(user.totalWon).toFixed(2)}</span>
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs font-bold">
              <Link to="/console" className="rounded-lg border border-border px-4 py-2 text-muted-foreground transition-colors hover:border-[#FFB700] hover:text-[#FFB700]">控制台</Link>
              <Link to="/console/keys" className="rounded-lg border border-border px-4 py-2 text-muted-foreground transition-colors hover:border-[#FFB700] hover:text-[#FFB700]">生成 Key</Link>
              <Link to="/console/billing" className="rounded-lg border border-border px-4 py-2 text-muted-foreground transition-colors hover:border-[#FFB700] hover:text-[#FFB700]">额度流水</Link>
            </div>
          </section>
        )}

        {/* ===== 热门娱乐 ===== */}
        <section>
          <div className="flex items-end justify-between">
            <div>
              <p className="text-xs font-bold tracking-[0.4em] text-[#af915f]">CASINO FLOOR</p>
              <h2 className="mt-2 text-2xl font-black text-[#fce1b6]">热门娱乐</h2>
            </div>
            <Link to="/entertainment" className="flex items-center gap-1 text-xs font-bold text-[#FFB700] hover:underline">
              全部玩法 <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {GAMES.map((g, i) => (
              <Link key={g.title} to={g.to} className="card-luxe rise-in group rounded-2xl p-5" style={{ animationDelay: `${i * 70}ms` }}>
                <div className="flex items-center justify-between">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#af915f]/40 bg-[#162638] text-[#FFB700] transition-colors group-hover:border-[#FFB700]">
                    <g.icon className="h-5 w-5" />
                  </span>
                  <span className="rounded-full border border-[#af915f]/40 px-2.5 py-0.5 text-[10px] font-bold text-[#e8c475]">{g.tag}</span>
                </div>
                <h3 className="mt-4 text-base font-bold text-[#fce1b6]">{g.title}</h3>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{g.desc}</p>
                <p className="mt-3 text-xs font-bold text-[#FFB700] opacity-0 transition-opacity group-hover:opacity-100">开局 →</p>
              </Link>
            ))}
            {/* 决斗风云榜占第六格 */}
            <DuelBoard enabled={onboarded} />
          </div>
        </section>

        {/* ===== 活动横幅 ===== */}
        <section className="light-sweep relative overflow-hidden rounded-2xl border border-[#FFB700]/40 bg-gradient-to-r from-[#3d2a10] via-[#5b1a24] to-[#0d3b2e] p-6 sm:p-8">
          <div className="relative flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs font-bold tracking-[0.3em] text-[#e8c475]">WELCOME OFFER</p>
              <h3 className="mt-2 text-xl font-black text-[#fff3d6]">新客礼遇 · 一次抽奖赢 {range} 额度</h3>
              <p className="mt-1.5 text-xs leading-5 text-[#e8c475]/80">每个正式账号一次机会，抽中直接充入账户；未中奖也会保留参与记录，全看手气。</p>
            </div>
            {!onboarded && (
              <a href={`/api/oauth/login?origin=${encodeURIComponent(window.location.origin)}`} className="btn-3d shrink-0 rounded-xl bg-[#FFB700] px-8 py-3 font-black text-[#162638]">立即试试</a>
            )}
          </div>
        </section>

        {/* ===== 服务入口 ===== */}
        <section>
          <p className="text-xs font-bold tracking-[0.4em] text-[#af915f]">SERVICES</p>
          <h2 className="mt-2 text-2xl font-black text-[#fce1b6]">额度之外</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {SERVICES.map((s) => (
              <Link key={s.to} to={s.to} className="card-luxe group rounded-2xl p-5">
                <s.icon className="h-5 w-5 text-[#FFB700]" />
                <h3 className="mt-3 text-sm font-bold text-[#fce1b6]">{s.title}</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{s.desc}</p>
              </Link>
            ))}
          </div>
        </section>

        {/* ===== 公平与安全 ===== */}
        <section className="rounded-2xl border border-[#af915f]/40 bg-[#101d2b] p-6 sm:p-8">
          <p className="text-xs font-bold tracking-[0.4em] text-[#af915f]">FAIR &amp; SECURE</p>
          <h2 className="mt-2 text-2xl font-black text-[#fce1b6]">公平，写在明处</h2>
          <div className="mt-6 grid gap-6 sm:grid-cols-3">
            {FAIRNESS.map((f) => (
              <div key={f.title}>
                <f.icon className="h-5 w-5 text-[#FFB700]" />
                <h3 className="mt-3 text-sm font-bold text-[#fce1b6]">{f.title}</h3>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{f.desc}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-border py-8 text-center text-xs text-muted-foreground">
        <p>LUCKY·DRAW API 分发站 — 群内专享，请勿外传</p>
        <p className="mt-2">
          <a href="/admin" className="text-muted-foreground/60 transition-colors hover:text-[#FFB700]">管理后台</a>
        </p>
      </footer>

      {onboarded && videoReward && (
        <>
          <VideoRedEnvelopeEntry
            state={limitReached ? "done" : videoReward.canStart || videoReward.canResume ? "available" : "unavailable"}
            onClick={openVideoReward}
            dailyLimit={videoReward.dailyLimit}
            claimedCount={videoReward.claimedCount}
            remainingCount={videoReward.remainingCount}
          />
          <VideoRedEnvelopeDialog
            open={videoOpen}
            sessionKey={currentSession?.id ?? "not-started"}
            videoSrc={currentSession?.videoResource ?? videoReward.videoResource}
            fallbackSrc={(currentSession?.videoResource ?? videoReward.videoResource).endsWith(".webm")
              ? (currentSession?.videoResource ?? videoReward.videoResource).replace(/\.webm$/, ".mp4")
              : undefined}
            requiredSeconds={currentSession?.requiredSeconds ?? videoReward.minWatchSeconds}
            serverWatchedSeconds={currentSession?.watchedSeconds ?? 0}
            canClaim={currentSession?.ready === true}
            claiming={claimVideo.isPending}
            claimed={sessionClaimed}
            rewardRange={[videoReward.minReward, videoReward.maxReward]}
            dailyLimit={videoReward.dailyLimit}
            claimedCount={videoReward.claimedCount}
            remainingCount={videoReward.remainingCount}
            onHeartbeat={sendHeartbeat}
            onClaim={claim}
            onClose={() => setVideoOpen(false)}
          />
        </>
      )}
    </div>
  );
}
