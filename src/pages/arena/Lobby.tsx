import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { Swords, LogIn, Loader2, Dices, Spade, Shield, RefreshCw, Trophy, Check } from "lucide-react";
import { useMe } from "@/hooks/useMe";
import { SiteNav } from "@/components/SiteNav";
import { trpc } from "@/providers/trpc";
import { DiceFace } from "@/components/arena/Dice";
import { PotBreakdown } from "@/components/arena/panels";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  GAME_LABEL, ROOM_CODE_PATTERN, type DuelGame,
  useDuelConfig, useDuelHistory, useDuelLobby, fmtMoney,
} from "@/lib/arena";
import { cn } from "@/lib/utils";

const GAME_ICON: Record<DuelGame, typeof Dices> = { dice: Dices, blackjack: Spade };

/** 幸运决斗场大厅：创建房间 / 房间码加入 / 公开房列表 / 我的战绩 */
export default function ArenaLobby() {
  const { user, isLoading } = useMe({ requireAuth: true, requireOnboarded: true });
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const configQ = useDuelConfig(!!user);
  const lobbyQ = useDuelLobby(!!user);
  const [historyPage, setHistoryPage] = useState(1);
  const historyQ = useDuelHistory(historyPage, !!user);

  const [game, setGame] = useState<DuelGame | null>(null);
  const [betText, setBetText] = useState<string>("");
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [joinCode, setJoinCode] = useState("");
  const [confirmJoin, setConfirmJoin] = useState<{ code: string; bet?: number } | null>(null);

  // 幂等 requestId：同一动作重试复用，成功后更换
  const ids = useRef<Record<string, string>>({});
  const rid = (key: string) => (ids.current[key] ??= crypto.randomUUID());
  const done = (key: string) => { delete ids.current[key]; };

  const createM = trpc.duel.create.useMutation({
    onSuccess: (room) => { done("create"); utils.duel.lobby.invalidate(); navigate(`/arena/${room.id}`); },
    onError: (e) => toast.error(e.message),
  });
  const joinM = trpc.duel.join.useMutation({
    onSuccess: (room) => { done("join"); utils.duel.lobby.invalidate(); navigate(`/arena/${room.id}`); },
    onError: (e) => toast.error(e.message),
  });

  if (isLoading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;

  const config = configQ.data;
  const balance = Number(user.balance ?? 0);
  const taxPercent = config?.winnerTaxPercent ?? 0;
  const quickBets = config?.quickBetOptions ?? config?.betOptions ?? [];
  const minBet = config?.minBet ?? 0;
  const maxBet = config?.maxBet ?? 0;
  const precision = config?.betPrecision ?? 2;
  const curBet = Number(betText);
  const decimals = (betText.split(".")[1] ?? "").length;
  const betError = !config || betText.trim() === "" ? null
    : !Number.isFinite(curBet) || curBet <= 0 ? "请输入有效的押注金额"
    : curBet < minBet || curBet > maxBet ? `自定义押注需在 ${fmtMoney(minBet)}～${fmtMoney(maxBet)} 之间`
    : decimals > precision ? `押注金额最多保留 ${precision} 位小数`
    : null;
  const betReady = !!config && betText.trim() !== "" && !betError;
  const minP = config?.minPlayers ?? 2;
  const maxP = config?.maxPlayers ?? 6;
  const effMaxPlayers = Math.min(Math.max(maxPlayers, minP), maxP);
  const gameEnabled = (g: DuelGame) => !!config?.enabled && !!config?.games?.[g];

  const create = () => {
    if (!config || !game || !betReady) return;
    if (balance < curBet) { toast.error("余额不足以支付该押注，先去控制台充值或抽奖吧"); return; }
    createM.mutate({ requestId: rid("create"), game, visibility, bet: curBet, maxPlayers: effMaxPlayers, expectedConfigVersion: config.version });
  };

  const join = (code: string) => {
    const c = code.trim().toUpperCase();
    if (!ROOM_CODE_PATTERN.test(c)) { toast.error("请输入 6 位房间码（大写字母与数字）"); return; }
    joinM.mutate({ requestId: rid("join"), code: c });
  };

  return (
    <div className="min-h-screen">
      <SiteNav user={user} />
      <main className="mx-auto max-w-4xl px-4 py-12">
        <div className="rise-in text-center">
          <p className="text-xs font-bold tracking-[0.5em] text-[#af915f]">LUCKY ARENA</p>
          <h1 className="mt-2 text-4xl font-black"><span className="text-outline">幸运决斗场</span></h1>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            2–{maxP} 人 PVP 奖池对决 · 赢家税率 {taxPercent}% 全场公示 · 可验证公平种子
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <Link
              to="/arena/leaderboard"
              className="inline-flex items-center gap-1.5 rounded-full border border-[#FFB700]/50 bg-[#FFB700]/10 px-4 py-1.5 text-xs font-bold text-[#FFB700] transition-colors hover:bg-[#FFB700]/20"
            >
              <Trophy className="h-3.5 w-3.5" /> 决斗风云榜
            </Link>
            {config && !config.enabled && (
              <span className="inline-block rounded-full border border-[#EF5459]/40 bg-[#EF5459]/10 px-3 py-1 text-[10px] font-bold text-[#EF5459]">
                决斗场当前维护中，暂不能创建或加入房间
              </span>
            )}
          </div>
        </div>

        {/* 玩法入口 */}
        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {(["dice", "blackjack"] as const).map((g) => {
            const Icon = GAME_ICON[g];
            const enabled = gameEnabled(g);
            const selected = game === g;
            return (
              <button
                key={g}
                type="button"
                aria-pressed={selected}
                onClick={() => setGame(g)}
                className={cn(
                  "rise-in relative rounded-xl border p-5 text-left transition-all",
                  selected
                    ? "border-[#FFB700] bg-[#FFB700]/10 shadow-[0_0_0_1px_rgba(255,183,0,0.25),0_12px_32px_rgba(255,183,0,0.08)]"
                    : "border-white/10 bg-[#0b1622]/70 opacity-65 hover:border-white/25 hover:opacity-90",
                  !enabled && "opacity-40",
                )}
              >
                {selected && (
                  <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full border border-[#FFB700]/50 bg-[#FFB700]/15 px-2 py-0.5 text-[10px] font-bold text-[#ffd978]">
                    <Check className="h-3 w-3" /> 已选择
                  </span>
                )}
                <p className={cn("flex items-center gap-2 pr-16 text-sm font-bold", selected ? "text-[#fff0cf]" : "text-slate-400")}>
                  <Icon className={cn("h-4 w-4", selected ? "text-[#FFB700]" : "text-slate-500")} />
                  {GAME_LABEL[g]}
                  {!enabled && <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">已关闭</span>}
                </p>
                <p className={cn("mt-2 text-xs leading-5", selected ? "text-slate-300" : "text-slate-500")}>{config?.rules?.[g] ?? "…"}</p>
              </button>
            );
          })}
          <Link
            to="/arena/team"
            className="rise-in rounded-xl border border-border bg-[#101d2b] p-5 text-left transition-colors hover:border-[#af915f]/60"
          >
            <p className="flex items-center gap-2 text-sm font-bold text-[#fce1b6]">
              <Shield className="h-4 w-4 text-[#FFB700]" /> 战队对抗
              <span className="rounded border border-[#af915f]/30 bg-white/5 px-1.5 py-0.5 text-[10px] text-[#af915f]">进入独立大厅</span>
            </p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              1v1 / 3v3 / 5v5 固定队席，实时奖池赔率，首票关盘后由选手多数投票结算。
            </p>
          </Link>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {/* 创建房间 */}
          <section className="rise-in rise-in-1 rounded-xl border border-border bg-[#101d2b] p-5 sm:p-6">
            <h2 className="flex items-center gap-2 text-sm font-bold text-[#fce1b6]">
              <Swords className="h-4 w-4 text-[#FFB700]" /> {game ? `创建${GAME_LABEL[game]}房间` : "请先选择上方玩法"}
            </h2>
            <p className="mt-3 text-xs text-muted-foreground">押注金额（每人，全员一致，开局时统一扣入托管）</p>
            {quickBets.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {quickBets.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setBetText(String(t))}
                    className={cn(
                      "font-num rounded-lg border px-4 py-2 text-sm font-bold transition-colors",
                      betReady && curBet === t ? "border-[#FFB700] bg-[#FFB700]/10 text-[#FFB700]" : "border-border text-muted-foreground hover:text-[#fce1b6]",
                    )}
                  >
                    {fmtMoney(t)}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-2 flex items-center gap-2">
              <span className="font-num text-sm font-bold text-[#af915f]">$</span>
              <input
                type="number"
                inputMode="decimal"
                min={minBet}
                max={maxBet}
                step={precision > 0 ? 1 / 10 ** precision : 1}
                value={betText}
                onChange={(e) => setBetText(e.target.value)}
                placeholder={config ? `自定义 ${fmtMoney(minBet)}–${fmtMoney(maxBet)}` : "加载配置中…"}
                className="font-num w-full rounded-lg border border-border bg-[#162638] px-3 py-2 text-sm text-[#fce1b6] outline-none placeholder:text-muted-foreground/40 focus:border-[#af915f]"
              />
            </div>
            <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
              {config ? `允许范围 ${fmtMoney(minBet)}～${fmtMoney(maxBet)} · 最多 ${precision} 位小数` : "押注范围加载中…"}
              {betError && <span className="ml-1 font-bold text-[#EF5459]">{betError}</span>}
              {!betError && betReady && balance < curBet && <span className="ml-1 font-bold text-[#EF5459]">当前余额不足</span>}
            </p>
            <p className="mt-4 text-xs text-muted-foreground">人数上限（{minP}–{maxP} 人）</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {Array.from({ length: maxP - minP + 1 }, (_, i) => minP + i).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setMaxPlayers(n)}
                  className={cn(
                    "font-num h-9 w-9 rounded-lg border text-sm font-bold transition-colors",
                    effMaxPlayers === n ? "border-[#FFB700] bg-[#FFB700]/10 text-[#FFB700]" : "border-border text-muted-foreground hover:text-[#fce1b6]",
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="mt-4 flex gap-2">
              {([["公开房", "public"], ["私密房", "private"]] as const).map(([label, v]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVisibility(v)}
                  className={cn(
                    "flex-1 rounded-lg border px-3 py-2 text-xs font-bold transition-colors",
                    visibility === v ? "border-[#FFB700] bg-[#FFB700]/10 text-[#FFB700]" : "border-border text-muted-foreground hover:text-[#fce1b6]",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-4">
              {betReady ? (
                <>
                  <PotBreakdown bet={curBet} playerCount={effMaxPlayers} feePercent={taxPercent} compact />
                  <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
                    按满员 {effMaxPlayers} 人估算；赢家税从毛奖池一次性扣除，税后由赢家平分，输家仅损失押注；税率快照以房间创建时配置为准
                  </p>
                </>
              ) : (
                <p className="rounded-lg border border-dashed border-border px-3 py-2 text-center text-[10px] text-muted-foreground">
                  输入有效押注后显示毛奖池 / 预计税额 / 税后奖池预览
                </p>
              )}
            </div>
            <button
              onClick={create}
              disabled={createM.isPending || !game || !betReady || (game ? !gameEnabled(game) : true) || balance < curBet}
              className="btn-3d mt-4 w-full rounded-lg bg-[#FFB700] py-3 font-black text-[#162638] disabled:opacity-40"
            >
              {createM.isPending ? "创建中…" : "创建并入座"}
            </button>
          </section>

          {/* 加入房间 */}
          <section className="rise-in rise-in-2 rounded-xl border border-border bg-[#101d2b] p-5 sm:p-6">
            <h2 className="flex items-center gap-2 text-sm font-bold text-[#fce1b6]">
              <LogIn className="h-4 w-4 text-[#FFB700]" /> 加入房间
            </h2>
            <p className="mt-3 text-xs text-muted-foreground">输入好友分享的 6 位房间码（大写字母与数字）</p>
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6))}
              onKeyDown={(e) => e.key === "Enter" && ROOM_CODE_PATTERN.test(joinCode) && setConfirmJoin({ code: joinCode })}
              placeholder="例如 LUCKY8"
              className="font-num mt-2 w-full rounded-lg border border-border bg-[#162638] px-4 py-3 text-center text-lg tracking-[0.5em] text-[#FFB700] outline-none placeholder:text-muted-foreground/40 focus:border-[#af915f]"
            />
            <button
              onClick={() => setConfirmJoin({ code: joinCode })}
              disabled={joinM.isPending || !ROOM_CODE_PATTERN.test(joinCode)}
              className="btn-3d mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-[#FFB700] py-3 font-black text-[#162638] disabled:opacity-40"
            >
              {joinM.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {joinM.isPending ? "加入中…" : "加入房间"}
            </button>
            <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
              加入不立即扣费；全员准备开局时才从每人额度原子扣除押注进入托管。当前赢家税率 {taxPercent}%，具体押注与预计税额以房间内公示为准
            </p>

            {/* 我的进行中的房间 */}
            {!!lobbyQ.data?.myRoomIds.length && (
              <div className="mt-4 border-t border-border pt-3">
                <p className="text-xs font-bold text-[#fce1b6]">我所在的房间</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {lobbyQ.data.myRoomIds.map((id) => (
                    <Link key={id} to={`/arena/${id}`} className="rounded-lg border border-[#176EFF]/40 bg-[#176EFF]/10 px-3 py-1.5 text-xs font-bold text-[#7db4ff] hover:bg-[#176EFF]/20">
                      回到房间 →
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>

        {/* 公开房列表 */}
        <section className="rise-in rise-in-3 mt-6 rounded-xl border border-border bg-[#101d2b] p-5 sm:p-6">
          <div className="flex items-center justify-between">
            <h2 className="t-section">公开房间</h2>
            <button
              onClick={() => lobbyQ.refetch()}
              className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-[#FFB700]"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", lobbyQ.isFetching && "animate-spin")} /> 刷新
            </button>
          </div>
          {!lobbyQ.data?.rooms.length ? (
            <p className="mt-4 py-6 text-center text-xs text-muted-foreground">暂时没有公开房间，创建一个等朋友来战吧</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[560px] text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">房间码</th>
                    <th className="pb-2 pr-3 font-medium">玩法</th>
                    <th className="pb-2 pr-3 font-medium">押注</th>
                    <th className="pb-2 pr-3 font-medium">人数</th>
                    <th className="pb-2 pr-3 font-medium">状态</th>
                    <th className="pb-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {lobbyQ.data.rooms.map((r) => {
                    const mine = lobbyQ.data.myRoomIds.includes(r.id);
                    return (
                      <tr key={r.id} className="border-b border-border/50 last:border-0">
                        <td className="font-num py-2.5 pr-3 font-bold tracking-[0.2em] text-[#FFB700]">{r.code}</td>
                        <td className="py-2.5 pr-3 text-[#fce1b6]">{GAME_LABEL[r.game as DuelGame] ?? r.game}</td>
                        <td className="font-num py-2.5 pr-3 text-[#fce1b6]">{fmtMoney(r.bet)}</td>
                        <td className="font-num py-2.5 pr-3 text-muted-foreground">{r.playerCount}/{r.maxPlayers}</td>
                        <td className="py-2.5 pr-3">
                          <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", r.status === "lobby" ? "bg-[#00B77D]/15 text-[#00B77D]" : r.status === "active" ? "bg-[#176EFF]/15 text-[#7db4ff]" : "bg-[#FFB700]/15 text-[#FFB700]")}>
                            {r.status === "lobby" ? "等待中" : r.status === "active" ? "对局中" : "可续下一局"}
                          </span>
                        </td>
                        <td className="py-2.5 text-right">
                          {mine ? (
                            <Link to={`/arena/${r.id}`} className="font-bold text-[#7db4ff] hover:underline">回到房间 →</Link>
                          ) : r.status !== "active" ? (
                            <button
                              onClick={() => setConfirmJoin({ code: r.code, bet: r.bet })}
                              disabled={joinM.isPending}
                              className="font-bold text-[#FFB700] hover:underline disabled:opacity-40"
                            >
                              加入 →
                            </button>
                          ) : (
                            <span className="text-muted-foreground">已开局</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 我的战绩 */}
        <section className="rise-in mt-6 rounded-xl border border-border bg-[#101d2b] p-5 sm:p-6">
          <h2 className="t-section">我的决斗战绩</h2>
          {!historyQ.data?.rows.length ? (
            <p className="mt-4 py-6 text-center text-xs text-muted-foreground">还没有决斗记录</p>
          ) : (
            <>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[720px] text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="pb-2 pr-3 font-medium">时间</th>
                      <th className="pb-2 pr-3 font-medium">玩法</th>
                      <th className="pb-2 pr-3 font-medium">房间</th>
                      <th className="pb-2 pr-3 font-medium">结果</th>
                      <th className="pb-2 pr-3 font-medium">牌型</th>
                      <th className="pb-2 pr-3 font-medium text-right">押注</th>
                      <th className="pb-2 pr-3 font-medium text-right">派彩</th>
                      <th className="pb-2 pr-3 font-medium text-right">净输赢</th>
                      <th className="pb-2 font-medium text-right">赢家税</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyQ.data.rows.map((row) => {
                      const net = row.settledNet ?? (row.payout - row.stake);
                      return (
                        <tr key={`${row.roomId}-${row.roundNo}-${row.seat}`} className="border-b border-border/50 last:border-0">
                          <td className="py-2.5 pr-3 whitespace-nowrap text-muted-foreground">
                            {row.finishedAt ? new Date(row.finishedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}
                          </td>
                          <td className="py-2.5 pr-3 text-[#fce1b6]">{GAME_LABEL[row.game as DuelGame] ?? row.game}</td>
                          <td className="py-2.5 pr-3">
                            <Link to={`/arena/${row.roomId}`} className="font-num font-bold tracking-widest text-[#FFB700] hover:underline">{row.code}</Link>
                            <span className="ml-1 rounded bg-white/5 px-1 py-0.5 text-[10px] text-muted-foreground">第{row.roundNo}局</span>
                          </td>
                          <td className="py-2.5 pr-3">
                            <span className={cn(
                              "rounded px-1.5 py-0.5 text-[10px] font-bold",
                              row.playerStatus === "winner" ? "bg-[#FFB700]/15 text-[#FFB700]"
                                : row.playerStatus === "refunded" || row.status === "cancelled" ? "bg-white/5 text-muted-foreground"
                                : "bg-[#EF5459]/10 text-[#EF5459]",
                            )}>
                              {row.playerStatus === "winner" ? "获胜" : row.playerStatus === "refunded" ? "已退款" : row.status === "cancelled" ? "已取消" : "未获胜"}
                            </span>
                          </td>
                          <td className="py-2.5 pr-3">
                            {row.game === "blackjack" && row.startedAt && row.handRank ? (
                              <span className={cn(
                                "rounded px-1.5 py-0.5 text-[10px] font-bold",
                                row.handRank.busted ? "bg-[#EF5459]/10 text-[#EF5459]"
                                  : row.handRank.isSpecial ? "bg-[#FFB700]/10 text-[#FFB700]"
                                  : "bg-white/5 text-muted-foreground",
                              )}>
                                {row.handRank.label}
                              </span>
                            ) : "—"}
                          </td>
                          <td className="font-num py-2.5 pr-3 text-right text-muted-foreground">{fmtMoney(row.stake)}</td>
                          <td className="font-num py-2.5 pr-3 text-right text-[#fce1b6]">{fmtMoney(row.payout)}</td>
                          <td className={cn("font-num py-2.5 pr-3 text-right font-bold", net > 0 ? "text-[#00B77D]" : net < 0 ? "text-[#EF5459]" : "text-muted-foreground")}>
                            {net > 0 ? "+" : ""}{fmtMoney(net)}
                          </td>
                          <td className="font-num py-2.5 text-right text-muted-foreground">{row.fee > 0 ? fmtMoney(row.fee) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {historyQ.data.totalPages > 1 && (
                <div className="mt-3 flex items-center justify-center gap-3 text-xs">
                  <button disabled={historyPage <= 1} onClick={() => setHistoryPage((p) => p - 1)} className="rounded border border-border px-3 py-1 disabled:opacity-40">上一页</button>
                  <span className="font-num text-muted-foreground">{historyQ.data.page} / {historyQ.data.totalPages}</span>
                  <button disabled={historyPage >= historyQ.data.totalPages} onClick={() => setHistoryPage((p) => p + 1)} className="rounded border border-border px-3 py-1 disabled:opacity-40">下一页</button>
                </div>
              )}
            </>
          )}
        </section>

        {/* 玩法规则：必须跟随当前玩法切换，避免二十一点继续显示骰子规则 */}
        <section className="rise-in mt-6 rounded-xl border border-border bg-[#101d2b] p-5 sm:p-6">
          <h2 className="t-section">{!game ? "玩法规则" : game === "dice" ? "幸运骰子规则" : "二十一点规则"}</h2>
          {!game ? (
            <p className="mt-4 rounded-lg border border-dashed border-border bg-[#162638]/30 p-6 text-center text-xs text-muted-foreground">请先在上方选择幸运骰子或二十一点，再查看对应规则并创建房间。</p>
          ) : game === "dice" ? (
            <>
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {([
                  ["豹子", [6, 6, 6], "三骰相同，最大"],
                  ["顺子", [3, 4, 5], "三连点数"],
                  ["对子", [2, 2, 5], "两骰相同"],
                  ["点数", [1, 3, 6], "其余比总点"],
                ] as const).map(([label, dice, desc]) => (
                  <div key={label} className="rounded-lg border border-border bg-[#162638] p-3 text-center">
                    <div className="flex justify-center gap-1">
                      {dice.map((v, i) => <DiceFace key={i} value={v} size="sm" />)}
                    </div>
                    <p className="mt-2 text-xs font-bold text-[#FFB700]">{label}</p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">{desc}</p>
                  </div>
                ))}
              </div>
              <ul className="mt-4 space-y-1.5 text-xs leading-5 text-muted-foreground">
                <li><span className="text-[#FFB700]">✦</span> 三颗骰子由服务端安全生成；牌型依次为豹子、顺子、对子、普通点数。</li>
                <li><span className="text-[#FFB700]">✦</span> 最高牌型并列时，仅并列领先者继续加赛，直至决出唯一赢家。</li>
                <li><span className="text-[#FFB700]">✦</span> 全员准备后才原子扣除押注进入托管；任何人余额不足或超限则整局回滚、无人扣款。</li>
                <li><span className="text-[#FFB700]">✦</span> 结算后房间保留，可重新准备开始下一局；所有人退出后房间关闭。</li>
              </ul>
            </>
          ) : (
            <>
              <p className="mt-4 text-xs font-bold text-[#fce1b6]">牌型优先级（大 → 小）</p>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
                {([
                  ["双 A", "起手两张 A，最大"],
                  ["五小", "恰好 5 张且不超 21 点"],
                  ["天然黑杰克", "起手 A + 10/J/Q/K"],
                  ["点数", "不爆牌比点数，越接近 21 越大"],
                  ["爆牌", "超过 21 点，最小"],
                ] as const).map(([label, desc]) => (
                  <div key={label} className="rounded-lg border border-border bg-[#162638] p-3 text-center">
                    <p className="text-xs font-bold text-[#FFB700]">{label}</p>
                    <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{desc}</p>
                  </div>
                ))}
              </div>
              <ul className="mt-4 space-y-1.5 text-xs leading-5 text-muted-foreground">
                <li><span className="text-[#FFB700]">✦</span> 所有人共用一副服务端洗牌的 52 张牌和唯一发牌游标；多人同时要牌也不会出现重复实体牌。</li>
                <li><span className="text-[#FFB700]">✦</span> 60 秒暗牌并行窗口内，每人只看自己的手牌和点数；对手的牌、点数、爆牌与特殊牌型均保持隐藏。</li>
                <li><span className="text-[#FFB700]">✦</span> 双 A、五小、天然黑杰克、21 点或爆牌会自动完成；所有人完成或超时后统一揭牌。</li>
                <li><span className="text-[#FFB700]">✦</span> 最高同级赢家平分税后奖池；特殊牌型只影响胜负优先级，不额外增发额度；全员爆牌原额退款。</li>
                <li><span className="text-[#FFB700]">✦</span> 结算后公开种子、牌堆和手牌供核验；房间保留，可重新准备开始下一局。</li>
              </ul>
            </>
          )}
          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            <span className="text-[#FFB700]">✦</span> 毛奖池 = 押注 × 人数；赢家税只从毛奖池扣除一次，税后奖池由赢家获得或平分。
          </p>
        </section>
      </main>

      {/* 加入确认：税率透明 */}
      <AlertDialog open={!!confirmJoin} onOpenChange={(open) => !open && setConfirmJoin(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>加入房间 {confirmJoin?.code}？</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {confirmJoin?.bet != null && (
                  <p>每人押注 <span className="font-num font-bold text-[#FFB700]">{fmtMoney(confirmJoin.bet)}</span>；当前赢家税率 <span className="font-num font-bold text-[#FFB700]">{taxPercent}%</span>，结算时从毛奖池一次性扣除，税后由赢家平分。</p>
                )}
                <p>加入不会立即扣费；全员准备开局时才从每人额度原子扣除押注进入托管，开局后不能退出。</p>
                {confirmJoin?.bet == null && (
                  <p>当前赢家税率 <span className="font-num font-bold text-[#FFB700]">{taxPercent}%</span>：结算时从毛奖池一次性扣除赢家税，税后奖池由赢家平分，输家仅损失押注。具体押注金额与预计税额以房间内公示为准。</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>再想想</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const c = confirmJoin?.code ?? ""; setConfirmJoin(null); join(c); }}>确认加入</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
