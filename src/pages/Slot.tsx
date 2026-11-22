import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { useMe } from "@/hooks/useMe";
import { SiteNav } from "@/components/SiteNav";
import { SlotMachine, type SlotResult } from "@/components/SlotMachine";
import { SLOT_DEFAULT_BET, dollarsToMoneyUnits, settlementRtpForBet, formatProbabilityPercent } from "@contracts/slot-machine";

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

export default function Slot() {
  const { user, isLoading } = useMe({ requireAuth: true, requireOnboarded: true });
  const utils = trpc.useUtils();
  const checkinStatus = trpc.member.checkinStatus.useQuery(undefined, { enabled: !!user?.onboarded });
  const [checkinResult, setCheckinResult] = useState<SlotResult>({ kind: "idle" });
  const [checkinSettled, setCheckinSettled] = useState(false);
  const [slotBet, setSlotBet] = useState(SLOT_DEFAULT_BET);
  const slotRequestId = useRef<string | null>(null);
  const slotStatusApplied = useRef(false);

  const checkin = trpc.member.checkin.useMutation();

  // 今日已参与时恢复当局结果
  useEffect(() => {
    if (slotStatusApplied.current) return;
    const record = checkinStatus.data?.result;
    if (!checkinStatus.data?.done) return;
    slotStatusApplied.current = true;
    if (!record?.symbols) {
      setCheckinResult({ kind: "blocked", message: "今日已参与（旧版记录未保存符号），明天再来" });
      setCheckinSettled(true);
      return;
    }
    setCheckinResult({
      kind: "slot",
      symbols: record.symbols,
      bet: record.bet,
      payoutMultiplier: record.payoutMultiplier,
      grossPayout: record.grossPayout,
      netChange: record.netChange,
      win: record.win,
      message: record.win
        ? `三连中奖，返还 $${record.grossPayout.toFixed(2)}`
        : `未组成三连，本局净变化 -$${record.bet.toFixed(2)}`,
    });
    setCheckinSettled(true);
  }, [checkinStatus.data]);

  useEffect(() => {
    const rules = checkinStatus.data?.rules;
    if (!rules || rules.allowedMaxBet <= 0) return;
    setSlotBet((current) => Math.min(rules.allowedMaxBet, Math.max(rules.minBet, current)));
  }, [checkinStatus.data?.rules]);

  const spinCheckin = async () => {
    if (checkin.isPending) return;
    setCheckinSettled(false);
    setCheckinResult({ kind: "spinning" });
    slotRequestId.current ??= crypto.randomUUID();
    try {
      const expectedConfigVersion = checkinStatus.data?.rules.configVersion;
      if (!expectedConfigVersion) throw new Error("老虎机规则尚未加载，请稍后重试");
      const res = await checkin.mutateAsync({ requestId: slotRequestId.current, expectedConfigVersion, bet: slotBet });
      if (!res.symbols) throw new Error("服务端未返回有效符号");
      slotStatusApplied.current = true;
      setCheckinResult({
        kind: "slot",
        symbols: res.symbols,
        bet: res.bet,
        payoutMultiplier: res.payoutMultiplier,
        grossPayout: res.grossPayout,
        netChange: res.netChange,
        win: res.win,
        message: res.win
          ? `三连中奖，返还 $${res.grossPayout.toFixed(2)}`
          : `未组成三连，本局净变化 -$${res.bet.toFixed(2)}`,
      });
    } catch (e) {
      setCheckinResult({ kind: "blocked", message: e instanceof Error ? e.message : "出错了，稍后再试" });
      checkinStatus.refetch();
    }
  };

  const liveRules = checkinStatus.data?.rules;
  const betRtp = liveRules && slotBet >= liveRules.minBet && slotBet <= liveRules.maxBet
    ? settlementRtpForBet({ version: liveRules.configVersion, name: liveRules.configName,
        minBetUnits: dollarsToMoneyUnits(liveRules.minBet), maxBetUnits: dollarsToMoneyUnits(liveRules.maxBet), tiers: liveRules.tiers,
      }, dollarsToMoneyUnits(slotBet)).rtpPpm : null;
  const betOptions = liveRules
    ? Array.from(new Set([0.1, 0.5, 1, 2, 5, liveRules.allowedMaxBet]))
      .filter((amount) => amount >= liveRules.minBet && amount <= liveRules.allowedMaxBet)
      .sort((a, b) => a - b)
    : [0.1, 0.5, 1, 2, 5];

  if (isLoading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;

  return (
    <div className="min-h-screen">
      <SiteNav user={user} />
      <main className="mx-auto flex max-w-3xl flex-col items-center px-4 py-14">
        <p className="rise-in text-xs font-bold tracking-[0.5em] text-[#af915f]">DAILY BONUS</p>
        <h1 className="rise-in rise-in-1 mt-3 text-center text-4xl font-black tracking-tight sm:text-5xl">
          <span className="text-outline">老虎机</span>
        </h1>
        <p className="rise-in rise-in-1 mt-3 text-xs text-muted-foreground">
          <Link to="/entertainment" className="font-bold text-[#FFB700] hover:underline">← 返回娱乐中心</Link>
        </p>

        {checkinStatus.isLoading && <div className="rise-in rise-in-2 mt-10 w-full max-w-lg rounded-xl border border-border bg-[#101d2b] p-6 text-center text-sm text-muted-foreground">加载老虎机状态中…</div>}
        {checkinStatus.error && <div className="rise-in rise-in-2 mt-10 w-full max-w-lg rounded-xl border border-[#EF5459]/50 bg-[#101d2b] p-6 text-center"><p className="text-sm font-bold text-[#EF5459]">老虎机状态加载失败：{checkinStatus.error.message}</p><button onClick={() => checkinStatus.refetch()} className="mt-3 text-xs font-bold text-[#FFB700] hover:underline">重试</button></div>}
        {checkinStatus.data && (
          <div className="rise-in rise-in-2 mt-10 w-full max-w-lg rounded-xl border border-border bg-[#101d2b] p-5 sm:p-8 text-center">
            <p className="text-xs text-muted-foreground">
              服务端开奖 · 今日剩余 {checkinStatus.data?.remaining ?? 0}/{checkinStatus.data?.dailyLimit ?? 0} 次 · 当前规则 {liveRules?.configVersion ?? "加载中"}
            </p>
            {liveRules?.promotion && (
              <div className="mt-3 rounded-lg border border-[#FFB700]/50 bg-[#2a210b] px-4 py-2 text-xs leading-5 text-[#ffe3a0]">
                放水活动「{liveRules.promotion.name}」进行中，至 {new Date(liveRules.promotion.endsAt).toLocaleString("zh-CN")}；所有用户使用相同活动概率。
              </div>
            )}

            <div className="mt-6">
              <SlotMachine result={checkinResult} onSettled={() => { setCheckinSettled(true); utils.invalidate(); }} />
            </div>

            <div className="mt-6 flex min-h-[90px] flex-col items-center justify-center">
              {checkinResult.kind === "idle" && (
                <>
                  {!checkinStatus.data.enabled ? (
                    <div className="rounded-xl border border-border bg-[#162638] p-5">
                      <p className="text-sm font-bold text-[#fce1b6]">老虎机暂未开放</p>
                      <p className="mt-1.5 text-xs text-muted-foreground">后台关闭或每日次数设为 0 时不会消耗额度与次数</p>
                    </div>
                  ) : (checkinStatus.data?.remaining ?? 0) <= 0 ? (
                    <div className="rounded-xl border border-border bg-[#162638] p-5">
                      <p className="text-sm font-bold text-[#fce1b6]">今日次数已用完</p>
                      <p className="mt-1.5 text-xs text-muted-foreground">每个业务日 {checkinStatus.data?.dailyLimit ?? 0} 次，下个业务日再来</p>
                    </div>
                  ) : (
                    <>
                      <div className="mb-4 flex items-center justify-center gap-2">
                        <span className="text-xs text-muted-foreground">下注</span>
                        {betOptions.map((amount) => <button key={amount} type="button"
                          onClick={() => setSlotBet(amount)}
                          className={`rounded border px-3 py-1.5 text-xs font-bold ${slotBet === amount ? "border-[#FFB700] bg-[#FFB700]/10 text-[#FFB700]" : "border-border text-muted-foreground"}`}>
                          ${amount.toFixed(2)}
                        </button>)}
                      </div>
                      <button
                        onClick={spinCheckin}
                        disabled={Number(user.balance) < slotBet || !!liveRules?.paused || !liveRules}
                        className="btn-3d rounded-lg bg-[#FFB700] px-10 py-3 font-black text-[#162638] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        下注 ${slotBet.toFixed(2)} 并旋转
                      </button>
                      {Number(user.balance) < slotBet && <p className="mt-2 text-xs text-[#EF5459]">可用余额不足</p>}
                      {liveRules?.paused && <p className="mt-2 text-xs leading-5 text-[#EF5459]">{liveRules.pausedReason}</p>}
                      {liveRules && !liveRules.paused && liveRules.allowedMaxBet < liveRules.maxBet && (
                        <p className="mt-2 text-xs text-[#FFB700]">风险控制已将当前最高下注调整为 ${liveRules.allowedMaxBet.toFixed(2)}</p>
                      )}
                    </>
                  )}
                </>
              )}
              {checkinResult.kind === "spinning" && (
                <p className="font-num animate-pulse text-xs tracking-[0.4em] text-[#af915f]">ROLLING…</p>
              )}
              {checkinSettled && checkinResult.kind === "slot" && <div className="rise-in">
                <div className={`font-num text-4xl font-black ${checkinResult.netChange >= 0 ? "text-[#FFB700]" : "text-[#EF5459]"}`}>
                  {checkinResult.netChange >= 0 ? "+" : "-"}$<CountUp value={Math.abs(checkinResult.netChange)} />
                </div>
                <p className="mt-2 text-sm font-bold text-[#fce1b6]">{checkinResult.message}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  下注 ${checkinResult.bet.toFixed(2)} · 返还 ${checkinResult.grossPayout.toFixed(2)} ·
                  倍率 ×{checkinResult.payoutMultiplier}
                </p>
                {(checkinStatus.data?.remaining ?? 0) > 0 ? (
                  <button
                    onClick={() => { slotRequestId.current = null; setCheckinResult({ kind: "idle" }); setCheckinSettled(false); }}
                    className="btn-3d mt-4 rounded-lg bg-[#FFB700] px-8 py-2.5 text-sm font-black text-[#162638]"
                  >
                    再转一次（剩余 {checkinStatus.data?.remaining} 次）
                  </button>
                ) : (
                  <p className="mt-4 text-xs text-muted-foreground">今日次数已用完，下个业务日再来</p>
                )}
              </div>}
              {checkinSettled && checkinResult.kind === "blocked" && (
                <p className="rise-in text-sm font-bold leading-6 text-[#EF5459]">{checkinResult.message}</p>
              )}
            </div>
            <div className="mt-5 border-t border-border pt-4 text-left">
              <p className="text-xs font-bold text-[#af915f]">赔付表（三连）</p>
              <div className="mt-2 grid grid-cols-5 gap-1.5">
                {liveRules?.tiers.map((tier) => <div key={tier.id} className="rounded bg-[#162638] p-2 text-center">
                  <div className="text-xl">{tier.glyph}</div>
                  <div className="font-num mt-1 text-[11px] text-[#fce1b6]">×{tier.multiplier}</div>
                  <div className="font-num mt-0.5 text-[10px] text-muted-foreground">{tier.probabilityPercent}%</div>
                </div>)}
              </div>
              <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                服务端先按公开奖项档位开奖，再返回对应三连视觉；其他组合返还 0。理论中奖率
                {" "}{((liveRules?.theoretical.winRate ?? 0) * 100).toFixed(2)}%，
                当前下注 ${slotBet.toFixed(2)} 的理论返奖率（含本金，按分结算）：{betRtp === null ? "—" : `${formatProbabilityPercent(betRtp)}%`}。
              </p>
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
              <p className="mt-0.5 text-xs text-muted-foreground">一次性抽奖 / 每日签到 / 幸运决斗场</p>
            </div>
            <span className="font-num text-lg font-black text-[#FFB700]">→</span>
          </Link>
        </div>
      </main>
    </div>
  );
}
