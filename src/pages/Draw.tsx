import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { useMe } from "@/hooks/useMe";
import { SiteNav } from "@/components/SiteNav";
import { SlotMachine, type SlotResult } from "@/components/SlotMachine";
import { Confetti } from "@/components/Confetti";

/** 数字滚动动画 */
function CountUp({ value }: { value: number }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const dur = 1200;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      setDisplay(value * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{display.toFixed(2)}</>;
}

export default function Draw() {
  const { user, isLoading } = useMe({ requireAuth: true, requireOnboarded: true });
  const utils = trpc.useUtils();
  const status = trpc.draw.status.useQuery(undefined, { enabled: !!user?.onboarded, retry: false });
  const { data: cfg } = trpc.auth.publicConfig.useQuery();
  const [result, setResult] = useState<SlotResult>({ kind: "idle" });
  const [settled, setSettled] = useState(false);
  const drawRequestId = useRef<string | null>(null);
  const drawStatusApplied = useRef(false);

  const draw = trpc.draw.draw.useMutation();

  // 根据状态初始化展示
  useEffect(() => {
    if (drawStatusApplied.current) return;
    if (!status.data) return;
    if (status.data.result?.won && status.data.result.amount !== null) {
      drawStatusApplied.current = true;
      setResult({ kind: "already", amount: status.data.result.amount, symbols: status.data.result.symbols });
      setSettled(true);
    } else if (status.data.participated) {
      drawStatusApplied.current = true;
      setResult({ kind: "blocked", message: status.data.result?.message ?? "你已参与过本次一次性抽奖" });
      setSettled(true);
    }
  }, [status.data]);

  const spin = async () => {
    if (draw.isPending) return;
    setSettled(false);
    setResult({ kind: "spinning" });
    try {
      drawRequestId.current ??= crypto.randomUUID();
      const res = await draw.mutateAsync({ requestId: drawRequestId.current });
      const next: SlotResult =
        res.result === "won"
          ? { kind: "won", amount: res.amount!, symbols: res.symbols }
          : { kind: "blocked", message: res.message, symbols: res.symbols };
      drawStatusApplied.current = true;
      setResult(next);
    } catch (e) {
      setResult({ kind: "blocked", message: e instanceof Error ? e.message : "出错了，稍后再试" });
    }
  };

  if (isLoading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;

  return (
    <div className="min-h-screen">
      <SiteNav user={user} />
      <Confetti fire={result.kind === "won" && settled} />
      <main className="mx-auto flex max-w-3xl flex-col items-center px-4 py-14">
        <p className="rise-in text-xs font-bold tracking-[0.5em] text-[#af915f]">ONE SHOT · ONE ACCOUNT</p>
        <h1 className="rise-in rise-in-1 mt-3 text-center text-4xl font-black tracking-tight sm:text-5xl">
          {result.kind === "won" && settled ? (
            <span className="jackpot-gradient">JACKPOT!</span>
          ) : (
            <span className="text-outline">幸运抽奖</span>
          )}
        </h1>

        <div className="rise-in rise-in-2 mt-12">
          <SlotMachine result={result} onSettled={() => { setSettled(true); utils.invalidate(); }} />
        </div>

        {/* 结果区 */}
        <div className="mt-10 flex min-h-[150px] w-full flex-col items-center justify-center">
          {result.kind === "idle" && (
            <>
              {status.error ? (
                <div className="w-full max-w-md rounded-xl border border-[#EF5459]/50 bg-[#101d2b] p-6 text-center">
                  <p className="text-sm font-bold text-[#EF5459]">抽奖资格加载失败：{status.error.message}</p>
                  <button onClick={() => status.refetch()} className="mt-3 text-xs font-bold text-[#FFB700] hover:underline">重试</button>
                </div>
              ) : status.data && !status.data.canDraw && status.data.unavailableReason && status.data.unavailableReason !== "already_participated" ? (
                <div className="w-full max-w-md rounded-xl border border-border bg-[#101d2b] p-6 text-center">
                  <p className="text-sm font-bold text-[#fce1b6]">
                    {status.data.unavailableReason === "disabled" && "一次性抽奖暂未开放"}
                    {status.data.unavailableReason === "total_limit_reached" && "本轮名额已满"}
                    {status.data.unavailableReason === "budget_exhausted" && "奖池预算暂时耗尽"}
                  </p>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">去看看每日签到和老虎机，或到决斗场开一局</p>
                  <Link to="/entertainment" className="mt-4 inline-block text-xs font-bold text-[#FFB700] hover:underline">前往娱乐中心 →</Link>
                </div>
              ) : (
                <>
                  <button
                    onClick={spin}
                    disabled={status.isLoading || !status.data?.canDraw}
                    className="btn-3d glow-gold rounded-lg bg-[#FFB700] px-14 py-4 text-xl font-black text-[#162638]"
                  >
                    {status.isLoading ? "资格加载中…" : "立即抽奖"}
                  </button>
                  <p className="mt-5 text-xs text-muted-foreground">
                    中 ${status.data?.config.minReward ?? cfg?.drawMin ?? 5}–${status.data?.config.maxReward ?? cfg?.drawMax ?? 10} 随机额度 · 每个正式账号全局一次机会
                    {status.data?.config.totalLimit ? ` · 剩余名额 ${Math.max(0, status.data.config.totalLimit - status.data.config.used)}` : ""}
                  </p>
                </>
              )}
            </>
          )}
          {result.kind === "spinning" && <p className="font-num animate-pulse text-sm tracking-[0.4em] text-[#af915f]">ROLLING…</p>}

          {settled && result.kind === "won" && (
            <div className="rise-in text-center">
              <div className="font-num text-6xl font-black text-[#FFB700]" style={{ textShadow: "0 0 40px #FFB70066" }}>
                $<CountUp value={Number(result.amount)} />
              </div>
              <p className="mt-3 text-sm text-muted-foreground">额度已充入账户，去生成你的 API Key 吧</p>
              <Link
                to="/console"
                className="btn-3d mt-6 inline-block rounded-lg bg-[#FFB700] px-10 py-3 font-black text-[#162638]"
              >
                前往控制台 →
              </Link>
            </div>
          )}

          {settled && result.kind === "blocked" && (
            <div className="rise-in w-full max-w-md rounded-xl border border-[#EF5459]/50 bg-[#101d2b] p-5 sm:p-8 text-center">
              <p className="text-lg font-bold leading-8 text-[#EF5459]">{result.message}</p>
              <p className="mt-4 text-xs text-muted-foreground">参与结果已记录；更换网络不会增加抽奖次数</p>
            </div>
          )}

          {settled && result.kind === "already" && (
            <div className="rise-in w-full max-w-md rounded-xl border border-[#af915f]/40 bg-[#101d2b] p-5 sm:p-8 text-center">
              <p className="text-sm text-muted-foreground">你已中过奖</p>
              <div className="font-num mt-2 text-4xl font-black text-[#FFB700]">${Number(result.amount).toFixed(2)}</div>
              <p className="mt-3 text-xs text-muted-foreground">每个正式注册账号全局仅可中奖一次；历史记录永久保留用于审计，不可重置后重复参与</p>
              <Link to="/console" className="mt-5 inline-block text-sm font-bold text-[#FFB700] hover:underline">
                去控制台使用 →
              </Link>
            </div>
          )}
        </div>

        <p className="mt-8 text-center text-xs text-muted-foreground">
          抽奖资格按正式注册账号判断，IP 仅用于安全审计
        </p>

        {/* 更多玩法入口 */}
        <div className="mt-10 w-full max-w-lg">
          <Link
            to="/entertainment"
            className="flex items-center justify-between rounded-xl border border-[#af915f]/40 bg-[#101d2b] px-5 py-4 transition-colors hover:border-[#FFB700]"
          >
            <div>
              <p className="text-sm font-bold text-[#fce1b6]">更多玩法</p>
              <p className="mt-0.5 text-xs text-muted-foreground">老虎机 / 每日签到 / 幸运决斗场</p>
            </div>
            <span className="font-num text-lg font-black text-[#FFB700]">→</span>
          </Link>
        </div>
      </main>
    </div>
  );
}
