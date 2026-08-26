/**
 * 决斗场数据访问层（typed adapter）：所有 duel 接口的 hooks 与派生计算集中在这里。
 * requestId 幂等模式：同一动作重试复用同一 UUID，成功后才更换。
 */
import { useEffect, useRef, useState } from "react";
import { trpc } from "@/providers/trpc";
import { type DuelPlayer, type DuelRoomData } from "./types";
import { requestBalanceRefresh } from "@/lib/balance-sync";

export function useDuelConfig(enabled = true) {
  return trpc.duel.config.useQuery(undefined, { enabled });
}

export function useDuelLobby(enabled = true) {
  return trpc.duel.lobby.useQuery(undefined, { enabled, refetchInterval: 5000 });
}

/** 房间快照：等待/对局每 2s 轮询；已结算/已退款房间可开启下一局，4s 慢轮询；取消后停止 */
export function useDuelRoom(roomId: string, enabled = true) {
  const query = trpc.duel.room.useQuery(
    { roomId },
    {
      enabled: enabled && !!roomId,
      refetchInterval: (query) => {
        const room = query.state.data;
        if (!room) return 2000;
        if (room.status === "cancelled") return false;
        if (room.status === "settled" || room.status === "refunded") return 4000;
        return 2000;
      },
    },
  );
  const balanceMarker = useRef("");
  useEffect(() => {
    const room = query.data;
    if (!room) return;
    const balanceRelevant = room.status === "active" || room.status === "settled" || room.status === "refunded";
    if (!balanceRelevant) return;
    const marker = `${room.id}:${room.roundNo}:${room.status}`;
    if (balanceMarker.current === marker) return;
    balanceMarker.current = marker;
    requestBalanceRefresh();
  }, [query.data]);
  return query;
}

export function useDuelHistory(page: number, enabled = true) {
  return trpc.duel.history.useQuery({ page }, { enabled });
}

/** 每个动作一个稳定 requestId：onMutate 时生成，成功后重置 */
export function useArenaActions(roomId: string) {
  const utils = trpc.useUtils();
  const ids = useRef<Record<string, string>>({});
  const rid = (key: string) => (ids.current[key] ??= crypto.randomUUID());
  const done = (key: string) => { delete ids.current[key]; utils.duel.room.invalidate({ roomId }); utils.duel.lobby.invalidate(); };

  const opts = (key: string) => ({
    onSuccess: () => done(key),
  });

  return {
    join: trpc.duel.join.useMutation(opts("join")),
    setReady: trpc.duel.setReady.useMutation(opts("ready")),
    leave: trpc.duel.leave.useMutation(opts("leave")),
    rollDice: trpc.duel.rollDice.useMutation(opts("roll")),
    blackjackAction: trpc.duel.blackjackAction.useMutation(opts("bj")),
    rid,
  };
}

/* ---------- 派生计算（展示层） ---------- */

export const winnersOf = (room: DuelRoomData) => room.players.filter((p) => p.status === "winner");
export const playerNet = (p: DuelPlayer) => p.settledNet ?? (p.payout - p.stake);

/** 赢家税前份额 = 毛奖池 / 赢家数；赢家税 = 税前份额 − 实收（税从毛奖池一次性扣除后平分） */
export function winnerBreakdown(room: DuelRoomData) {
  const winners = winnersOf(room);
  if (!winners.length) return null;
  const gross = room.grossPrizePool ?? room.pot;
  const grossShare = gross / winners.length;
  return winners.map((p) => ({
    player: p,
    preTax: grossShare,
    tax: Math.max(0, grossShare - p.payout),
    net: p.payout,
  }));
}

/** 二十一点并行窗口内我是否还能行动（暗牌并行制，无轮流概念） */
export const canActBlackjack = (room: DuelRoomData, me: DuelPlayer | undefined) =>
  room.status === "active" && room.game === "blackjack" && me?.status === "active";

/** 每秒 tick 的当前时间，用于倒计时 */
export function useNow(active = true, intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
}

export const fmtMoney = (n: number) => `$${Number(n).toFixed(2)}`;
export const fmtMoney4 = (n: number) => `$${Number(n).toFixed(4)}`;
