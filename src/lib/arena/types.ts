/**
 * 幸运决斗场前端契约：直接复用后端 tRPC 推断类型 + 共享规则库 @contracts/duel。
 * 页面组件只依赖本文件与 hooks.ts，不直接关心后端实现细节。
 */
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../api/router";
import type { DiceEvaluation, DiceHand, DuelCard } from "@contracts/duel";

type RouterOut = inferRouterOutputs<AppRouter>;

export type DuelConfig = RouterOut["duel"]["config"];
export type DuelLobby = RouterOut["duel"]["lobby"];
export type DuelLobbyRoom = DuelLobby["rooms"][number];
export type DuelRoomData = RouterOut["duel"]["room"];
export type DuelPlayer = DuelRoomData["players"][number];
export type DuelEvent = DuelRoomData["events"][number];
export type DuelHistory = RouterOut["duel"]["history"];
export type DuelHistoryRow = DuelHistory["rows"][number];

/** 房间状态：lobby 等待 → active 对局 → settled/cancelled/refunded 终态 */
export type DuelStatus = DuelRoomData["status"];
export const FINAL_STATUSES: readonly DuelStatus[] = ["settled", "cancelled", "refunded"];

export type DuelGame = "dice" | "blackjack";
export const GAME_LABEL: Record<DuelGame, string> = { dice: "幸运骰子", blackjack: "二十一点" };

/** 骰子局状态（完全公开） */
export interface DicePublicState {
  kind: "dice";
  contenderSeats: number[];
  rounds: {
    round: number;
    rolls: { seat: number; dice: DiceHand; evaluation: DiceEvaluation }[];
    contenderSeats: number[];
  }[];
}

/** 二十一点局状态（终态前他人手牌为 null 占位，仅自己可见；他人动作只暴露是否完成） */
export interface BjPublicState {
  kind: "blackjack";
  cursor: number;
  hands: Record<string, (DuelCard | null)[]>;
  actions: { seat: number; action?: "hit" | "stand" | "auto_stand"; card?: DuelCard; score?: number; at: number; completed?: boolean }[];
}

export type DuelPublicState = DicePublicState | BjPublicState;

export function roomState(room: DuelRoomData): DuelPublicState | null {
  const s = room.state as DuelPublicState | null;
  return s && typeof s === "object" && "kind" in s ? s : null;
}

/** 玩家状态 → 展示文案 */
export const PLAYER_STATUS_LABEL: Record<string, string> = {
  joined: "已入座",
  active: "对局中",
  acting: "操作中",
  completed: "已完成",
  stood: "已停牌",
  busted: "爆牌",
  winner: "赢家",
  lost: "未获胜",
  refunded: "已退款",
  voided: "已作废",
};

/** 房间码规则（与后端一致）：6 位大写字母数字（去除易混淆字符） */
export const ROOM_CODE_PATTERN = /^[A-Z2-9]{6}$/;

/**
 * 二十一点牌型（handRank）的展示闸门：只在全桌统一揭牌后显示。
 * 即使本人已停牌、爆牌或提前完成，操作阶段仍不得提前看到牌型，
 * 避免通过座位状态或牌型徽章推断暗牌结果。
 */
export function handRankVisible(room: DuelRoomData, player: DuelPlayer): boolean {
  return room.game === "blackjack"
    && !!player.handRank
    && (room.status === "settled" || room.status === "refunded");
}
