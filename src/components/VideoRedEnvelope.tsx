import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Gift, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { monotonicWatchedSeconds } from "@/lib/video-reward-state";

const fmt = (n: number) => `$${n.toFixed(2)}`;

/** 悬浮入口状态：available 今日可领 / done 今日已领 */
export type VideoRedEnvelopeState = "available" | "done" | "unavailable";

/**
 * 首页悬浮红包入口：桌面右侧垂直居中，移动端右下角并避开安全区。
 * 金红包 + 脉冲光圈 + 角标，不遮挡页面主操作区。
 */
export function VideoRedEnvelopeEntry({ state, onClick, dailyLimit, claimedCount, remainingCount }: {
  state: VideoRedEnvelopeState;
  onClick: () => void;
  dailyLimit?: number;
  claimedCount?: number;
  remainingCount?: number;
}) {
  const available = state === "available";
  const done = state === "done";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={available ? "看视频领红包" : done ? "今日红包已领取" : "视频红包暂不可用"}
      className={cn(
        "fixed z-40 flex flex-col items-center gap-1 outline-none",
        // 桌面：右侧垂直居中；移动端：右下角，避开底部安全区
        "right-4 top-1/2 -translate-y-1/2",
        "max-sm:bottom-[calc(5rem+env(safe-area-inset-bottom))] max-sm:top-auto max-sm:translate-y-0",
      )}
    >
      <span className="relative flex h-14 w-14 items-center justify-center">
        {available && (
          <span className="absolute inset-0 animate-ping rounded-full bg-[#FFB700]/30" aria-hidden />
        )}
        <span
          className={cn(
            "relative flex h-14 w-14 items-center justify-center rounded-full border shadow-lg transition-transform hover:scale-105",
            available
              ? "btn-3d border-[#FFB700] bg-gradient-to-b from-[#FFB700] to-[#d99700] text-[#5b1a24]"
              : "border-border bg-[#162638] text-muted-foreground",
          )}
        >
          <Gift className="h-6 w-6" />
        </span>
        <span
          className={cn(
            "absolute -right-1 -top-1 rounded-full px-1.5 py-0.5 text-[9px] font-black leading-none",
            available ? "bg-[#EF5459] text-white" : "bg-white/10 text-muted-foreground",
          )}
        >
          {available && remainingCount !== undefined ? `${remainingCount}次` : available ? "可领" : done ? "已领" : "暂停"}
        </span>
      </span>
      <span className={cn("text-[10px] font-bold", available ? "text-[#FFB700]" : "text-muted-foreground")}>
        {available ? `今日剩 ${remainingCount ?? "—"} 次` : done ? "明日再来" : "暂未开放"}
      </span>
      {dailyLimit !== undefined && claimedCount !== undefined && <span className="text-[9px] text-muted-foreground">已领 {claimedCount}/{dailyLimit}</span>}
    </button>
  );
}

/**
 * 横版视频观看弹层（纯交互组件，不含接口调用）：
 * - 原生 controls 关闭，禁拖动/快进/倍速（seek 回退到已看进度，ratechange 强制 1）
 * - 页面失焦/隐藏立即暂停且不计时；进度只按实际向前播放累计（重看不重复计）
 * - 倒计时与进度由 watchedSeconds 驱动；满 requiredSeconds 才允许点击领取
 * - onProgress 在整秒变化时回调，供容器节流上报 heartbeat；是否可领最终以服务端为准
 */
export function VideoRedEnvelopeDialog(props: {
  open: boolean;
  sessionKey: number | string;
  videoSrc: string;
  fallbackSrc?: string;
  requiredSeconds: number;
  serverWatchedSeconds: number;
  /** 服务端确认的可领状态（心跳累计达标后为 true） */
  canClaim: boolean;
  claiming: boolean;
  claimed: boolean;
  rewardRange?: readonly [number, number];
  dailyLimit?: number;
  claimedCount?: number;
  remainingCount?: number;
  onHeartbeat: () => void;
  onClaim: () => void;
  onClose: () => void;
}) {
  // 关闭只卸载播放器；重新打开时从 Home 保存的单调服务端 session 基线恢复。
  if (!props.open) return null;
  return <VideoRedEnvelopeSession key={props.sessionKey} {...props} />;
}

function VideoRedEnvelopeSession({
  videoSrc,
  fallbackSrc,
  requiredSeconds,
  serverWatchedSeconds,
  canClaim,
  claiming,
  claimed,
  rewardRange,
  dailyLimit,
  claimedCount,
  remainingCount,
  onHeartbeat,
  onClaim,
  onClose,
}: Omit<Parameters<typeof VideoRedEnvelopeDialog>[0], "open" | "sessionKey">) {
  const videoRef = useRef<HTMLVideoElement>(null);
  /** 已计入的最大播放位置：防拖动 + 重看不重复累计共用同一水位线 */
  const maxCountedRef = useRef(0);
  const [watched, setWatched] = useState(serverWatchedSeconds);
  const [playing, setPlaying] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const heartbeatRef = useRef(onHeartbeat);
  useEffect(() => { heartbeatRef.current = onHeartbeat; }, [onHeartbeat]);

  const serverConfirmed = canClaim ? requiredSeconds : Math.min(requiredSeconds, serverWatchedSeconds);
  const displayWatched = monotonicWatchedSeconds(watched, serverConfirmed, requiredSeconds);
  const locallyComplete = displayWatched >= requiredSeconds;
  const done = canClaim;
  const remain = Math.max(0, Math.ceil(requiredSeconds - displayWatched));
  const percent = Math.min(100, (displayWatched / requiredSeconds) * 100);

  useEffect(() => {
    if (!playing || claimed || canClaim) return;
    const timer = window.setInterval(() => heartbeatRef.current(), 1_000);
    return () => window.clearInterval(timer);
  }, [playing, claimed, canClaim]);

  useEffect(() => {
    if (canClaim) videoRef.current?.pause();
  }, [canClaim]);

  // 页面失焦/隐藏：立即暂停且不计时
  useEffect(() => {
    const pause = () => { const v = videoRef.current; if (v && !v.paused) v.pause(); };
    const onVisibility = () => { if (document.hidden) pause(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", pause);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", pause);
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="看视频领红包"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="rise-in w-[min(94vw,880px)] rounded-2xl border border-[#FFB700]/40 bg-[#101d2b] p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold tracking-[0.35em] text-[#af915f]">DAILY RED PACKET</p>
            <h2 className="mt-1 text-base font-black text-[#fce1b6]">
              看视频领红包
              {rewardRange && <span className="font-num ml-2 text-xs text-[#FFB700]">{fmt(rewardRange[0])}–{fmt(rewardRange[1])}</span>}
            </h2>
            {dailyLimit !== undefined && claimedCount !== undefined && remainingCount !== undefined && <p className="mt-1 text-[11px] text-muted-foreground">今日已领取 {claimedCount}/{dailyLimit} 次 · 剩余 <b className="text-[#FFB700]">{remainingCount}</b> 次</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-lg border border-border p-1.5 text-muted-foreground transition-colors hover:border-[#FFB700] hover:text-[#FFB700]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 横版 16:9 播放器：桌面/移动端 contain */}
        <div className="mt-3 overflow-hidden rounded-xl border border-border bg-black">
          <div className="relative aspect-video w-full">
            {videoError ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                视频加载失败，请稍后重试
              </div>
            ) : (
              <video
                ref={videoRef}
                className="h-full w-full object-contain"
                playsInline
                preload="auto"
                controls={false}
                controlsList="nodownload noremoteplayback"
                disablePictureInPicture
                onContextMenu={(e) => e.preventDefault()}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onError={() => setVideoError(true)}
                onEnded={() => {
                  const video = videoRef.current;
                  if (video && !canClaim) {
                    video.currentTime = 0;
                    video.play().catch(() => undefined);
                  }
                }}
                onRateChange={() => {
                  const v = videoRef.current;
                  if (v && v.playbackRate !== 1) v.playbackRate = 1;
                }}
                onSeeking={() => {
                  const v = videoRef.current;
                  if (v && v.currentTime > maxCountedRef.current + 0.35) v.currentTime = maxCountedRef.current;
                }}
                onTimeUpdate={() => {
                  const v = videoRef.current;
                  if (!v || v.paused || document.hidden) return;
                  const t = v.currentTime;
                  // 只累计向前的新进度：回看重看（t <= 水位线）不重复计时
                  if (t > maxCountedRef.current) {
                    const delta = t - maxCountedRef.current;
                    if (delta <= 1.25) {
                      maxCountedRef.current = t;
                      setWatched((current) => Math.min(requiredSeconds, Math.max(current, serverConfirmed) + delta));
                    } else {
                      // 异常跳变（绕过 seeking 的情况）：拉回水位线
                      v.currentTime = maxCountedRef.current;
                    }
                  }
                }}
              >
                <source src={videoSrc} type={videoSrc.endsWith(".webm") ? "video/webm" : undefined} />
                {fallbackSrc && <source src={fallbackSrc} type="video/mp4" />}
              </video>
            )}
            {!playing && !videoError && !done && (
              <button
                type="button"
                onClick={() => videoRef.current?.play().catch(() => undefined)}
                className="absolute inset-0 flex items-center justify-center bg-black/40 text-sm font-bold text-[#fce1b6]"
              >
                ▶ 点击开始观看
              </button>
            )}
          </div>
        </div>

        {/* 进度与倒计时 */}
        <div className="mt-3">
          <div className="h-2 overflow-hidden rounded-full bg-[#162638]">
            <div
              className={cn("h-full rounded-full transition-[width] duration-300", done ? "bg-[#00B77D]" : "bg-[#FFB700]")}
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="font-num">观看进度 {Math.floor(displayWatched)}s / {requiredSeconds}s · 服务端确认 {Math.floor(serverConfirmed)}s</span>
            {done
              ? <span className="font-bold text-[#00B77D]">观看完成，可以领取</span>
              : locallyComplete
                ? <span className="font-bold text-[#FFB700]">等待服务端确认进度…</span>
                : <span>还需 <span className="font-num font-bold text-[#FFB700]">{remain}</span> 秒 · 请勿切出页面，拖动/快进无效</span>}
          </p>
        </div>

        <button
          type="button"
          onClick={onClaim}
          disabled={!done || !canClaim || claiming || claimed}
          className={cn(
            "btn-3d mt-4 flex w-full items-center justify-center gap-2 rounded-xl py-3 font-black disabled:opacity-40",
            claimed ? "bg-[#00B77D] text-white" : "bg-[#FFB700] text-[#162638]",
          )}
        >
          {claiming ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> 领取中…</>
          ) : claimed ? (
            <><CheckCircle2 className="h-4 w-4" /> 今日已领取，明天再来</>
          ) : locallyComplete && !canClaim ? (
            <>等待服务端确认进度…</>
          ) : (
            <><Gift className="h-4 w-4" /> {done ? "领取红包" : `看满 ${requiredSeconds} 秒后可领取`}</>
          )}
        </button>
      </div>
    </div>
  );
}
