import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Copy, LogOut, Dices, Loader2, RotateCcw } from "lucide-react";
import { useMe } from "@/hooks/useMe";
import { SiteNav } from "@/components/SiteNav";
import { PlayerSeat, EmptySeat } from "@/components/arena/PlayerSeat";
import { FairnessPanel, RoomStatusBanner, PotBreakdown } from "@/components/arena/panels";
import {
  GAME_LABEL, type DuelGame, type DuelPlayer,
  useArenaActions, useDuelRoom, useNow, winnersOf, winnerBreakdown, canActBlackjack, fmtMoney,
} from "@/lib/arena";

/** 从房间配置快照里取超时秒数 */
function snapshotNumber(room: { configSnapshotJson?: string | null }, key: string, fallback: number) {
  try {
    const s = JSON.parse(room.configSnapshotJson ?? "{}") as Record<string, unknown>;
    return typeof s[key] === "number" ? (s[key] as number) : fallback;
  } catch {
    return fallback;
  }
}

/** 决斗场房间页：等待 / 骰子开奖与加赛 / 二十一点牌桌 / 结算 / 取消 / 退款 全状态 */
export default function ArenaRoomPage() {
  const { roomId = "" } = useParams();
  const navigate = useNavigate();
  const { user, isLoading } = useMe({ requireAuth: true, requireOnboarded: true });
  const roomQ = useDuelRoom(roomId, !!user);
  const actions = useArenaActions(roomId);
  const now = useNow();

  if (isLoading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;

  const room = roomQ.data;
  const err = roomQ.error;

  if (err) {
    return (
      <div className="min-h-screen">
        <SiteNav user={user} />
        <main className="mx-auto max-w-md px-4 py-24">
          <div className="rise-in rounded-xl border border-border bg-[#101d2b] p-8 text-center">
            <p className="text-lg font-bold text-[#fce1b6]">无法进入房间</p>
            <p className="mt-2 text-xs text-muted-foreground">{err.message || "房间不存在、已解散或你无权查看"}</p>
            <Link to="/arena" className="btn-3d mt-6 inline-block rounded-lg bg-[#FFB700] px-8 py-2.5 text-sm font-black text-[#162638]">
              返回大厅
            </Link>
          </div>
        </main>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="min-h-screen">
        <SiteNav user={user} />
        <main className="mx-auto max-w-3xl px-4 py-24 text-center text-sm text-muted-foreground">正在进入房间…</main>
      </div>
    );
  }

  const me: DuelPlayer | undefined = room.players.find((p) => p.userId === user.id);
  const isHost = !!me?.isHost;
  const inLobby = room.status === "lobby";
  const active = room.status === "active";
  const finished = room.status === "settled" || room.status === "cancelled" || room.status === "refunded";
  const taxPercent = room.winnerTaxPercent ?? 0;
  const game = room.game as DuelGame;

  const diceState = game === "dice" ? (room.state as { rounds?: { round: number }[]; contenderSeats?: number[] } | null) : null;
  const diceTie = active && game === "dice" && (diceState?.contenderSeats?.length ?? 0) > 1;

  const myTurn = canActBlackjack(room, me);
  const actionRemain = room.actionDeadlineAt ? Math.max(0, Math.ceil((room.actionDeadlineAt.getTime() - now) / 1000)) : null;

  // 等待期房间过期倒计时（仅首局；多回合房间不再过期）
  const roomTimeout = snapshotNumber(room, "roomTimeoutSeconds", 1800);
  const lobbyRemain = inLobby && room.roundNo === 1 ? Math.max(0, Math.ceil((room.createdAt.getTime() + roomTimeout * 1000 - now) / 1000)) : null;

  const winners = winnersOf(room);
  const breakdown = winnerBreakdown(room);

  const pending = actions.setReady.isPending || actions.leave.isPending || actions.rollDice.isPending || actions.blackjackAction.isPending;

  return (
    <div className="min-h-screen">
      <SiteNav user={user} />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <div className="space-y-4">
          {/* 房间头 */}
          <div className="rise-in flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold tracking-[0.4em] text-[#af915f]">{GAME_LABEL[game] ?? room.game} · ROOM</p>
              <h1 className="mt-1 flex items-center gap-2 text-2xl font-black text-[#fce1b6]">
                <span className="font-num tracking-[0.2em] text-[#FFB700]">{room.code}</span>
                <button
                  onClick={() => { navigator.clipboard.writeText(room.code); toast.success("房间码已复制"); }}
                  className="text-muted-foreground transition-colors hover:text-[#FFB700]"
                  aria-label="复制房间码"
                >
                  <Copy className="h-4 w-4" />
                </button>
                <span className="rounded bg-white/5 px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
                  {room.visibility === "private" ? "私密房" : "公开房"}
                </span>
                <span className="font-num rounded bg-[#FFB700]/10 px-2 py-0.5 text-[10px] font-bold text-[#FFB700]">
                  第 {room.roundNo} 局
                </span>
              </h1>
            </div>
            {inLobby && lobbyRemain !== null && (
              <p className="font-num text-xs text-muted-foreground">
                房间 {Math.floor(lobbyRemain / 60)}:{String(lobbyRemain % 60).padStart(2, "0")} 后过期
              </p>
            )}
          </div>

          {/* 奖池与赢家税公示 */}
          <div className="rise-in rise-in-1">
            <PotBreakdown
              bet={room.bet}
              playerCount={room.players.length}
              feePercent={taxPercent}
              pot={finished && room.grossPrizePool > 0 ? room.grossPrizePool : undefined}
              fee={finished ? room.winnerTax : undefined}
            />
            <p className="mt-1.5 text-center text-[10px] leading-4 text-muted-foreground">
              每人押注 {fmtMoney(room.bet)} · 全员准备后开局，开局时才从每人额度原子扣入托管 ·
              赢家税率快照锁定于房间创建时（v{room.configVersion}）
            </p>
          </div>

          <RoomStatusBanner room={room} />

          {/* 座位区 */}
          <div className="rise-in rise-in-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {room.players.map((p) => (
              <PlayerSeat key={p.userId} room={room} player={p} myUserId={user.id} />
            ))}
            {inLobby && Array.from({ length: Math.max(0, room.maxPlayers - room.players.length) }, (_, i) => <EmptySeat key={i} />)}
          </div>

          {/* 等待期操作 */}
          {inLobby && (
            <div className="rise-in rise-in-3 space-y-2">
              {me ? (
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <button
                    onClick={() => actions.setReady.mutate({ roomId, requestId: actions.rid("ready"), ready: !me.ready }, { onError: (e) => toast.error(e.message) })}
                    disabled={pending}
                    className={me.ready
                      ? "rounded-lg border border-border px-8 py-3 text-sm font-bold text-muted-foreground transition-colors hover:text-[#fce1b6]"
                      : "btn-3d rounded-lg bg-[#FFB700] px-10 py-3 font-black text-[#162638]"}
                  >
                    {me.ready ? "取消准备" : "准备"}
                  </button>
                  <button
                    onClick={() => actions.leave.mutate({ roomId, requestId: actions.rid("leave") }, { onSuccess: () => navigate("/arena"), onError: (e) => toast.error(e.message) })}
                    disabled={pending}
                    className="flex items-center gap-1.5 rounded-lg border border-border px-5 py-3 text-xs font-bold text-muted-foreground transition-colors hover:text-[#fce1b6]"
                  >
                    <LogOut className="h-3.5 w-3.5" /> {isHost ? "离开（移交房主）" : "离开房间"}
                  </button>
                </div>
              ) : (
                <p className="text-center text-xs text-muted-foreground">你是观战者；从大厅加入房间后可参与对局</p>
              )}
              <p className="mx-auto max-w-md text-center text-[10px] leading-4 text-muted-foreground">
                {room.players.length < room.minPlayers
                  ? `至少 ${room.minPlayers} 人才能开局（当前 ${room.players.length} 人）`
                  : "全员准备后自动开局；开局时原子扣除每人押注进入托管，任何人余额不足或超限则开局回滚、无人扣款"}
              </p>
            </div>
          )}

          {/* 骰子：任何在座玩家可开奖，超时系统自动开奖 */}
          {active && game === "dice" && (
            <div className="rise-in rounded-xl border border-border bg-[#101d2b] p-5 text-center">
              {me ? (
                <>
                  <button
                    onClick={() => actions.rollDice.mutate({ roomId, requestId: actions.rid("roll") }, { onError: (e) => toast.error(e.message) })}
                    disabled={pending}
                    className="btn-3d inline-flex items-center gap-2 rounded-lg bg-[#FFB700] px-10 py-3 font-black text-[#162638] disabled:opacity-40"
                  >
                    {actions.rollDice.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Dices className="h-4 w-4" />}
                    {diceTie ? "加赛开奖" : "开奖"}
                  </button>
                  <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                    任何在座玩家都可触发开奖，结果由服务端种子即时生成
                    {actionRemain !== null && <>；<span className="font-num text-[#FFB700]">{actionRemain}s</span> 后系统自动开奖</>}
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {diceTie ? "并列最高，等待加赛开奖…" : "等待开奖…"}
                  {actionRemain !== null && `（${actionRemain}s 后自动开奖）`}
                </p>
              )}
            </div>
          )}

          {/* 二十一点：暗牌并行窗口，所有人同时要牌/停牌，统一揭牌 */}
          {active && game === "blackjack" && me && (
            <div className="rise-in rounded-xl border border-border bg-[#101d2b] p-5 text-center">
              <p className="text-sm font-bold text-[#fce1b6]">
                {myTurn ? (
                  <>我的回合 · 当前 <span className="font-num text-[#FFB700]">{me.score ?? 0}</span> 点（仅自己可见）</>
                ) : (
                  <>你已完成本局操作，等待统一揭牌</>
                )}
                {actionRemain !== null && <span className="font-num ml-2 text-[#FFB700]">{actionRemain}s</span>}
              </p>
              {myTurn && (
                <div className="mt-3 flex items-center justify-center gap-3">
                  <button
                    onClick={() => actions.blackjackAction.mutate({ roomId, requestId: actions.rid("bj"), action: "hit" }, { onError: (e) => toast.error(e.message) })}
                    disabled={pending}
                    className="btn-3d rounded-lg bg-[#FFB700] px-10 py-3 font-black text-[#162638] disabled:opacity-40"
                  >
                    要牌
                  </button>
                  <button
                    onClick={() => actions.blackjackAction.mutate({ roomId, requestId: actions.rid("bj"), action: "stand" }, { onError: (e) => toast.error(e.message) })}
                    disabled={pending}
                    className="rounded-lg border border-border px-10 py-3 text-sm font-bold text-[#fce1b6] transition-colors hover:border-[#af915f]"
                  >
                    停牌
                  </button>
                </div>
              )}
              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                所有玩家在同一 60 秒窗口内并行操作，手牌与点数互相保密；爆牌、21 点或特殊牌型（双 A / 五小 / 天然黑杰克）自动完成，窗口到期未完成由系统托管停牌；全员完成后统一揭牌结算
              </p>
            </div>
          )}

          {/* 结算面板 */}
          {room.status === "settled" && breakdown && (
            <div className="rise-in rounded-xl border border-[#FFB700]/40 bg-[#FFB700]/5 p-5">
              <p className="text-center text-xs text-muted-foreground">
                {winners.length > 1 ? `并列最高 · ${winners.length} 位赢家平分税后奖池` : "赢家"}
              </p>
              <div className="mt-3 space-y-2">
                {breakdown.map(({ player, preTax, tax, net }) => (
                  <div key={player.userId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#FFB700]/20 bg-[#101d2b] px-4 py-3">
                    <p className="text-sm font-bold text-[#FFB700]">
                      {player.name ?? player.username}{player.userId === user.id && "（我）"}
                      {game === "blackjack" && player.handRank && (
                        <span className="ml-2 rounded bg-[#FFB700]/15 px-1.5 py-0.5 align-middle text-[10px] font-black text-[#FFB700]">
                          {player.handRank.label}
                        </span>
                      )}
                    </p>
                    <div className="font-num flex items-center gap-3 text-xs">
                      <span className="text-muted-foreground">税前 {fmtMoney(preTax)}</span>
                      <span className="text-[#EF5459]">赢家税 −{fmtMoney(tax)}</span>
                      <span className="text-sm font-black text-[#00B77D]">实收 +{fmtMoney(net)}</span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="mx-auto mt-3 max-w-md text-center text-xs leading-5 text-muted-foreground">
                毛奖池 {fmtMoney(room.grossPrizePool)} − 赢家税 {fmtMoney(room.winnerTax)}（{taxPercent}%，从毛奖池一次性扣除）=
                税后奖池 {fmtMoney(room.netPrizePool)}；未获胜玩家仅损失押注。
                输赢已计入额度流水，可在「控制台 → 额度流水」查看
              </p>
              {me && (
                <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
                  <button
                    onClick={() => actions.setReady.mutate({ roomId, requestId: actions.rid("ready"), ready: true }, { onError: (e) => toast.error(e.message) })}
                    disabled={pending}
                    className="btn-3d inline-flex items-center gap-2 rounded-lg bg-[#FFB700] px-8 py-2.5 text-sm font-black text-[#162638] disabled:opacity-40"
                  >
                    <RotateCcw className="h-4 w-4" /> 准备下一局
                  </button>
                  <button
                    onClick={() => actions.leave.mutate({ roomId, requestId: actions.rid("leave") }, { onSuccess: () => navigate("/arena"), onError: (e) => toast.error(e.message) })}
                    disabled={pending}
                    className="rounded-lg border border-border px-5 py-2.5 text-xs font-bold text-muted-foreground transition-colors hover:text-[#fce1b6]"
                  >
                    离开房间
                  </button>
                </div>
              )}
              <p className="mt-3 text-center text-[10px] leading-4 text-muted-foreground">
                房间保留可连续多局：全员再次准备即自动开始第 {room.roundNo + 1} 局，余额与限额开局时重新校验；所有人退出后房间自动关闭
              </p>
              <div className="mt-3 text-center">
                <Link to="/arena" className="text-xs font-bold text-[#FFB700] hover:underline">返回大厅</Link>
              </div>
            </div>
          )}

          {(room.status === "cancelled" || room.status === "refunded") && (
            <div className="rise-in rounded-xl border border-border bg-[#101d2b] p-5 text-center">
              <p className="text-sm text-muted-foreground">
                {room.status === "cancelled"
                  ? "房间已取消（超时未开局或全员离开）；本房未开局结算，无人被扣除押注。"
                  : "全员爆牌，押注已原额退款。房间仍保留，可继续下一局。"}
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
                {room.status === "refunded" && me && (
                  <button
                    onClick={() => actions.setReady.mutate({ roomId, requestId: actions.rid("ready"), ready: true }, { onError: (e) => toast.error(e.message) })}
                    disabled={pending}
                    className="btn-3d inline-flex items-center gap-2 rounded-lg bg-[#FFB700] px-8 py-2.5 text-sm font-black text-[#162638] disabled:opacity-40"
                  >
                    <RotateCcw className="h-4 w-4" /> 准备下一局
                  </button>
                )}
                <Link to="/arena" className="text-sm font-bold text-[#FFB700] hover:underline">返回大厅 →</Link>
              </div>
            </div>
          )}

          {/* 事件流水（紧凑） */}
          {room.events.length > 0 && (
            <details className="rise-in rounded-xl border border-border bg-[#101d2b] p-4 text-xs">
              <summary className="cursor-pointer font-bold text-[#af915f]">对局记录（{room.events.length}）</summary>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                {room.events.slice(-12).map((ev) => (
                  <li key={ev.id} className="flex items-baseline justify-between gap-3">
                    <EventLine ev={ev} players={room.players} />
                    <span className="font-num shrink-0 text-[10px] text-muted-foreground/60">
                      {new Date(ev.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <FairnessPanel room={room} />
        </div>
      </main>
    </div>
  );
}

const SEAT_NAME = (players: { seat: number; name: string | null; username: string }[], seat?: number) =>
  seat == null ? "系统" : players.find((p) => p.seat === seat)?.name ?? players.find((p) => p.seat === seat)?.username ?? `座位${seat}`;

/** 单条事件的人类可读描述 */
function EventLine({ ev, players }: { ev: { type: string; payload: Record<string, unknown> }; players: { seat: number; name: string | null; username: string }[] }) {
  const p = ev.payload as Record<string, unknown>;
  const name = SEAT_NAME(players, typeof p.seat === "number" ? p.seat : undefined);
  switch (ev.type) {
    case "created": return <span>{name} 创建了房间</span>;
    case "joined": return <span>{name} 加入房间{p.alreadyJoined ? "（重复加入已忽略）" : ""}</span>;
    case "ready": return <span>{name} {p.ready ? "已准备" : "取消准备"}</span>;
    case "left": return <span>{name} 离开房间</span>;
    case "owner_transferred": return <span>房主移交给 {name}</span>;
    case "next_round_prepared": return <span className="text-[#7db4ff]">第 {String(p.previousRoundNo ?? "?")} 局已归档，房间进入第 {String(p.roundNo ?? "?")} 局等待</span>;
    case "started": return <span className="text-[#7db4ff]">对局开始，押注已扣入托管</span>;
    case "turn": return <span>轮到 {name} 行动</span>;
    case "dice_rolled": return <span>第 {String(p.round ?? "?")} 轮开奖</span>;
    case "dice_auto_rolled": return <span>第 {String(p.round ?? "?")} 轮超时，系统自动开奖</span>;
    case "dice_tie": return <span className="text-[#EF54EA]">并列最高，进入加赛</span>;
    case "blackjack_action": {
      if (p.action === undefined) return <span>{name} {p.completed ? "完成操作" : "操作中"}（暗牌）</span>;
      const action = p.action === "hit" ? "要牌" : p.action === "stand" ? "停牌" : "超时托管停牌";
      return <span>{name} {action}（{String(p.score ?? "?")} 点{p.status === "busted" ? "，爆牌" : ""}）</span>;
    }
    case "blackjack_auto_stand": return <span>{name} 行动超时，系统托管停牌</span>;
    case "settled": {
      const winning = (p.winningHandRank as { label?: string } | undefined)?.label;
      return <span className="text-[#00B77D]">对局结算完成{winning ? `（${winning} 胜出）` : ""}</span>;
    }
    case "cancelled": return <span>房间取消{p.reason === "room_timeout" ? "（超时未开局）" : ""}</span>;
    case "refunded": return <span>全员爆牌，原额退款</span>;
    default: return <span>{ev.type}</span>;
  }
}
