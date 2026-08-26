import { randomInt, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { createRouter } from "../middleware";
import { memberQuery } from "../auth";
import { getDb } from "../queries/connection";
import { assertModuleAvailable } from "../queries/policies";
import { recordTx } from "../queries/ledger";
import { debitUserBalance, reverseUserBalanceDebit } from "../queries/credit-grants";
import {
  duelConfigs,
  duelEvents,
  duelFund,
  duelLedger,
  duelPlayers,
  duelRoundResults,
  duelRooms,
  users,
} from "../../db/schema";
import {
  BLACKJACK_PVP_RULES,
  compareBlackjackHands,
  duelAmountHasPrecision,
  duelLeaderboardPeriodBounds,
  duelDollarsToUnits,
  duelUnitsToDollars,
  evaluateBlackjackHand,
  splitDuelPot,
  type BlackjackHandEvaluation,
  type DuelCard,
} from "@contracts/duel";
import {
  blackjackSeatScore,
  deterministicDiceRound,
  drawBlackjackCard,
  duelSeedCommitment,
  initialBlackjackState,
  newDuelSeed,
  type BlackjackRoomState,
  type DiceRoomState,
  type DuelRoomState,
} from "../queries/duel-engine";

type Db = ReturnType<typeof getDb>;
type DuelTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const REQUEST_ID = z.string().uuid();
const ROOM_ID = z.string().uuid();
const ROOM_CODE = z.string().trim().toUpperCase().regex(/^[A-Z2-9]{6}$/);
const FINAL_ROOM_STATUSES = ["settled", "cancelled", "refunded"] as const;
const REUSABLE_ROOM_STATUSES = ["lobby", "active", "settled", "refunded"] as const;
const BLACKJACK_ACTION_WINDOW_MS = 60_000;

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function parseBlackjackEvaluation(raw: string, hand: readonly DuelCard[]): BlackjackHandEvaluation {
  const parsed = parseJson<Partial<BlackjackHandEvaluation>>(raw, {});
  return typeof parsed.category === "string" && typeof parsed.categoryRank === "number"
    ? parsed as BlackjackHandEvaluation
    : evaluateBlackjackHand(hand);
}

function publicAvatarUrl(value: string | null): string | null {
  if (!value) return null;
  if (value.startsWith("/")) return value;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

function activeConfig(tx: DuelTx) {
  const config = tx.select().from(duelConfigs).where(eq(duelConfigs.active, true)).orderBy(desc(duelConfigs.version)).limit(1).get();
  if (!config) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "决斗场尚未配置" });
  return config;
}

function configSnapshot(config: typeof duelConfigs.$inferSelect) {
  return {
    enabled: config.enabled,
    diceEnabled: config.diceEnabled,
    blackjackEnabled: config.blackjackEnabled,
    winnerTaxBasisPoints: config.winnerTaxBasisPoints,
    feeBasisPoints: config.winnerTaxBasisPoints,
    betOptionsUnits: parseJson<number[]>(config.betOptionsJson, []),
    minBetUnits: config.minBetUnits,
    maxBetUnits: config.maxBetUnits,
    betPrecision: config.betPrecision,
    minPlayers: config.minPlayers,
    maxPlayers: config.maxPlayers,
    roomTimeoutSeconds: config.roomTimeoutSeconds,
    actionTimeoutSeconds: config.actionTimeoutSeconds,
    blackjackActionWindowSeconds: BLACKJACK_ACTION_WINDOW_MS / 1000,
    blackjackRules: BLACKJACK_PVP_RULES,
    singleBetLimitUnits: config.singleBetLimitUnits,
    dailyStakeLimitUnits: config.dailyStakeLimitUnits,
    dailyNetLossLimitUnits: config.dailyNetLossLimitUnits,
  };
}

function appendEvent(
  tx: DuelTx,
  roomId: string,
  type: string,
  payload: unknown,
  userId: number | null = null,
  requestId: string | null = null,
) {
  const latest = tx.select({ seq: sql<number>`COALESCE(MAX(${duelEvents.seq}), 0)` }).from(duelEvents).where(eq(duelEvents.roomId, roomId)).get();
  const roundNo = tx.select({ roundNo: duelRooms.roundNo }).from(duelRooms).where(eq(duelRooms.id, roomId)).limit(1).get()?.roundNo ?? 1;
  const body = payload && typeof payload === "object" && !Array.isArray(payload)
    ? { roundNo, ...payload as Record<string, unknown> }
    : { roundNo, value: payload };
  tx.insert(duelEvents).values({
    roomId,
    seq: Number(latest?.seq ?? 0) + 1,
    type,
    userId,
    requestId,
    payloadJson: JSON.stringify(body),
  }).run();
}

function idempotentRoom(tx: DuelTx, requestId: string, userId: number, expectedType: string) {
  const event = tx.select().from(duelEvents).where(eq(duelEvents.requestId, requestId)).limit(1).get();
  if (!event) return null;
  if (event.userId !== userId || event.type !== expectedType) {
    throw new TRPCError({ code: "CONFLICT", message: "请求编号已用于其他决斗操作" });
  }
  return event.roomId;
}

function roomOrThrow(tx: DuelTx, roomId: string) {
  const room = tx.select().from(duelRooms).where(eq(duelRooms.id, roomId)).limit(1).get();
  if (!room) throw new TRPCError({ code: "NOT_FOUND", message: "房间不存在" });
  return room;
}

function lobbyExpired(room: typeof duelRooms.$inferSelect) {
  if (room.status !== "lobby") return false;
  if (room.roundNo > 1) return false;
  const snapshot = parseJson<{ roomTimeoutSeconds: number }>(room.configSnapshotJson, { roomTimeoutSeconds: 1800 });
  return room.createdAt.getTime() + snapshot.roomTimeoutSeconds * 1000 <= Date.now();
}

function voidLobbyPlayers(tx: DuelTx, roomId: string, at = new Date()) {
  tx.update(duelPlayers).set({ status: "voided", result: "void", settledNetUnits: 0, voidedAt: at, updatedAt: at })
    .where(eq(duelPlayers.roomId, roomId)).run();
}

function playerRows(tx: DuelTx, roomId: string) {
  return tx.select({
    id: duelPlayers.id,
    roomId: duelPlayers.roomId,
    userId: duelPlayers.userId,
    gameType: duelPlayers.gameType,
    seat: duelPlayers.seat,
    ready: duelPlayers.ready,
    status: duelPlayers.status,
    balanceBeforeUnits: duelPlayers.balanceBeforeUnits,
    stakeUnits: duelPlayers.stakeUnits,
    payoutUnits: duelPlayers.payoutUnits,
    settledNetUnits: duelPlayers.settledNetUnits,
    result: duelPlayers.result,
    handJson: duelPlayers.handJson,
    handRankJson: duelPlayers.handRankJson,
    score: duelPlayers.score,
    joinedAt: duelPlayers.joinedAt,
    updatedAt: duelPlayers.updatedAt,
    settledAt: duelPlayers.settledAt,
    voidedAt: duelPlayers.voidedAt,
    name: users.groupName,
    username: users.username,
    avatarUrl: users.avatarUrl,
  }).from(duelPlayers).innerJoin(users, eq(duelPlayers.userId, users.id))
    .where(eq(duelPlayers.roomId, roomId)).orderBy(asc(duelPlayers.seat)).all();
}

function roomView(tx: DuelTx, roomId: string, viewerId: number, admin = false) {
  const room = roomOrThrow(tx, roomId);
  const players = playerRows(tx, roomId);
  const viewer = players.find((player) => player.userId === viewerId);
  const state = parseJson<DuelRoomState | Record<string, never>>(room.stateJson, {});
  let publicState: unknown = state;
  if (state && "kind" in state && state.kind === "blackjack" && !admin && !FINAL_ROOM_STATUSES.includes(room.status as typeof FINAL_ROOM_STATUSES[number])) {
    const blackjack = state as BlackjackRoomState;
    const viewerSeat = viewer?.seat;
    publicState = {
      kind: "blackjack",
      hands: Object.fromEntries(Object.entries(blackjack.hands).map(([seat, cards]) => [
        seat,
        Number(seat) === viewerSeat ? cards : cards.map(() => null),
      ])),
      actions: blackjack.actions.map((action) => action.seat === viewerSeat
        ? action
        : { seat: action.seat, at: action.at, completed: true }),
    };
  }
  const events = tx.select().from(duelEvents).where(eq(duelEvents.roomId, roomId)).orderBy(desc(duelEvents.seq)).limit(100).all().reverse();
  return {
    ...room,
    stateJson: undefined,
    bet: duelUnitsToDollars(room.betUnits),
    pot: duelUnitsToDollars(room.potUnits),
    fee: duelUnitsToDollars(room.feeUnits),
    winnerTaxPercent: room.winnerTaxBasisPoints / 100,
    grossPrizePool: duelUnitsToDollars(room.grossPrizePoolUnits),
    winnerTax: duelUnitsToDollars(room.winnerTaxUnits),
    netPrizePool: duelUnitsToDollars(room.netPrizePoolUnits),
    state: publicState,
    seedSecret: undefined,
    seedReveal: FINAL_ROOM_STATUSES.includes(room.status as typeof FINAL_ROOM_STATUSES[number]) ? room.seedReveal : null,
    players: players.map(({ handJson, handRankJson, ...player }) => {
      const concealedOpponent = room.game === "blackjack"
        && room.status === "active"
        && player.userId !== viewerId;
      const hand = parseJson<DuelCard[]>(handJson, []);
      const handRank = room.game === "blackjack"
        ? parseBlackjackEvaluation(handRankJson, hand)
        : null;
      return {
        ...player,
        status: concealedOpponent ? (player.status === "active" ? "acting" : "completed") : player.status,
        score: concealedOpponent ? null : player.score,
        result: concealedOpponent ? "pending" : player.result,
        handRank: concealedOpponent ? null : handRank,
        isHost: player.userId === room.ownerId,
        balanceBefore: player.balanceBeforeUnits == null ? null : duelUnitsToDollars(player.balanceBeforeUnits),
        stake: duelUnitsToDollars(player.stakeUnits),
        payout: duelUnitsToDollars(player.payoutUnits),
        settledNet: duelUnitsToDollars(player.settledNetUnits),
        hand: player.userId === viewerId || FINAL_ROOM_STATUSES.includes(room.status as typeof FINAL_ROOM_STATUSES[number])
          ? hand
          : null,
      };
    }),
    events: events.map(({ payloadJson, ...event }) => {
      const payload = parseJson<Record<string, unknown>>(payloadJson, {});
      if (room.status === "active" && room.game === "blackjack" && event.type === "blackjack_action" && event.userId !== viewerId) {
        return {
          ...event,
          payload: { roundNo: payload.roundNo, seat: payload.seat, completed: payload.status !== "active" },
        };
      }
      return { ...event, payload };
    }),
    fairness: {
      algorithm: "SHA-256 counter stream + rejection sampling; Fisher-Yates for cards",
      commitment: room.seedHash,
      reveal: FINAL_ROOM_STATUSES.includes(room.status as typeof FINAL_ROOM_STATUSES[number]) ? room.seedReveal : null,
      commitmentContext: `${room.id}|${room.game}|${room.roundNo}`,
      randomContext: `${room.id}|${room.game}|${room.roundNo}|game-step`,
      blackjackRule: room.game === "blackjack" ? BLACKJACK_PVP_RULES : null,
    },
  };
}

function userBalanceUnits(tx: DuelTx, userId: number) {
  const row = tx.select({ balance: users.balance }).from(users).where(eq(users.id, userId)).limit(1).get();
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "用户不存在" });
  return duelDollarsToUnits(Number(row.balance));
}

function writeUserMoney(tx: DuelTx, roomId: string, userId: number, units: number, type: string, requestId: string | null, note: string) {
  if (!units) return;
  if (units < 0) debitUserBalance(tx, { userId, amount: duelUnitsToDollars(-units), sourceKind: "duel", requestId, note });
  else tx.update(users).set({ balance: sql`${users.balance} + ${duelUnitsToDollars(units)}` }).where(eq(users.id, userId)).run();
  recordTx(tx, userId, "duel", duelUnitsToDollars(units), note);
  const after = userBalanceUnits(tx, userId);
  tx.insert(duelLedger).values({ roomId, userId, requestId, type, amountUnits: units, userBalanceAfterUnits: after, note }).run();
}

function stakeDebitRequestId(roomId: string, roundNo: number, userId: number) {
  return `duel:${roomId}:${roundNo}:${userId}:stake`;
}

function refundEscrowedStake(tx: DuelTx, room: typeof duelRooms.$inferSelect, player: typeof duelPlayers.$inferSelect, now: Date) {
  const debitRequestId = stakeDebitRequestId(room.id, room.roundNo, player.userId);
  const reversal = reverseUserBalanceDebit(tx, {
    userId: player.userId,
    amount: duelUnitsToDollars(player.stakeUnits),
    sourceKind: "duel",
    requestId: debitRequestId,
    note: `决斗房 ${room.code} 全员爆牌退款恢复原额度来源`,
    now,
  });
  const creditedUnits = duelDollarsToUnits(reversal.credited);
  const expiredUnits = duelDollarsToUnits(reversal.expiredTemporary);
  if (creditedUnits > 0) recordTx(tx, player.userId, "duel", reversal.credited, `决斗房 ${room.code} 全员爆牌退款`);
  tx.insert(duelLedger).values({
    roomId: room.id,
    userId: player.userId,
    requestId: debitRequestId,
    type: "refund",
    amountUnits: creditedUnits,
    userBalanceAfterUnits: userBalanceUnits(tx, player.userId),
    note: expiredUnits > 0 ? `决斗房 ${room.code} 退款；${duelUnitsToDollars(expiredUnits)} 已过期临时额度不返还` : `决斗房 ${room.code} 全员爆牌退款`,
  }).run();
  return { creditedUnits, expiredUnits };
}

function archiveCurrentRound(tx: DuelTx, roomId: string) {
  const room = roomOrThrow(tx, roomId);
  const settledAt = room.finishedAt ?? new Date();
  for (const player of playerRows(tx, roomId)) {
    tx.insert(duelRoundResults).values({
      roomId,
      roundNo: room.roundNo,
      userId: player.userId,
      gameType: room.game,
      seat: player.seat,
      status: player.status,
      result: player.result,
      balanceBeforeUnits: player.balanceBeforeUnits,
      stakeUnits: player.stakeUnits,
      payoutUnits: player.payoutUnits,
      settledNetUnits: player.settledNetUnits,
      handJson: player.handJson,
      handRankJson: player.handRankJson,
      score: player.score,
      betUnits: room.betUnits,
      potUnits: room.potUnits,
      winnerTaxBasisPoints: room.winnerTaxBasisPoints,
      grossPrizePoolUnits: room.grossPrizePoolUnits,
      winnerTaxUnits: room.winnerTaxUnits,
      netPrizePoolUnits: room.netPrizePoolUnits,
      seedHash: room.seedHash,
      seedReveal: room.seedReveal,
      startedAt: room.startedAt,
      settledAt,
    }).onConflictDoNothing().run();
  }
}

function backfillLegacyRoundResults(tx: DuelTx) {
  tx.run(sql`
    INSERT OR IGNORE INTO duel_round_results (
      room_id, round_no, user_id, game_type, seat, status, result,
      balance_before_units, stake_units, payout_units, settled_net_units, hand_json, hand_rank_json, score,
      bet_units, pot_units, winner_tax_basis_points, gross_prize_pool_units,
      winner_tax_units, net_prize_pool_units, seed_hash, seed_reveal, started_at, settled_at
    )
    SELECT
      p.room_id, r.round_no, p.user_id, p.game_type, p.seat, p.status, p.result,
      p.balance_before_units, p.stake_units, p.payout_units, p.settled_net_units, p.hand_json, p.hand_rank_json, p.score,
      r.bet_units, r.pot_units, r.winner_tax_basis_points, r.gross_prize_pool_units,
      r.winner_tax_units, r.net_prize_pool_units, r.seed_hash, r.seed_reveal, r.started_at,
      COALESCE(p.settled_at, r.finished_at, r.created_at)
    FROM duel_players p
    INNER JOIN duel_rooms r ON r.id = p.room_id
    WHERE r.status IN ('settled', 'refunded') AND r.voided_at IS NULL AND p.result IN ('win', 'loss', 'refund')
  `);
}

function settleRoom(
  tx: DuelTx,
  roomId: string,
  winnerSeats: readonly number[],
  reason: string,
  settlementDetails: Record<string, unknown> = {},
) {
  const room = roomOrThrow(tx, roomId);
  if (FINAL_ROOM_STATUSES.includes(room.status as typeof FINAL_ROOM_STATUSES[number])) return;
  const players = playerRows(tx, roomId);
  if (!winnerSeats.length) {
    const now = new Date();
    let refundedUnits = 0;
    let expiredUnits = 0;
    for (const player of players) {
      const refund = refundEscrowedStake(tx, room, player, now);
      refundedUnits += refund.creditedUnits;
      expiredUnits += refund.expiredUnits;
      tx.update(duelPlayers).set({ ready: false, payoutUnits: refund.creditedUnits, settledNetUnits: refund.creditedUnits - player.stakeUnits, result: "refund", status: "refunded", updatedAt: now, settledAt: now, voidedAt: now }).where(eq(duelPlayers.id, player.id)).run();
    }
    if (expiredUnits > 0) {
      tx.update(duelFund).set({ balanceUnits: sql`${duelFund.balanceUnits} + ${expiredUnits}`, updatedAt: now }).where(eq(duelFund.id, 1)).run();
      const fund = tx.select().from(duelFund).where(eq(duelFund.id, 1)).get();
      tx.insert(duelLedger).values({ roomId, type: "expired_credit_forfeit", amountUnits: expiredUnits, fundBalanceAfterUnits: fund?.balanceUnits ?? expiredUnits, note: `决斗房 ${room.code} 退款时临时额度已到期清退` }).run();
    }
    tx.update(duelRooms).set({ status: "refunded", grossPrizePoolUnits: room.potUnits, winnerTaxUnits: 0, netPrizePoolUnits: refundedUnits, feeUnits: expiredUnits, seedReveal: room.seedSecret, finishedAt: now, currentSeat: null, actionDeadlineAt: null }).where(eq(duelRooms.id, roomId)).run();
    archiveCurrentRound(tx, roomId);
    appendEvent(tx, roomId, "refunded", {
      reason,
      grossPrizePoolUnits: room.potUnits,
      winnerTaxBasisPoints: room.winnerTaxBasisPoints,
      winnerTaxUnits: 0,
      netPrizePoolUnits: refundedUnits,
      expiredCreditUnits: expiredUnits,
      payouts: playerRows(tx, roomId).map((player) => ({ seat: player.seat, units: player.payoutUnits })),
      ...settlementDetails,
    });
    return;
  }

  const split = splitDuelPot(room.potUnits, room.winnerTaxBasisPoints, winnerSeats);
  for (const player of players) {
    const payout = split.payouts.get(player.seat) ?? 0;
    const winner = winnerSeats.includes(player.seat);
    if (payout > 0) writeUserMoney(tx, roomId, player.userId, payout, "payout", null, `决斗房 ${room.code} 结算入账`);
    else if (winner) tx.insert(duelLedger).values({ roomId, userId: player.userId, type: "payout", amountUnits: 0, userBalanceAfterUnits: userBalanceUnits(tx, player.userId), note: `决斗房 ${room.code} 结算入账（平台费后为 0）` }).run();
    tx.update(duelPlayers).set({
      ready: false,
      payoutUnits: payout,
      settledNetUnits: payout - player.stakeUnits,
      result: winner ? "win" : "loss",
      status: winner ? "winner" : "lost",
      updatedAt: new Date(),
      settledAt: new Date(),
      voidedAt: null,
    }).where(eq(duelPlayers.id, player.id)).run();
  }
  if (split.feeUnits > 0) {
    tx.update(duelFund).set({ balanceUnits: sql`${duelFund.balanceUnits} + ${split.feeUnits}`, updatedAt: new Date() }).where(eq(duelFund.id, 1)).run();
    const fund = tx.select().from(duelFund).where(eq(duelFund.id, 1)).get();
    tx.insert(duelLedger).values({ roomId, type: "winner_tax", amountUnits: split.feeUnits, fundBalanceAfterUnits: fund?.balanceUnits ?? split.feeUnits, note: `决斗房 ${room.code} 赢家税（从毛奖池一次扣除）` }).run();
  }
  tx.update(duelRooms).set({
    status: "settled",
    grossPrizePoolUnits: room.potUnits,
    winnerTaxUnits: split.feeUnits,
    netPrizePoolUnits: split.distributableUnits,
    feeUnits: split.feeUnits,
    seedReveal: room.seedSecret,
    finishedAt: new Date(),
    currentSeat: null,
    actionDeadlineAt: null,
  }).where(eq(duelRooms.id, roomId)).run();
  archiveCurrentRound(tx, roomId);
  appendEvent(tx, roomId, "settled", {
    reason,
    winnerSeats: [...winnerSeats],
    potUnits: room.potUnits,
    feeUnits: split.feeUnits,
    grossPrizePoolUnits: room.potUnits,
    winnerTaxBasisPoints: room.winnerTaxBasisPoints,
    winnerTaxUnits: split.feeUnits,
    netPrizePoolUnits: split.distributableUnits,
    payouts: [...split.payouts.entries()].map(([seat, units]) => ({ seat, units })),
    seedReveal: room.seedSecret,
    ...settlementDetails,
  });
}

function settleBlackjackIfComplete(tx: DuelTx, roomId: string) {
  const players = playerRows(tx, roomId);
  if (players.some((player) => player.status === "active")) return false;
  const room = roomOrThrow(tx, roomId);
  const state = parseJson<BlackjackRoomState>(room.stateJson, { kind: "blackjack", deck: [], cursor: 0, hands: {}, actions: [] });
  state.evaluations ??= {};
  const ranked = players.map((player) => {
    const hand = parseJson<DuelCard[]>(player.handJson, []);
    const evaluation = evaluateBlackjackHand(hand);
    state.evaluations![String(player.seat)] = evaluation;
    tx.update(duelPlayers).set({ handRankJson: JSON.stringify(evaluation), score: evaluation.score }).where(eq(duelPlayers.id, player.id)).run();
    return { seat: player.seat, hand, evaluation };
  });
  state.ruleVersion = BLACKJACK_PVP_RULES.version;
  tx.update(duelRooms).set({ stateJson: JSON.stringify(state) }).where(eq(duelRooms.id, roomId)).run();
  const eligible = ranked.filter((row) => !row.evaluation.busted);
  const settlementSnapshot = {
    blackjackRule: BLACKJACK_PVP_RULES,
    handRanks: ranked.map(({ seat, hand, evaluation }) => ({ seat, hand, evaluation })),
  };
  if (!eligible.length) settleRoom(tx, roomId, [], "all_busted", settlementSnapshot);
  else {
    const best = eligible.reduce((current, row) => compareBlackjackHands(row.evaluation, current.evaluation) > 0 ? row : current);
    const winners = eligible.filter((row) => compareBlackjackHands(row.evaluation, best.evaluation) === 0);
    settleRoom(tx, roomId, winners.map((row) => row.seat), `blackjack_${best.evaluation.category}`, {
      ...settlementSnapshot,
      winningHandRank: best.evaluation,
    });
  }
  return true;
}

function processTimeouts(tx: DuelTx, roomId: string) {
  const room = roomOrThrow(tx, roomId);
  if (room.status !== "active" || room.game !== "blackjack" || !room.actionDeadlineAt || room.actionDeadlineAt.getTime() > Date.now()) return;
  const activePlayers = playerRows(tx, roomId).filter((player) => player.status === "active");
  if (!activePlayers.length) return void settleBlackjackIfComplete(tx, roomId);
  const state = parseJson<BlackjackRoomState>(room.stateJson, { kind: "blackjack", deck: [], cursor: 0, hands: {}, actions: [] });
  const now = new Date();
  for (const player of activePlayers) {
    tx.update(duelPlayers).set({ status: "stood", updatedAt: now }).where(eq(duelPlayers.id, player.id)).run();
    state.actions.push({ seat: player.seat, action: "auto_stand", score: player.score ?? 0, at: now.getTime() });
    appendEvent(tx, roomId, "blackjack_auto_stand", { seat: player.seat, completed: true, reason: "global_action_timeout" });
  }
  tx.update(duelRooms).set({ stateJson: JSON.stringify(state), nonce: room.nonce + 1 }).where(eq(duelRooms.id, roomId)).run();
  settleBlackjackIfComplete(tx, roomId);
}

function executeDiceRound(tx: DuelTx, roomId: string, userId: number | null, requestId: string | null, automatic = false) {
  const room = roomOrThrow(tx, roomId);
  if (room.game !== "dice" || room.status !== "active" || !room.seedSecret) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "骰子局当前不能开奖" });
  const state = parseJson<DiceRoomState>(room.stateJson, { kind: "dice", contenderSeats: [], rounds: [] });
  const tieRound = state.rounds.length + 1;
  const result = deterministicDiceRound(room.seedSecret, room.id, room.roundNo * 100 + tieRound, state.contenderSeats);
  result.round = tieRound;
  state.rounds.push(result);
  state.contenderSeats = result.contenderSeats;
  for (const roll of result.rolls) {
    tx.update(duelPlayers).set({ handJson: JSON.stringify(roll.dice), score: roll.evaluation.categoryRank, updatedAt: new Date() })
      .where(and(eq(duelPlayers.roomId, room.id), eq(duelPlayers.seat, roll.seat))).run();
  }
  const snapshot = parseJson<{ actionTimeoutSeconds: number }>(room.configSnapshotJson, { actionTimeoutSeconds: 60 });
  tx.update(duelRooms).set({
    stateJson: JSON.stringify(state),
    nonce: room.nonce + 1,
    actionDeadlineAt: result.contenderSeats.length > 1 ? new Date(Date.now() + snapshot.actionTimeoutSeconds * 1000) : null,
  }).where(eq(duelRooms.id, room.id)).run();
  appendEvent(tx, room.id, automatic ? "dice_auto_rolled" : "dice_rolled", result, userId, requestId);
  if (result.contenderSeats.length === 1) settleRoom(tx, room.id, result.contenderSeats, "dice_highest");
  else appendEvent(tx, room.id, "dice_tie", { tieRound: tieRound + 1, contenderSeats: result.contenderSeats });
}

function dailyExposure(tx: DuelTx, userId: number) {
  backfillLegacyRoundResults(tx);
  const today = duelLeaderboardPeriodBounds("today");
  const dayStart = new Date(today.startMs!);
  const row = tx.select({
    stake: sql<number>`COALESCE(SUM(${duelRoundResults.stakeUnits}), 0)`,
    payout: sql<number>`COALESCE(SUM(${duelRoundResults.payoutUnits}), 0)`,
  }).from(duelRoundResults).innerJoin(duelRooms, eq(duelRoundResults.roomId, duelRooms.id))
    .where(and(eq(duelRoundResults.userId, userId), gte(duelRoundResults.settledAt, dayStart), isNull(duelRooms.voidedAt))).get();
  const stake = Number(row?.stake ?? 0);
  const payout = Number(row?.payout ?? 0);
  return { stake, netLoss: Math.max(0, stake - payout) };
}

function prepareNextRound(tx: DuelTx, roomId: string) {
  const room = roomOrThrow(tx, roomId);
  if (room.status !== "settled" && room.status !== "refunded") return room;
  const players = playerRows(tx, roomId);
  if (!players.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "房间已无人，不能开启下一局" });
  const config = activeConfig(tx);
  if (players.length > config.maxPlayers) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "当前房间人数超过后台新的上限，请先由部分玩家退出" });
  const nextRoundNo = room.roundNo + 1;
  const seedSecret = newDuelSeed();
  const seedHash = duelSeedCommitment(seedSecret, room.id, room.game, nextRoundNo);
  tx.update(duelPlayers).set({
    ready: false,
    status: "joined",
    balanceBeforeUnits: null,
    stakeUnits: 0,
    payoutUnits: 0,
    settledNetUnits: 0,
    result: "pending",
    handJson: "[]",
    handRankJson: "{}",
    score: null,
    updatedAt: new Date(),
    settledAt: null,
    voidedAt: null,
  }).where(eq(duelPlayers.roomId, roomId)).run();
  tx.update(duelRooms).set({
    status: "lobby",
    configId: config.id,
    configVersion: config.version,
    configSnapshotJson: JSON.stringify(configSnapshot(config)),
    minPlayers: config.minPlayers,
    maxPlayers: Math.min(room.maxPlayers, config.maxPlayers),
    winnerTaxBasisPoints: config.winnerTaxBasisPoints,
    feeBasisPoints: config.winnerTaxBasisPoints,
    grossPrizePoolUnits: 0,
    winnerTaxUnits: 0,
    netPrizePoolUnits: 0,
    potUnits: 0,
    feeUnits: 0,
    roundNo: nextRoundNo,
    nonce: 0,
    seedHash,
    seedSecret,
    seedReveal: null,
    stateJson: "{}",
    currentSeat: null,
    actionDeadlineAt: null,
    startedAt: null,
    finishedAt: null,
    voidedAt: null,
    voidReason: null,
  }).where(eq(duelRooms.id, roomId)).run();
  appendEvent(tx, roomId, "next_round_prepared", { previousRoundNo: room.roundNo, seedHash, configVersion: config.version });
  return roomOrThrow(tx, roomId);
}

function startIfReady(tx: DuelTx, roomId: string) {
  const room = roomOrThrow(tx, roomId);
  if (room.status !== "lobby") return;
  const players = playerRows(tx, roomId);
  if (players.length < room.minPlayers || players.some((player) => !player.ready)) return;
  const snapshot = parseJson<{
    enabled: boolean; diceEnabled: boolean; blackjackEnabled: boolean; actionTimeoutSeconds: number;
    minBetUnits?: number; maxBetUnits?: number; betPrecision?: number;
    singleBetLimitUnits: number; dailyStakeLimitUnits: number; dailyNetLossLimitUnits: number;
  }>(room.configSnapshotJson, {
    enabled: false, diceEnabled: false, blackjackEnabled: false, actionTimeoutSeconds: 60,
    minBetUnits: 1, maxBetUnits: 0, betPrecision: 6,
    singleBetLimitUnits: 0, dailyStakeLimitUnits: 0, dailyNetLossLimitUnits: 0,
  });
  const killSwitch = activeConfig(tx);
  if (!killSwitch.enabled || (room.game === "dice" ? !killSwitch.diceEnabled : !killSwitch.blackjackEnabled)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该玩法已由后台暂停，房间不会扣款" });
  }
  if (!snapshot.enabled || (room.game === "dice" ? !snapshot.diceEnabled : !snapshot.blackjackEnabled)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该玩法当前已关闭" });
  }
  const minBetUnits = snapshot.minBetUnits ?? 1;
  const maxBetUnits = snapshot.maxBetUnits ?? snapshot.singleBetLimitUnits;
  const betPrecision = snapshot.betPrecision ?? 6;
  const precisionStepUnits = 10 ** (6 - betPrecision);
  if (room.betUnits < minBetUnits || room.betUnits > maxBetUnits || room.betUnits > snapshot.singleBetLimitUnits) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "自定义押注不在后台允许范围内" });
  }
  if (room.betUnits % precisionStepUnits !== 0) throw new TRPCError({ code: "BAD_REQUEST", message: `押注金额最多保留 ${betPrecision} 位小数` });
  for (const player of players) {
    const balanceUnits = userBalanceUnits(tx, player.userId);
    if (balanceUnits < room.betUnits) throw new TRPCError({ code: "BAD_REQUEST", message: `玩家「${player.name ?? player.username}」余额不足，未能开局` });
    const exposure = dailyExposure(tx, player.userId);
    if (exposure.stake + room.betUnits > snapshot.dailyStakeLimitUnits) throw new TRPCError({ code: "BAD_REQUEST", message: `玩家「${player.name ?? player.username}」达到每日押注上限` });
    if (exposure.netLoss + room.betUnits > snapshot.dailyNetLossLimitUnits) throw new TRPCError({ code: "BAD_REQUEST", message: `玩家「${player.name ?? player.username}」达到每日净亏损保护线` });
  }

  // 正常路径生成全新 256-bit 种子；已持久化但尚未开局的种子用于崩溃恢复后继续同一承诺。
  const seed = room.seedSecret ?? newDuelSeed();
  const seedHash = room.seedHash || duelSeedCommitment(seed, room.id, room.game, room.roundNo);
  for (const player of players) {
    const before = userBalanceUnits(tx, player.userId);
    const debitRequestId = stakeDebitRequestId(room.id, room.roundNo, player.userId);
    writeUserMoney(tx, roomId, player.userId, -room.betUnits, "stake", debitRequestId, `决斗房 ${room.code} 托管押注`);
    tx.update(duelPlayers).set({
      status: "active", balanceBeforeUnits: before, stakeUnits: room.betUnits, payoutUnits: 0, updatedAt: new Date(),
    }).where(eq(duelPlayers.id, player.id)).run();
  }

  const seats = players.map((player) => player.seat);
  const now = Date.now();
  let state: DuelRoomState;
  let currentSeat: number | null = null;
  let deadline: Date | null = null;
  if (room.game === "dice") {
    state = { kind: "dice", contenderSeats: seats, rounds: [] };
    deadline = new Date(now + snapshot.actionTimeoutSeconds * 1000);
  }
  else {
    state = initialBlackjackState(seed, room.id, room.roundNo, seats);
    for (const player of players) {
      const hand = state.hands[String(player.seat)];
      const evaluation = evaluateBlackjackHand(hand);
      const autoStand = evaluation.automaticStand;
      tx.update(duelPlayers).set({
        handJson: JSON.stringify(hand),
        handRankJson: JSON.stringify(evaluation),
        score: evaluation.score,
        status: autoStand ? "stood" : "active",
        updatedAt: new Date(),
      }).where(eq(duelPlayers.id, player.id)).run();
    }
    const hasActions = playerRows(tx, roomId).some((player) => player.status === "active");
    currentSeat = null;
    deadline = hasActions ? new Date(now + BLACKJACK_ACTION_WINDOW_MS) : null;
  }
  tx.update(duelRooms).set({
    status: "active",
    grossPrizePoolUnits: room.betUnits * players.length,
    winnerTaxUnits: 0,
    netPrizePoolUnits: 0,
    potUnits: room.betUnits * players.length,
    seedHash, seedSecret: seed,
    stateJson: JSON.stringify(state), currentSeat, actionDeadlineAt: deadline, startedAt: new Date(now),
  }).where(eq(duelRooms.id, roomId)).run();
  appendEvent(tx, roomId, "started", {
    game: room.game,
    playerSeats: seats,
    potUnits: room.betUnits * players.length,
    grossPrizePoolUnits: room.betUnits * players.length,
    winnerTaxBasisPoints: room.winnerTaxBasisPoints,
    seedHash,
    configVersion: room.configVersion,
  });
  if (room.game === "blackjack" && deadline === null) settleBlackjackIfComplete(tx, roomId);
}

function uniqueRoomCode(tx: DuelTx) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = "";
    for (let index = 0; index < 6; index += 1) code += alphabet[randomInt(alphabet.length)];
    if (!tx.select({ id: duelRooms.id }).from(duelRooms).where(eq(duelRooms.code, code)).limit(1).get()) return code;
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "暂时无法生成房间码，请重试" });
}

export const duelRouter = createRouter({
  config: memberQuery.query(() => getDb().transaction((tx) => {
    const config = activeConfig(tx);
    return {
      version: config.version,
      enabled: config.enabled,
      games: { dice: config.diceEnabled, blackjack: config.blackjackEnabled },
      winnerTaxBasisPoints: config.winnerTaxBasisPoints,
      feeBasisPoints: config.winnerTaxBasisPoints,
      winnerTaxPercent: config.winnerTaxBasisPoints / 100,
      feePercent: config.winnerTaxBasisPoints / 100,
      betOptions: parseJson<number[]>(config.betOptionsJson, []).map(duelUnitsToDollars),
      quickBetOptions: parseJson<number[]>(config.betOptionsJson, []).map(duelUnitsToDollars),
      minBet: duelUnitsToDollars(config.minBetUnits),
      maxBet: duelUnitsToDollars(config.maxBetUnits),
      betPrecision: config.betPrecision,
      minPlayers: config.minPlayers,
      maxPlayers: config.maxPlayers,
      roomTimeoutSeconds: config.roomTimeoutSeconds,
      actionTimeoutSeconds: config.actionTimeoutSeconds,
      blackjackActionWindowSeconds: BLACKJACK_ACTION_WINDOW_MS / 1000,
      singleBetLimit: duelUnitsToDollars(config.singleBetLimitUnits),
      dailyStakeLimit: duelUnitsToDollars(config.dailyStakeLimitUnits),
      dailyNetLossLimit: duelUnitsToDollars(config.dailyNetLossLimitUnits),
      rules: {
        dice: "三骰：豹子 > 顺子 > 对子 > 散点；同类按点数确定比较，并列最高者加赛。",
        blackjack: BLACKJACK_PVP_RULES.description,
        blackjackDetails: BLACKJACK_PVP_RULES,
      },
    };
  })),

  lobby: memberQuery.query(({ ctx }) => getDb().transaction((tx) => {
    const now = Date.now();
    const active = tx.select().from(duelRooms).where(inArray(duelRooms.status, ["lobby", "active"])).limit(500).all();
    for (const room of active) {
      const snapshot = parseJson<{ roomTimeoutSeconds: number }>(room.configSnapshotJson, { roomTimeoutSeconds: 1800 });
      if (room.status === "lobby" && room.createdAt.getTime() + snapshot.roomTimeoutSeconds * 1000 <= now) {
        const voidedAt = new Date(now);
        voidLobbyPlayers(tx, room.id, voidedAt);
        tx.update(duelRooms).set({ status: "cancelled", seedReveal: room.seedSecret, finishedAt: voidedAt }).where(eq(duelRooms.id, room.id)).run();
        appendEvent(tx, room.id, "cancelled", { reason: "room_timeout", seedReveal: room.seedSecret });
      }
    }
    const rooms = tx.select({
      id: duelRooms.id, code: duelRooms.code, game: duelRooms.game, visibility: duelRooms.visibility,
      ownerId: duelRooms.ownerId, status: duelRooms.status, betUnits: duelRooms.betUnits,
      minPlayers: duelRooms.minPlayers, maxPlayers: duelRooms.maxPlayers, seedHash: duelRooms.seedHash,
      winnerTaxBasisPoints: duelRooms.winnerTaxBasisPoints,
      createdAt: duelRooms.createdAt, startedAt: duelRooms.startedAt,
      playerCount: sql<number>`COUNT(${duelPlayers.id})`,
    }).from(duelRooms).leftJoin(duelPlayers, eq(duelRooms.id, duelPlayers.roomId))
      .where(and(eq(duelRooms.visibility, "public"), inArray(duelRooms.status, REUSABLE_ROOM_STATUSES)))
      .groupBy(duelRooms.id).orderBy(desc(duelRooms.createdAt)).limit(50).all();
    const mine = tx.select({ roomId: duelPlayers.roomId }).from(duelPlayers).innerJoin(duelRooms, eq(duelPlayers.roomId, duelRooms.id))
      .where(and(eq(duelPlayers.userId, ctx.user.id), inArray(duelRooms.status, REUSABLE_ROOM_STATUSES))).limit(100).all();
    return { rooms: rooms.map((room) => ({ ...room, bet: duelUnitsToDollars(room.betUnits), winnerTaxPercent: room.winnerTaxBasisPoints / 100 })), myRoomIds: mine.map((row) => row.roomId) };
  })),

  create: memberQuery.input(z.object({
    requestId: REQUEST_ID,
    game: z.enum(["dice", "blackjack"]),
    visibility: z.enum(["public", "private"]).default("public"),
    bet: z.number().positive().max(1_000_000),
    maxPlayers: z.number().int().min(2).max(6),
    expectedConfigVersion: z.number().int().positive(),
  })).mutation(({ ctx, input }) => getDb().transaction((tx) => {
    assertModuleAvailable(tx, "duel", ctx.user.id);
    const duplicate = idempotentRoom(tx, input.requestId, ctx.user.id, "created");
    if (duplicate) return roomView(tx, duplicate, ctx.user.id);
    const config = activeConfig(tx);
    if (config.version !== input.expectedConfigVersion) throw new TRPCError({ code: "CONFLICT", message: "决斗配置已更新，请刷新后重试" });
    if (!config.enabled || (input.game === "dice" ? !config.diceEnabled : !config.blackjackEnabled)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该玩法当前已关闭" });
    if (input.maxPlayers < config.minPlayers || input.maxPlayers > config.maxPlayers) throw new TRPCError({ code: "BAD_REQUEST", message: `人数必须在 ${config.minPlayers}～${config.maxPlayers} 之间` });
    const betUnits = duelDollarsToUnits(input.bet);
    if (!duelAmountHasPrecision(input.bet, config.betPrecision)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `自定义押注最多保留 ${config.betPrecision} 位小数` });
    }
    if (betUnits < config.minBetUnits || betUnits > config.maxBetUnits || betUnits > config.singleBetLimitUnits) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `自定义押注需在 $${duelUnitsToDollars(config.minBetUnits)}～$${duelUnitsToDollars(config.maxBetUnits)} 之间` });
    }
    const id = randomUUID();
    const code = uniqueRoomCode(tx);
    const seedSecret = newDuelSeed();
    const seedHash = duelSeedCommitment(seedSecret, id, input.game, 1);
    const snapshot = configSnapshot(config);
    tx.insert(duelRooms).values({
      id, code, game: input.game, visibility: input.visibility, ownerId: ctx.user.id,
      configId: config.id, configVersion: config.version, configSnapshotJson: JSON.stringify(snapshot),
      betUnits, minPlayers: config.minPlayers, maxPlayers: input.maxPlayers,
      winnerTaxBasisPoints: config.winnerTaxBasisPoints, feeBasisPoints: config.winnerTaxBasisPoints,
      seedSecret, seedHash,
    }).run();
    tx.insert(duelPlayers).values({ roomId: id, userId: ctx.user.id, gameType: input.game, seat: 1 }).run();
    appendEvent(tx, id, "created", { code, game: input.game, visibility: input.visibility, betUnits, maxPlayers: input.maxPlayers, seedHash }, ctx.user.id, input.requestId);
    return roomView(tx, id, ctx.user.id);
  })),

  join: memberQuery.input(z.object({ requestId: REQUEST_ID, code: ROOM_CODE })).mutation(({ ctx, input }) => getDb().transaction((tx) => {
    assertModuleAvailable(tx, "duel", ctx.user.id);
    const duplicate = idempotentRoom(tx, input.requestId, ctx.user.id, "joined");
    if (duplicate) return roomView(tx, duplicate, ctx.user.id);
    let room = tx.select().from(duelRooms).where(eq(duelRooms.code, input.code)).limit(1).get();
    if (!room) throw new TRPCError({ code: "NOT_FOUND", message: "房间码不存在" });
    if (room.status === "settled" || room.status === "refunded") room = prepareNextRound(tx, room.id);
    if (lobbyExpired(room)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "房间已过期" });
    if (room.status !== "lobby") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "房间正在结算或已经关闭" });
    const players = playerRows(tx, room.id);
    const already = players.find((player) => player.userId === ctx.user.id);
    if (already) {
      appendEvent(tx, room.id, "joined", { seat: already.seat, alreadyJoined: true }, ctx.user.id, input.requestId);
      return roomView(tx, room.id, ctx.user.id);
    }
    if (players.length >= room.maxPlayers) throw new TRPCError({ code: "BAD_REQUEST", message: "房间已满" });
    const used = new Set(players.map((player) => player.seat));
    let seat = 1;
    while (used.has(seat)) seat += 1;
    tx.insert(duelPlayers).values({ roomId: room.id, userId: ctx.user.id, gameType: room.game, seat }).run();
    appendEvent(tx, room.id, "joined", { seat }, ctx.user.id, input.requestId);
    return roomView(tx, room.id, ctx.user.id);
  })),

  room: memberQuery.input(z.object({ roomId: ROOM_ID })).query(({ ctx, input }) => getDb().transaction((tx) => {
    let room = roomOrThrow(tx, input.roomId);
    if (lobbyExpired(room)) {
      const voidedAt = new Date();
      voidLobbyPlayers(tx, room.id, voidedAt);
      tx.update(duelRooms).set({ status: "cancelled", seedReveal: room.seedSecret, finishedAt: voidedAt }).where(eq(duelRooms.id, room.id)).run();
      appendEvent(tx, room.id, "cancelled", { reason: "room_timeout", seedReveal: room.seedSecret });
      room = roomOrThrow(tx, input.roomId);
    }
    if (room.game === "blackjack") processTimeouts(tx, room.id);
    else if (room.status === "active" && room.actionDeadlineAt && room.actionDeadlineAt.getTime() <= Date.now()) executeDiceRound(tx, room.id, null, null, true);
    const member = tx.select().from(duelPlayers).where(and(eq(duelPlayers.roomId, room.id), eq(duelPlayers.userId, ctx.user.id))).limit(1).get();
    if (room.visibility === "private" && !member) throw new TRPCError({ code: "FORBIDDEN", message: "私密房间仅成员可查看" });
    return roomView(tx, room.id, ctx.user.id);
  })),

  setReady: memberQuery.input(z.object({ roomId: ROOM_ID, requestId: REQUEST_ID, ready: z.boolean() })).mutation(({ ctx, input }) => getDb().transaction((tx) => {
    if (input.ready) assertModuleAvailable(tx, "duel", ctx.user.id);
    const duplicate = idempotentRoom(tx, input.requestId, ctx.user.id, "ready");
    if (duplicate) return roomView(tx, duplicate, ctx.user.id);
    let room = roomOrThrow(tx, input.roomId);
    if (room.status === "settled" || room.status === "refunded") room = prepareNextRound(tx, room.id);
    if (lobbyExpired(room)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "房间已过期" });
    if (room.status !== "lobby") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "仅等待中的房间可以准备" });
    const player = tx.select().from(duelPlayers).where(and(eq(duelPlayers.roomId, room.id), eq(duelPlayers.userId, ctx.user.id))).limit(1).get();
    if (!player) throw new TRPCError({ code: "FORBIDDEN", message: "你不在该房间" });
    tx.update(duelPlayers).set({ ready: input.ready, updatedAt: new Date() }).where(eq(duelPlayers.id, player.id)).run();
    appendEvent(tx, room.id, "ready", { ready: input.ready, seat: player.seat }, ctx.user.id, input.requestId);
    startIfReady(tx, room.id);
    return roomView(tx, room.id, ctx.user.id);
  })),

  leave: memberQuery.input(z.object({ roomId: ROOM_ID, requestId: REQUEST_ID })).mutation(({ ctx, input }) => getDb().transaction((tx) => {
    const duplicate = idempotentRoom(tx, input.requestId, ctx.user.id, "left");
    if (duplicate) return roomView(tx, duplicate, ctx.user.id);
    const room = roomOrThrow(tx, input.roomId);
    const player = tx.select().from(duelPlayers).where(and(eq(duelPlayers.roomId, room.id), eq(duelPlayers.userId, ctx.user.id))).limit(1).get();
    if (!player) throw new TRPCError({ code: "FORBIDDEN", message: "你不在该房间" });
    if (room.status === "active") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "本局结算前不能退出；二十一点超时会自动停牌" });
    if (room.status === "cancelled") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "房间已经关闭" });
    appendEvent(tx, room.id, "left", { seat: player.seat }, ctx.user.id, input.requestId);
    tx.delete(duelPlayers).where(eq(duelPlayers.id, player.id)).run();
    const remaining = playerRows(tx, room.id);
    if (!remaining.length) {
      tx.update(duelRooms).set({ status: "cancelled", seedReveal: room.seedSecret, finishedAt: new Date() }).where(eq(duelRooms.id, room.id)).run();
      appendEvent(tx, room.id, "cancelled", { reason: "last_player_left", seedReveal: room.seedSecret });
    } else if (room.ownerId === ctx.user.id) {
      tx.update(duelRooms).set({ ownerId: remaining[0].userId }).where(eq(duelRooms.id, room.id)).run();
      appendEvent(tx, room.id, "owner_transferred", { ownerId: remaining[0].userId, seat: remaining[0].seat });
    }
    return roomView(tx, room.id, ctx.user.id);
  })),

  rollDice: memberQuery.input(z.object({ roomId: ROOM_ID, requestId: REQUEST_ID })).mutation(({ ctx, input }) => getDb().transaction((tx) => {
    const duplicate = idempotentRoom(tx, input.requestId, ctx.user.id, "dice_rolled");
    if (duplicate) return roomView(tx, duplicate, ctx.user.id);
    const room = roomOrThrow(tx, input.roomId);
    if (room.game !== "dice" || room.status !== "active" || !room.seedSecret) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "骰子局当前不能开奖" });
    const member = tx.select().from(duelPlayers).where(and(eq(duelPlayers.roomId, room.id), eq(duelPlayers.userId, ctx.user.id))).limit(1).get();
    if (!member) throw new TRPCError({ code: "FORBIDDEN", message: "你不在该房间" });
    executeDiceRound(tx, room.id, ctx.user.id, input.requestId);
    return roomView(tx, room.id, ctx.user.id);
  })),

  blackjackAction: memberQuery.input(z.object({ roomId: ROOM_ID, requestId: REQUEST_ID, action: z.enum(["hit", "stand"]) })).mutation(({ ctx, input }) => getDb().transaction((tx) => {
    const duplicate = idempotentRoom(tx, input.requestId, ctx.user.id, "blackjack_action");
    if (duplicate) return roomView(tx, duplicate, ctx.user.id);
    processTimeouts(tx, input.roomId);
    const room = roomOrThrow(tx, input.roomId);
    if (room.game !== "blackjack" || room.status !== "active" || !room.seedSecret) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `二十一点当前不能行动（房间状态：${room.status}）` });
    const player = tx.select().from(duelPlayers).where(and(eq(duelPlayers.roomId, room.id), eq(duelPlayers.userId, ctx.user.id))).limit(1).get();
    if (!player) throw new TRPCError({ code: "FORBIDDEN", message: "你不在该房间" });
    if (player.status !== "active") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "你已完成本局操作，请等待统一揭牌" });
    const state = parseJson<BlackjackRoomState>(room.stateJson, { kind: "blackjack", deck: [], cursor: 0, hands: {}, actions: [] });
    let card;
    let score = blackjackSeatScore(state, player.seat);
    if (input.action === "hit") {
      card = drawBlackjackCard(state, player.seat);
      score = blackjackSeatScore(state, player.seat);
    }
    const resolved = input.action === "stand" || score.automaticStand;
    const status = score.busted ? "busted" : resolved ? "stood" : "active";
    state.actions.push({ seat: player.seat, action: input.action, card, score: score.score, at: Date.now() });
    tx.update(duelPlayers).set({
      handJson: JSON.stringify(state.hands[String(player.seat)]),
      handRankJson: JSON.stringify(score),
      score: score.score,
      status,
      updatedAt: new Date(),
    }).where(eq(duelPlayers.id, player.id)).run();
    tx.update(duelRooms).set({ stateJson: JSON.stringify(state), nonce: room.nonce + 1 }).where(eq(duelRooms.id, room.id)).run();
    appendEvent(tx, room.id, "blackjack_action", { seat: player.seat, action: input.action, status: resolved ? "completed" : "acting" }, ctx.user.id, input.requestId);
    if (resolved) settleBlackjackIfComplete(tx, room.id);
    return roomView(tx, room.id, ctx.user.id);
  })),

  history: memberQuery.input(z.object({ page: z.number().int().min(1).default(1) })).query(({ ctx, input }) => getDb().transaction((tx) => {
    backfillLegacyRoundResults(tx);
    const pageSize = 20;
    const total = Number(tx.select({ count: sql<number>`COUNT(*)` }).from(duelRoundResults).where(eq(duelRoundResults.userId, ctx.user.id)).get()?.count ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(input.page, totalPages);
    const rows = tx.select({
      roomId: duelRoundResults.roomId,
      roundNo: duelRoundResults.roundNo,
      code: duelRooms.code,
      game: duelRoundResults.gameType,
      status: duelRoundResults.status,
      betUnits: duelRoundResults.betUnits,
      potUnits: duelRoundResults.potUnits,
      feeUnits: duelRoundResults.winnerTaxUnits,
      winnerTaxBasisPoints: duelRoundResults.winnerTaxBasisPoints,
      grossPrizePoolUnits: duelRoundResults.grossPrizePoolUnits,
      winnerTaxUnits: duelRoundResults.winnerTaxUnits,
      netPrizePoolUnits: duelRoundResults.netPrizePoolUnits,
      seedHash: duelRoundResults.seedHash,
      seedReveal: duelRoundResults.seedReveal,
      startedAt: duelRoundResults.startedAt,
      finishedAt: duelRoundResults.settledAt,
      seat: duelRoundResults.seat,
      playerStatus: duelRoundResults.status,
      result: duelRoundResults.result,
      stakeUnits: duelRoundResults.stakeUnits,
      payoutUnits: duelRoundResults.payoutUnits,
      settledNetUnits: duelRoundResults.settledNetUnits,
      handJson: duelRoundResults.handJson,
      handRankJson: duelRoundResults.handRankJson,
      score: duelRoundResults.score,
      settledAt: duelRoundResults.settledAt,
    }).from(duelRoundResults).innerJoin(duelRooms, eq(duelRoundResults.roomId, duelRooms.id))
      .where(eq(duelRoundResults.userId, ctx.user.id)).orderBy(desc(duelRoundResults.settledAt), desc(duelRoundResults.id))
      .limit(pageSize).offset((page - 1) * pageSize).all();
    return {
      rows: rows.map(({ handJson, handRankJson, ...row }) => {
        const hand = parseJson<DuelCard[]>(handJson, []);
        return {
        ...row,
        hand,
        handRank: row.game === "blackjack" ? parseBlackjackEvaluation(handRankJson, hand) : null,
        bet: duelUnitsToDollars(row.betUnits),
        pot: duelUnitsToDollars(row.potUnits),
        fee: duelUnitsToDollars(row.feeUnits),
        winnerTaxPercent: row.winnerTaxBasisPoints / 100,
        grossPrizePool: duelUnitsToDollars(row.grossPrizePoolUnits),
        winnerTax: duelUnitsToDollars(row.winnerTaxUnits),
        netPrizePool: duelUnitsToDollars(row.netPrizePoolUnits),
        stake: duelUnitsToDollars(row.stakeUnits),
        payout: duelUnitsToDollars(row.payoutUnits),
        settledNet: duelUnitsToDollars(row.settledNetUnits),
      }; }),
      page, pageSize, total, totalPages,
    };
  })),

  leaderboard: memberQuery.input(z.object({
    board: z.enum(["winner", "loser"]),
    period: z.enum(["today", "week", "month", "all"]),
    game: z.enum(["all", "dice", "blackjack"]),
    page: z.number().int().min(1).default(1),
  })).query(({ ctx, input }) => getDb().transaction((tx) => {
    backfillLegacyRoundResults(tx);
    const bounds = duelLeaderboardPeriodBounds(input.period);
    const conditions = [
      inArray(duelRoundResults.result, ["win", "loss"]),
      isNull(duelRooms.voidedAt),
      isNotNull(users.groupName),
      eq(users.banned, false),
      sql`trim(${users.groupName}) != ''`,
    ];
    if (input.game !== "all") conditions.push(eq(duelRoundResults.gameType, input.game));
    if (bounds.startMs !== null && bounds.endMs !== null) {
      conditions.push(gte(duelRoundResults.settledAt, new Date(bounds.startMs)));
      conditions.push(lt(duelRoundResults.settledAt, new Date(bounds.endMs)));
    }
    const aggregated = tx.select({
      userId: duelRoundResults.userId,
      groupName: users.groupName,
      avatarUrl: users.avatarUrl,
      netUnits: sql<number>`COALESCE(SUM(${duelRoundResults.settledNetUnits}), 0)`,
      wins: sql<number>`SUM(CASE WHEN ${duelRoundResults.result} = 'win' THEN 1 ELSE 0 END)`,
      losses: sql<number>`SUM(CASE WHEN ${duelRoundResults.result} = 'loss' THEN 1 ELSE 0 END)`,
      games: sql<number>`COUNT(*)`,
    }).from(duelRoundResults)
      .innerJoin(duelRooms, eq(duelRoundResults.roomId, duelRooms.id))
      .innerJoin(users, eq(duelRoundResults.userId, users.id))
      .where(and(...conditions))
      .groupBy(duelRoundResults.userId, users.groupName, users.avatarUrl)
      .all()
      .map((row) => ({ ...row, netUnits: Number(row.netUnits), wins: Number(row.wins), losses: Number(row.losses), games: Number(row.games) }));

    const eligible = aggregated.filter((row) => input.board === "winner" ? row.netUnits > 0 : row.netUnits < 0);
    eligible.sort((left, right) => {
      const primary = input.board === "winner" ? right.netUnits - left.netUnits : left.netUnits - right.netUnits;
      if (primary !== 0) return primary;
      if (right.wins !== left.wins) return right.wins - left.wins;
      const ratio = right.wins * left.games - left.wins * right.games;
      if (ratio !== 0) return ratio;
      if (right.games !== left.games) return right.games - left.games;
      return left.userId - right.userId;
    });
    const pageSize = 20;
    const total = eligible.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(input.page, totalPages);
    const publicRow = (row: typeof eligible[number], rank: number) => ({
      rank,
      groupName: row.groupName ?? "未知",
      avatarUrl: publicAvatarUrl(row.avatarUrl),
      net: duelUnitsToDollars(row.netUnits),
      value: duelUnitsToDollars(Math.abs(row.netUnits)),
      wins: row.wins,
      losses: row.losses,
      games: row.games,
      winRatePercent: row.games ? Math.round((row.wins * 10_000) / row.games) / 100 : 0,
    });
    const mineIndex = eligible.findIndex((row) => row.userId === ctx.user.id);
    const myAggregate = aggregated.find((row) => row.userId === ctx.user.id);
    const expectedPositive = input.board === "winner";
    const mine = mineIndex >= 0
      ? { ...publicRow(eligible[mineIndex], mineIndex + 1), isRanked: true, reason: null }
      : {
          rank: null,
          isRanked: false,
          groupName: ctx.user.groupName ?? "我",
          avatarUrl: publicAvatarUrl(ctx.user.avatarUrl),
          net: duelUnitsToDollars(myAggregate?.netUnits ?? 0),
          value: duelUnitsToDollars(Math.abs(myAggregate?.netUnits ?? 0)),
          wins: myAggregate?.wins ?? 0,
          losses: myAggregate?.losses ?? 0,
          games: myAggregate?.games ?? 0,
          winRatePercent: myAggregate?.games ? Math.round((myAggregate.wins * 10_000) / myAggregate.games) / 100 : 0,
          reason: !myAggregate
            ? "所选周期和玩法下暂无有效已结算对局"
            : myAggregate.netUnits === 0
              ? "所选范围内税后净收益为 0"
              : expectedPositive
                ? "税后净收益未大于 0，未进入赢家榜"
                : "税后净收益未小于 0，未进入逆风榜",
        };
    return {
      board: input.board,
      period: input.period,
      game: input.game,
      timezone: bounds.timezone,
      interval: bounds.startMs === null ? null : { start: new Date(bounds.startMs), end: new Date(bounds.endMs!) },
      rows: eligible.slice((page - 1) * pageSize, page * pageSize).map((row, index) => publicRow(row, (page - 1) * pageSize + index + 1)),
      mine,
      page,
      pageSize,
      total,
      totalPages,
      metric: input.board === "winner" ? "税后净收益" : "税后净亏损绝对值",
      privacy: "仅公开群内名称、头像和决斗统计；不返回当前余额、OAuth 标识、用户 ID 或 IP。",
    };
  })),
});
