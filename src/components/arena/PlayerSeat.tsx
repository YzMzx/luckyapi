import { Crown } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { DiceHand, DuelCard } from "@contracts/duel";
import { PLAYER_STATUS_LABEL, handRankVisible, type DuelPlayer, type DuelRoomData } from "@/lib/arena/types";
import { fmtMoney } from "@/lib/arena/hooks";
import { DiceTrio } from "./Dice";
import { PlayingCard } from "./PlayingCard";

/**
 * 座位卡：等待期显示准备状态；
 * 骰子局显示最新一轮组合；二十一点显示手牌（他人暗牌）与点数；结算后显示净输赢。
 */
export function PlayerSeat({
  room,
  player,
  myUserId,
}: {
  room: DuelRoomData;
  player: DuelPlayer;
  myUserId: number;
}) {
  const isMe = player.userId === myUserId;
  const isWinner = player.status === "winner";
  // 暗牌并行制：只有本人且仍处于 active 时才高亮为行动中；对手只暴露 acting/completed
  const isTurn = room.status === "active" && room.game === "blackjack" && isMe && player.status === "active";
  const inLobby = room.status === "lobby";
  const finished = room.status === "settled" || room.status === "cancelled" || room.status === "refunded";

  // 骰子：从最新一轮取该座位结果
  const diceRoll = (() => {
    if (room.game !== "dice") return null;
    const state = room.state as { kind: string; rounds?: { rolls: { seat: number; dice: DiceHand; evaluation: { label: string } }[] }[] } | null;
    const round = state && "rounds" in state ? state.rounds?.[state.rounds.length - 1] : undefined;
    return round?.rolls.find((r) => r.seat === player.seat) ?? null;
  })();

  // 二十一点：手牌（他人为 null 暗牌）
  const cards = (() => {
    if (room.game !== "blackjack") return null;
    if (Array.isArray(player.hand)) return player.hand as (DuelCard | null)[];
    const state = room.state as { kind: string; hands?: Record<string, (DuelCard | null)[]> } | null;
    return state && "hands" in state ? state.hands?.[String(player.seat)] ?? null : null;
  })();

  const net = player.settledNet;

  return (
    <div
      className={cn(
        "rounded-xl border p-3 transition-colors",
        isWinner
          ? "border-[#FFB700] bg-[#FFB700]/10 shadow-[0_0_18px_#FFB70033]"
          : isTurn
            ? "border-[#176EFF] bg-[#176EFF]/10"
            : isMe
              ? "border-[#af915f]/60 bg-[#162638]"
              : "border-border bg-[#101d2b]",
      )}
    >
      <div className="flex items-center gap-2">
        <Avatar className="h-8 w-8 shrink-0 border border-[#af915f]/40">
          {player.avatarUrl && <AvatarImage src={player.avatarUrl} />}
          <AvatarFallback className="bg-[#1d3145] text-xs text-[#fce1b6]">
            {(player.name ?? player.username ?? "?").slice(0, 1)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 truncate text-sm font-bold text-[#fce1b6]">
            {player.name ?? player.username}
            {player.isHost && <Crown className="h-3.5 w-3.5 shrink-0 text-[#FFB700]" aria-label="房主" />}
            {isMe && <span className="shrink-0 rounded bg-[#176EFF]/15 px-1 text-[10px] text-[#7db4ff]">我</span>}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {inLobby
              ? player.ready ? "已准备" : "未准备"
              : isTurn ? "行动中…" : PLAYER_STATUS_LABEL[player.status] ?? player.status}
          </p>
        </div>
        {inLobby && (
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold",
              player.ready ? "bg-[#00B77D]/15 text-[#00B77D]" : "bg-white/5 text-muted-foreground",
            )}
          >
            {player.ready ? "READY" : "等待"}
          </span>
        )}
        {room.status === "active" && room.game === "blackjack" && (
          <span className="font-num shrink-0 text-sm font-black text-[#fce1b6]">
            {player.status === "busted" ? "爆" : player.score ?? "—"}
          </span>
        )}
      </div>

      {/* 骰子结果 */}
      {room.game === "dice" && !inLobby && (
        <div className="mt-2.5 flex items-center justify-between gap-2">
          <DiceTrio dice={diceRoll ? [...diceRoll.dice] as [number, number, number] : null} size="sm" />
          {diceRoll && <p className="text-xs font-bold text-[#FFB700]">{diceRoll.evaluation.label}</p>}
        </div>
      )}

      {/* 二十一点手牌 */}
      {room.game === "blackjack" && !inLobby && cards && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {cards.map((c, i) => <PlayingCard key={i} card={c} size="sm" />)}
        </div>
      )}

      {/* 二十一点牌型：严格只在手牌完结（停牌/爆牌/结算）或房间终态揭牌后显示 */}
      {room.game === "blackjack" && !inLobby && handRankVisible(room, player) && player.handRank && (
        <p
          className={cn(
            "mt-2 inline-block rounded px-1.5 py-0.5 text-[10px] font-black",
            player.handRank.busted
              ? "bg-[#EF5459]/15 text-[#EF5459]"
              : player.handRank.isSpecial
                ? "bg-[#FFB700]/15 text-[#FFB700]"
                : "bg-white/5 text-muted-foreground",
          )}
          title={`规则 ${player.handRank.ruleVersion} · ${player.handRank.cardCount} 张牌`}
        >
          {player.handRank.label}
        </p>
      )}

      {/* 结算净输赢 */}
      {finished && room.status !== "cancelled" && (
        <p className={cn("font-num mt-2 text-right text-xs font-bold", net > 0 ? "text-[#00B77D]" : net < 0 ? "text-[#EF5459]" : "text-muted-foreground")}>
          {net > 0 ? `+${fmtMoney(net)}` : net < 0 ? `-${fmtMoney(-net)}` : "±$0.00"}
        </p>
      )}
    </div>
  );
}

/** 空座位占位 */
export function EmptySeat() {
  return (
    <div className="flex items-center justify-center rounded-xl border border-dashed border-border/70 p-3 text-xs text-muted-foreground/60">
      等待玩家加入
    </div>
  );
}
