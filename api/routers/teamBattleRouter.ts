import { randomInt, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { createRouter } from "../middleware";
import { adminQuery, memberQuery } from "../auth";
import { getDb } from "../queries/connection";
import { assertModuleAvailable } from "../queries/policies";
import { recordTx } from "../queries/ledger";
import { debitUserBalance, reverseUserBalanceDebit } from "../queries/credit-grants";
import { paginatedResult, paginationInput, resolvePagination } from "../pagination";
import {
  adminLogs,
  teamBattleBets,
  teamBattleConfigs,
  teamBattleEvents,
  teamBattleFund,
  teamBattleLedger,
  teamBattlePlayers,
  teamBattleRooms,
  teamBattleVotes,
  users,
} from "../../db/schema";
import {
  calculateTeamBattleSettlement,
  projectedReturnPpm,
  TEAM_BATTLE_MODES,
  TEAM_BATTLE_SEATS,
  TEAM_BATTLE_TAX_BASIS_POINTS,
  teamBattleDollarsToUnits,
  teamBattleUnitsToDollars,
  teamBattleVoteThreshold,
  type TeamBattleSide,
} from "@contracts/team-battle";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const REQUEST_ID = z.string().uuid();
const ROOM_ID = z.string().uuid();
const SIDE = z.enum(["A", "B"]);
const MODE = z.enum(TEAM_BATTLE_MODES);
const ROOM_CODE = z.string().trim().toUpperCase().regex(/^[A-Z2-9]{6}$/);

function activeConfig(tx: Tx) {
  const config = tx.select().from(teamBattleConfigs).where(eq(teamBattleConfigs.active, true))
    .orderBy(desc(teamBattleConfigs.version)).limit(1).get();
  if (!config) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "战队对抗尚未配置" });
  return config;
}

function configSnapshot(config: typeof teamBattleConfigs.$inferSelect) {
  return {
    version: config.version,
    enabled: config.enabled,
    singleBetLimitUnits: config.singleBetLimitUnits,
    userBetLimitUnits: config.userBetLimitUnits,
    roomBetLimitUnits: config.roomBetLimitUnits,
    losingPoolTaxBasisPoints: TEAM_BATTLE_TAX_BASIS_POINTS,
    playerTaxShareBasisPoints: 5_000,
  };
}

function parseSnapshot(raw: string) {
  try {
    return JSON.parse(raw) as ReturnType<typeof configSnapshot>;
  } catch {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "房间配置快照损坏" });
  }
}

function roomOrThrow(tx: Tx, roomId: string) {
  const room = tx.select().from(teamBattleRooms).where(eq(teamBattleRooms.id, roomId)).limit(1).get();
  if (!room) throw new TRPCError({ code: "NOT_FOUND", message: "战队房不存在" });
  return room;
}

function playerRows(tx: Tx, roomId: string) {
  return tx.select({
    id: teamBattlePlayers.id,
    roomId: teamBattlePlayers.roomId,
    userId: teamBattlePlayers.userId,
    team: teamBattlePlayers.team,
    seat: teamBattlePlayers.seat,
    status: teamBattlePlayers.status,
    taxShareUnits: teamBattlePlayers.taxShareUnits,
    joinedAt: teamBattlePlayers.joinedAt,
    groupName: users.groupName,
    username: users.username,
    avatarUrl: users.avatarUrl,
  }).from(teamBattlePlayers).innerJoin(users, eq(teamBattlePlayers.userId, users.id))
    .where(and(eq(teamBattlePlayers.roomId, roomId), eq(teamBattlePlayers.status, "joined")))
    .orderBy(asc(teamBattlePlayers.team), asc(teamBattlePlayers.seat)).all();
}

function appendEvent(tx: Tx, roomId: string, type: string, payload: unknown, userId: number | null = null, requestId: string | null = null) {
  const seq = Number(tx.select({ n: sql<number>`COALESCE(MAX(${teamBattleEvents.seq}), 0) + 1` })
    .from(teamBattleEvents).where(eq(teamBattleEvents.roomId, roomId)).get()?.n ?? 1);
  tx.insert(teamBattleEvents).values({ roomId, seq, type, userId, requestId, payloadJson: JSON.stringify(payload) }).run();
}

function eventRoomForRequest(tx: Tx, requestId: string, userId: number, type: string) {
  const event = tx.select().from(teamBattleEvents).where(eq(teamBattleEvents.requestId, requestId)).limit(1).get();
  if (!event) return null;
  if (event.userId !== userId || event.type !== type)
    throw new TRPCError({ code: "CONFLICT", message: "请求编号已用于其他战队操作" });
  return event.roomId;
}

function ensureRoomAccess(room: typeof teamBattleRooms.$inferSelect, players: ReturnType<typeof playerRows>, viewerId: number, code?: string) {
  if (room.visibility === "private" && room.ownerId !== viewerId && !players.some((player) => player.userId === viewerId) && code !== room.code)
    throw new TRPCError({ code: "FORBIDDEN", message: "私密房需要正确房间码" });
}

function balanceUnits(tx: Tx, userId: number) {
  const balance = tx.select({ balance: users.balance }).from(users).where(eq(users.id, userId)).limit(1).get()?.balance;
  if (balance === undefined) throw new TRPCError({ code: "NOT_FOUND", message: "用户不存在" });
  return teamBattleDollarsToUnits(Number(balance));
}

function writeMoney(tx: Tx, roomId: string, userId: number, units: number, type: string, requestId: string | null, note: string) {
  if (!units) return;
  if (units < 0) debitUserBalance(tx, { userId, amount: teamBattleUnitsToDollars(-units), sourceKind: "team_battle", requestId, note });
  else tx.update(users).set({ balance: sql`${users.balance} + ${teamBattleUnitsToDollars(units)}` }).where(eq(users.id, userId)).run();
  recordTx(tx, userId, "team_battle", teamBattleUnitsToDollars(units), note);
  tx.insert(teamBattleLedger).values({
    roomId, userId, requestId, type, amountUnits: units, userBalanceAfterUnits: balanceUnits(tx, userId), note,
  }).run();
}

function odds(poolAUnits: number, poolBUnits: number) {
  const aPpm = projectedReturnPpm(poolAUnits, poolBUnits);
  const bPpm = projectedReturnPpm(poolBUnits, poolAUnits);
  return {
    ready: poolAUnits > 0 && poolBUnits > 0,
    A: aPpm === null ? null : { returnPpm: aPpm, decimal: aPpm / 1_000_000 },
    B: bPpm === null ? null : { returnPpm: bPpm, decimal: bPpm / 1_000_000 },
  };
}

function roomView(tx: Tx, roomId: string, viewerId: number, code?: string, admin = false) {
  const room = roomOrThrow(tx, roomId);
  const players = playerRows(tx, roomId);
  if (!admin) ensureRoomAccess(room, players, viewerId, code);
  const voteRows = tx.select().from(teamBattleVotes)
    .where(and(eq(teamBattleVotes.roomId, room.id), eq(teamBattleVotes.voteRound, room.voteRound)))
    .orderBy(asc(teamBattleVotes.id)).all();
  const revealVotes = admin || room.status === "settled" || room.status === "refunded";
  const ownBets = admin ? [] : tx.select().from(teamBattleBets)
    .where(and(eq(teamBattleBets.roomId, room.id), eq(teamBattleBets.userId, viewerId))).orderBy(asc(teamBattleBets.id)).all();
  const events = tx.select().from(teamBattleEvents).where(eq(teamBattleEvents.roomId, room.id))
    .orderBy(desc(teamBattleEvents.seq)).limit(100).all().reverse();
  const threshold = teamBattleVoteThreshold(room.mode);
  return {
    ...room,
    configSnapshotJson: undefined,
    config: parseSnapshot(room.configSnapshotJson),
    poolA: teamBattleUnitsToDollars(room.poolAUnits),
    poolB: teamBattleUnitsToDollars(room.poolBUnits),
    odds: odds(room.poolAUnits, room.poolBUnits),
    voteProgress: { submitted: voteRows.length, totalPlayers: room.seatsPerTeam * 2, threshold },
    votes: revealVotes ? voteRows.map((vote) => ({ userId: vote.userId, winnerTeam: vote.winnerTeam, createdAt: vote.createdAt })) : undefined,
    players: players.map((player) => ({ ...player, taxShare: teamBattleUnitsToDollars(player.taxShareUnits) })),
    viewer: {
      player: players.find((player) => player.userId === viewerId) ?? null,
      bets: ownBets.map((bet) => ({ ...bet, amount: teamBattleUnitsToDollars(bet.amountUnits), payout: teamBattleUnitsToDollars(bet.payoutUnits) })),
      totalBetA: teamBattleUnitsToDollars(ownBets.filter((bet) => bet.team === "A").reduce((sum, bet) => sum + bet.amountUnits, 0)),
      totalBetB: teamBattleUnitsToDollars(ownBets.filter((bet) => bet.team === "B").reduce((sum, bet) => sum + bet.amountUnits, 0)),
      voted: voteRows.some((vote) => vote.userId === viewerId),
    },
    events: events.map((event) => {
      const payload = JSON.parse(event.payloadJson) as unknown;
      if (!revealVotes && event.type === "vote_cast") {
        return { ...event, userId: null, requestId: null, payload, payloadJson: undefined };
      }
      return { ...event, payload, payloadJson: undefined };
    }),
    rules: {
      taxBasisPoints: TEAM_BATTLE_TAX_BASIS_POINTS,
      winnerPayout: "胜方本金全返，另按胜方投注占比分配败方池税后90%",
      taxSplit: "败方池10%税：一半平分给全部在席选手，另一半进入平台基金",
      integerRemainder: "所有分配使用整数最大余数法；税额无法均分的最小单位归平台",
    },
  };
}

function settle(tx: Tx, roomId: string, winnerTeam: TeamBattleSide) {
  const room = roomOrThrow(tx, roomId);
  if (room.status === "settled") return;
  if (room.status !== "voting") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "房间不在投票结算阶段" });
  const bets = tx.select().from(teamBattleBets).where(and(eq(teamBattleBets.roomId, room.id), eq(teamBattleBets.status, "escrowed")))
    .orderBy(asc(teamBattleBets.id)).all();
  const players = playerRows(tx, room.id);
  const result = calculateTeamBattleSettlement(bets, players, winnerTeam);
  const bettorCredits = new Map<number, number>();
  const now = new Date();
  for (const bet of bets) {
    const payout = result.payoutByBet.get(bet.id) ?? 0;
    tx.update(teamBattleBets).set({ status: bet.team === winnerTeam ? "won" : "lost", payoutUnits: payout, settledAt: now })
      .where(eq(teamBattleBets.id, bet.id)).run();
    if (payout) bettorCredits.set(bet.userId, (bettorCredits.get(bet.userId) ?? 0) + payout);
  }
  for (const [userId, units] of bettorCredits)
    writeMoney(tx, room.id, userId, units, "winner_payout", null, `战队房 ${room.code} 胜方本金及分成`);
  for (const player of players) {
    const units = result.taxShareByPlayer.get(player.id) ?? 0;
    tx.update(teamBattlePlayers).set({ taxShareUnits: units }).where(eq(teamBattlePlayers.id, player.id)).run();
    if (units) writeMoney(tx, room.id, player.userId, units, "player_tax_share", null, `战队房 ${room.code} 选手税分成`);
  }
  if (result.platformTaxUnits) {
    tx.update(teamBattleFund).set({ balanceUnits: sql`${teamBattleFund.balanceUnits} + ${result.platformTaxUnits}`, updatedAt: now })
      .where(eq(teamBattleFund.id, 1)).run();
    const fundAfter = Number(tx.select({ units: teamBattleFund.balanceUnits }).from(teamBattleFund).where(eq(teamBattleFund.id, 1)).get()?.units ?? 0);
    tx.insert(teamBattleLedger).values({ roomId: room.id, type: "platform_tax", amountUnits: result.platformTaxUnits, fundBalanceAfterUnits: fundAfter, note: `战队房 ${room.code} 平台税` }).run();
  }
  const payoutUnits = [...result.payoutByBet.values()].reduce((sum, value) => sum + value, 0) + result.playerTaxUnits;
  tx.update(teamBattleRooms).set({
    status: "settled", winnerTeam, losingPoolTaxUnits: result.taxUnits, playerTaxUnits: result.playerTaxUnits,
    platformTaxUnits: result.platformTaxUnits, payoutUnits, finishedAt: now,
  }).where(and(eq(teamBattleRooms.id, room.id), eq(teamBattleRooms.status, "voting"))).run();
  appendEvent(tx, room.id, "settled", {
    winnerTeam, poolAUnits: result.poolAUnits, poolBUnits: result.poolBUnits, losingPoolTaxUnits: result.taxUnits,
    playerTaxUnits: result.playerTaxUnits, platformTaxUnits: result.platformTaxUnits, payoutUnits,
  });
}

function refundDisputed(tx: Tx, roomId: string, reason: string, requestId: string) {
  const room = roomOrThrow(tx, roomId);
  if (room.status === "refunded") return;
  if (room.status !== "disputed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "仅争议房可作废退款" });
  const bets = tx.select().from(teamBattleBets).where(and(eq(teamBattleBets.roomId, room.id), eq(teamBattleBets.status, "escrowed"))).all();
  const now = new Date();
  let refundedUnits = 0;
  let expiredUnits = 0;
  for (const bet of bets) {
    const reversal = reverseUserBalanceDebit(tx, {
      userId: bet.userId,
      amount: teamBattleUnitsToDollars(bet.amountUnits),
      sourceKind: "team_battle",
      requestId: bet.requestId,
      note: `战队房 ${room.code} 争议退款恢复原额度来源`,
      now,
    });
    const creditedUnits = teamBattleDollarsToUnits(reversal.credited);
    const expiredForBetUnits = teamBattleDollarsToUnits(reversal.expiredTemporary);
    refundedUnits += creditedUnits;
    expiredUnits += expiredForBetUnits;
    if (creditedUnits > 0) recordTx(tx, bet.userId, "team_battle", reversal.credited, `战队房 ${room.code} 争议作废退款`);
    tx.insert(teamBattleLedger).values({
      roomId: room.id,
      userId: bet.userId,
      requestId: bet.requestId,
      type: "refund",
      amountUnits: creditedUnits,
      userBalanceAfterUnits: balanceUnits(tx, bet.userId),
      note: expiredForBetUnits > 0 ? `战队房 ${room.code} 退款；${teamBattleUnitsToDollars(expiredForBetUnits)} 已过期临时额度不返还` : `战队房 ${room.code} 争议作废退款`,
    }).run();
    tx.update(teamBattleBets).set({ status: "refunded", payoutUnits: creditedUnits, settledAt: now }).where(eq(teamBattleBets.id, bet.id)).run();
  }
  if (expiredUnits > 0) {
    tx.update(teamBattleFund).set({ balanceUnits: sql`${teamBattleFund.balanceUnits} + ${expiredUnits}`, updatedAt: now }).where(eq(teamBattleFund.id, 1)).run();
    const fundAfter = Number(tx.select({ units: teamBattleFund.balanceUnits }).from(teamBattleFund).where(eq(teamBattleFund.id, 1)).get()?.units ?? expiredUnits);
    tx.insert(teamBattleLedger).values({ roomId: room.id, type: "expired_credit_forfeit", amountUnits: expiredUnits, fundBalanceAfterUnits: fundAfter, note: `战队房 ${room.code} 退款时临时额度已到期清退` }).run();
  }
  tx.update(teamBattleRooms).set({ status: "refunded", payoutUnits: refundedUnits, finishedAt: now, disputeReason: reason })
    .where(eq(teamBattleRooms.id, room.id)).run();
  appendEvent(tx, room.id, "dispute_refunded", { reason, refundUnits: refundedUnits, expiredCreditUnits: expiredUnits }, null, requestId);
}

function makeCode(tx: Tx) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = "";
    for (let i = 0; i < 6; i += 1) code += alphabet[randomInt(alphabet.length)];
    if (!tx.select({ id: teamBattleRooms.id }).from(teamBattleRooms).where(eq(teamBattleRooms.code, code)).get()) return code;
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "无法生成唯一房间码" });
}

export const teamBattleRouter = createRouter({
  config: memberQuery.query(() => getDb().transaction((tx) => {
    const config = activeConfig(tx);
    return {
      ...configSnapshot(config),
      modes: TEAM_BATTLE_MODES.map((mode) => ({ mode, seatsPerTeam: TEAM_BATTLE_SEATS[mode], totalPlayers: TEAM_BATTLE_SEATS[mode] * 2, voteThreshold: teamBattleVoteThreshold(mode) })),
      singleBetLimit: teamBattleUnitsToDollars(config.singleBetLimitUnits),
      userBetLimit: teamBattleUnitsToDollars(config.userBetLimitUnits),
      roomBetLimit: teamBattleUnitsToDollars(config.roomBetLimitUnits),
    };
  })),

  listRoomsPage: memberQuery.input(paginationInput.extend({
    mode: MODE.optional(),
    status: z.enum(["lobby", "betting", "voting", "settled", "disputed", "cancelled", "refunded"]).optional(),
  })).query(({ ctx, input }) => getDb().transaction((tx) => {
    const conditions = [or(eq(teamBattleRooms.visibility, "public"), eq(teamBattleRooms.ownerId, ctx.user.id), sql`EXISTS (SELECT 1 FROM team_battle_players p WHERE p.room_id = ${teamBattleRooms.id} AND p.user_id = ${ctx.user.id})`)];
    if (input.mode) conditions.push(eq(teamBattleRooms.mode, input.mode));
    if (input.status) conditions.push(eq(teamBattleRooms.status, input.status));
    const where = and(...conditions);
    const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(teamBattleRooms).where(where).get()?.n ?? 0);
    const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
    const items = tx.select().from(teamBattleRooms).where(where).orderBy(desc(teamBattleRooms.createdAt))
      .limit(pageSize).offset(offset).all().map((room) => ({
        ...room, configSnapshotJson: undefined, code: room.visibility === "private" && room.ownerId !== ctx.user.id ? undefined : room.code,
        poolA: teamBattleUnitsToDollars(room.poolAUnits), poolB: teamBattleUnitsToDollars(room.poolBUnits), odds: odds(room.poolAUnits, room.poolBUnits),
      }));
    return paginatedResult(items, total, page, pageSize);
  })),

  room: memberQuery.input(z.object({ roomId: ROOM_ID, code: ROOM_CODE.optional() })).query(({ ctx, input }) =>
    getDb().transaction((tx) => roomView(tx, input.roomId, ctx.user.id, input.code))),

  findByCode: memberQuery.input(z.object({ code: ROOM_CODE })).query(({ ctx, input }) => getDb().transaction((tx) => {
    const room = tx.select().from(teamBattleRooms).where(eq(teamBattleRooms.code, input.code)).limit(1).get();
    if (!room) throw new TRPCError({ code: "NOT_FOUND", message: "房间码不存在" });
    return roomView(tx, room.id, ctx.user.id, input.code);
  })),

  create: memberQuery.input(z.object({
    requestId: REQUEST_ID, mode: MODE, visibility: z.enum(["public", "private"]), expectedConfigVersion: z.number().int().positive(),
  }).strict()).mutation(({ ctx, input }) => getDb().transaction((tx) => {
    assertModuleAvailable(tx, "teamBattle", ctx.user.id);
    const previous = eventRoomForRequest(tx, input.requestId, ctx.user.id, "room_created");
    if (previous) {
      const priorRoom = roomOrThrow(tx, previous);
      if (priorRoom.mode !== input.mode || priorRoom.visibility !== input.visibility || priorRoom.configVersion !== input.expectedConfigVersion)
        throw new TRPCError({ code: "CONFLICT", message: "请求编号已用于其他建房参数" });
      return roomView(tx, previous, ctx.user.id);
    }
    const config = activeConfig(tx);
    if (!config.enabled) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "战队对抗暂未开放" });
    if (config.version !== input.expectedConfigVersion) throw new TRPCError({ code: "CONFLICT", message: "配置已更新，请刷新后重试" });
    const id = randomUUID();
    const code = makeCode(tx);
    const seatsPerTeam = TEAM_BATTLE_SEATS[input.mode];
    tx.insert(teamBattleRooms).values({
      id, code, mode: input.mode, visibility: input.visibility, ownerId: ctx.user.id, seatsPerTeam,
      configVersion: config.version, configSnapshotJson: JSON.stringify(configSnapshot(config)),
    }).run();
    appendEvent(tx, id, "room_created", { mode: input.mode, visibility: input.visibility, ownerStartsAsSpectator: true }, ctx.user.id, input.requestId);
    return roomView(tx, id, ctx.user.id);
  })),

  join: memberQuery.input(z.object({ requestId: REQUEST_ID, code: ROOM_CODE }).strict()).mutation(({ ctx, input }) =>
    getDb().transaction((tx) => {
      assertModuleAvailable(tx, "teamBattle", ctx.user.id);
      const previous = eventRoomForRequest(tx, input.requestId, ctx.user.id, "spectator_joined");
      if (previous) {
        const priorRoom = roomOrThrow(tx, previous);
        if (priorRoom.code !== input.code) throw new TRPCError({ code: "CONFLICT", message: "请求编号已用于其他房间" });
        return roomView(tx, previous, ctx.user.id, input.code);
      }
      const room = tx.select().from(teamBattleRooms).where(eq(teamBattleRooms.code, input.code)).limit(1).get();
      if (!room) throw new TRPCError({ code: "NOT_FOUND", message: "房间码不存在" });
      appendEvent(tx, room.id, "spectator_joined", { viaRoomCode: true }, ctx.user.id, input.requestId);
      return roomView(tx, room.id, ctx.user.id, input.code);
    })),

  takeSeat: memberQuery.input(z.object({ roomId: ROOM_ID, roomCode: ROOM_CODE.optional(), requestId: REQUEST_ID, team: SIDE, seat: z.number().int().positive().max(5) }).strict()).mutation(({ ctx, input }) =>
    getDb().transaction((tx) => {
      assertModuleAvailable(tx, "teamBattle", ctx.user.id);
      const previous = eventRoomForRequest(tx, input.requestId, ctx.user.id, "seat_taken");
      if (previous) {
        const priorRoom = roomOrThrow(tx, previous);
        const priorEvent = tx.select().from(teamBattleEvents).where(eq(teamBattleEvents.requestId, input.requestId)).limit(1).get()!;
        const payload = JSON.parse(priorEvent.payloadJson) as { team?: string; seat?: number };
        if (previous !== input.roomId || payload.team !== input.team || payload.seat !== input.seat)
          throw new TRPCError({ code: "CONFLICT", message: "请求编号已用于其他席位" });
        return roomView(tx, previous, ctx.user.id, input.roomCode ?? priorRoom.code);
      }
      const room = roomOrThrow(tx, input.roomId);
      const players = playerRows(tx, room.id);
      ensureRoomAccess(room, players, ctx.user.id, input.roomCode);
      if (room.status !== "lobby" || room.rosterLocked) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "仅组队阶段可以占座" });
      if (input.seat > room.seatsPerTeam) throw new TRPCError({ code: "BAD_REQUEST", message: "席位编号超出当前房型" });
      const existing = players.find((player) => player.userId === ctx.user.id);
      if (existing) {
        if (existing.team === input.team && existing.seat === input.seat) return roomView(tx, room.id, ctx.user.id, input.roomCode);
        throw new TRPCError({ code: "CONFLICT", message: "请先下到观众席，再选择其他席位" });
      }
      if (players.some((player) => player.team === input.team && player.seat === input.seat))
        throw new TRPCError({ code: "CONFLICT", message: "该席位刚被其他用户占用，请刷新后重试" });
      try {
        tx.insert(teamBattlePlayers).values({ roomId: room.id, userId: ctx.user.id, team: input.team, seat: input.seat }).run();
      } catch (error) {
        if (typeof error === "object" && error && "code" in error && String(error.code).startsWith("SQLITE_CONSTRAINT"))
          throw new TRPCError({ code: "CONFLICT", message: "席位已被占用或你已在其他席位" });
        throw error;
      }
      appendEvent(tx, room.id, "seat_taken", { team: input.team, seat: input.seat }, ctx.user.id, input.requestId);
      return roomView(tx, room.id, ctx.user.id, input.roomCode);
    })),

  leaveSeat: memberQuery.input(z.object({ roomId: ROOM_ID, roomCode: ROOM_CODE.optional(), requestId: REQUEST_ID }).strict()).mutation(({ ctx, input }) =>
    getDb().transaction((tx) => {
      const previous = eventRoomForRequest(tx, input.requestId, ctx.user.id, "seat_left");
      if (previous) {
        if (previous !== input.roomId) throw new TRPCError({ code: "CONFLICT", message: "请求编号已用于其他房间" });
        const priorRoom = roomOrThrow(tx, previous);
        return roomView(tx, previous, ctx.user.id, input.roomCode ?? priorRoom.code);
      }
      const room = roomOrThrow(tx, input.roomId);
      const players = playerRows(tx, room.id);
      ensureRoomAccess(room, players, ctx.user.id, input.roomCode);
      if (room.status !== "lobby" || room.rosterLocked) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "仅组队阶段可以下席" });
      const player = players.find((row) => row.userId === ctx.user.id);
      if (!player) throw new TRPCError({ code: "NOT_FOUND", message: "你当前在观众席" });
      tx.delete(teamBattlePlayers).where(eq(teamBattlePlayers.id, player.id)).run();
      appendEvent(tx, room.id, "seat_left", { team: player.team, seat: player.seat, ownerUnchanged: room.ownerId === ctx.user.id }, ctx.user.id, input.requestId);
      return roomView(tx, room.id, ctx.user.id, input.roomCode);
    })),

  lockRoster: memberQuery.input(z.object({ roomId: ROOM_ID, requestId: REQUEST_ID }).strict()).mutation(({ ctx, input }) =>
    getDb().transaction((tx) => {
      const previous = eventRoomForRequest(tx, input.requestId, ctx.user.id, "roster_locked");
      if (previous) return roomView(tx, previous, ctx.user.id);
      const room = roomOrThrow(tx, input.roomId);
      if (room.ownerId !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "仅房主可锁定阵容" });
      if (room.status !== "lobby") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "房间已不在组队阶段" });
      const players = playerRows(tx, room.id);
      const a = players.filter((player) => player.team === "A").length;
      const b = players.filter((player) => player.team === "B").length;
      if (a !== room.seatsPerTeam || b !== room.seatsPerTeam)
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `必须 A/B 两队各满 ${room.seatsPerTeam} 人才能锁定` });
      tx.update(teamBattleRooms).set({ status: "betting", rosterLocked: true, lockedAt: new Date() }).where(eq(teamBattleRooms.id, room.id)).run();
      appendEvent(tx, room.id, "roster_locked", { totalPlayers: players.length }, ctx.user.id, input.requestId);
      return roomView(tx, room.id, ctx.user.id);
    })),

  placeBet: memberQuery.input(z.object({ roomId: ROOM_ID, roomCode: ROOM_CODE.optional(), requestId: REQUEST_ID, team: SIDE, amount: z.number().positive().max(1_000_000) }).strict())
    .mutation(({ ctx, input }) => getDb().transaction((tx) => {
      assertModuleAvailable(tx, "teamBattle", ctx.user.id);
      let amountUnits: number;
      try { amountUnits = teamBattleDollarsToUnits(input.amount); }
      catch (error) { throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "金额无效" }); }
      const prior = tx.select().from(teamBattleBets).where(eq(teamBattleBets.requestId, input.requestId)).limit(1).get();
      if (prior) {
        if (prior.userId !== ctx.user.id || prior.roomId !== input.roomId || prior.team !== input.team || prior.amountUnits !== amountUnits)
          throw new TRPCError({ code: "CONFLICT", message: "请求编号已用于其他投注" });
        return roomView(tx, input.roomId, ctx.user.id, input.roomCode);
      }
      if (tx.select({ id: teamBattleEvents.id }).from(teamBattleEvents).where(eq(teamBattleEvents.requestId, input.requestId)).get())
        throw new TRPCError({ code: "CONFLICT", message: "请求编号已用于其他战队操作" });
      const room = roomOrThrow(tx, input.roomId);
      const players = playerRows(tx, room.id);
      ensureRoomAccess(room, players, ctx.user.id, input.roomCode);
      if (room.status !== "betting") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "投注已关闭" });
      const snapshot = parseSnapshot(room.configSnapshotJson);
      if (amountUnits <= 0 || amountUnits > snapshot.singleBetLimitUnits) throw new TRPCError({ code: "BAD_REQUEST", message: "超过单笔投注限制" });
      const player = players.find((row) => row.userId === ctx.user.id);
      if (player && player.team !== input.team) throw new TRPCError({ code: "FORBIDDEN", message: "选手只能押自己所在队" });
      const userTotal = Number(tx.select({ n: sql<number>`COALESCE(SUM(${teamBattleBets.amountUnits}), 0)` }).from(teamBattleBets)
        .where(and(eq(teamBattleBets.roomId, room.id), eq(teamBattleBets.userId, ctx.user.id))).get()?.n ?? 0);
      if (userTotal + amountUnits > snapshot.userBetLimitUnits) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "超过本房用户累计投注限制" });
      if (room.poolAUnits + room.poolBUnits + amountUnits > snapshot.roomBetLimitUnits) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "超过房间总奖池限制" });
      if (balanceUnits(tx, ctx.user.id) < amountUnits) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "余额不足" });
      const poolAAfter = room.poolAUnits + (input.team === "A" ? amountUnits : 0);
      const poolBAfter = room.poolBUnits + (input.team === "B" ? amountUnits : 0);
      const returnPpm = input.team === "A" ? projectedReturnPpm(poolAAfter, poolBAfter) : projectedReturnPpm(poolBAfter, poolAAfter);
      writeMoney(tx, room.id, ctx.user.id, -amountUnits, "bet_escrow", input.requestId, `战队房 ${room.code} 押 ${input.team} 队`);
      tx.insert(teamBattleBets).values({
        requestId: input.requestId, roomId: room.id, userId: ctx.user.id, team: input.team, amountUnits,
        poolABeforeUnits: room.poolAUnits, poolBBeforeUnits: room.poolBUnits, projectedReturnPpm: returnPpm,
      }).run();
      tx.update(teamBattleRooms).set({ poolAUnits: poolAAfter, poolBUnits: poolBAfter }).where(and(eq(teamBattleRooms.id, room.id), eq(teamBattleRooms.status, "betting"))).run();
      appendEvent(tx, room.id, "bet_placed", { team: input.team, amountUnits, poolAUnits: poolAAfter, poolBUnits: poolBAfter, projectedReturnPpm: returnPpm }, ctx.user.id, input.requestId);
      return roomView(tx, room.id, ctx.user.id, input.roomCode);
    })),

  vote: memberQuery.input(z.object({ roomId: ROOM_ID, requestId: REQUEST_ID, winnerTeam: SIDE }).strict()).mutation(({ ctx, input }) =>
    getDb().transaction((tx) => {
      const prior = tx.select().from(teamBattleVotes).where(eq(teamBattleVotes.requestId, input.requestId)).limit(1).get();
      if (prior) {
        if (prior.userId !== ctx.user.id || prior.roomId !== input.roomId || prior.winnerTeam !== input.winnerTeam)
          throw new TRPCError({ code: "CONFLICT", message: "请求编号已用于其他投票" });
        return roomView(tx, input.roomId, ctx.user.id);
      }
      if (tx.select({ id: teamBattleEvents.id }).from(teamBattleEvents).where(eq(teamBattleEvents.requestId, input.requestId)).get())
        throw new TRPCError({ code: "CONFLICT", message: "请求编号已用于其他战队操作" });
      const room = roomOrThrow(tx, input.roomId);
      if (room.status !== "betting" && room.status !== "voting") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "当前不能投票" });
      if (room.poolAUnits <= 0 || room.poolBUnits <= 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "两侧奖池均形成后才能投票" });
      const players = playerRows(tx, room.id);
      if (!players.some((player) => player.userId === ctx.user.id)) throw new TRPCError({ code: "FORBIDDEN", message: "仅在席选手可投票" });
      if (tx.select().from(teamBattleVotes).where(and(eq(teamBattleVotes.roomId, room.id), eq(teamBattleVotes.voteRound, room.voteRound), eq(teamBattleVotes.userId, ctx.user.id))).get())
        throw new TRPCError({ code: "CONFLICT", message: "本轮投票不可重复或更改" });
      const now = new Date();
      if (room.status === "betting") tx.update(teamBattleRooms).set({ status: "voting", bettingClosedAt: now })
        .where(and(eq(teamBattleRooms.id, room.id), eq(teamBattleRooms.status, "betting"))).run();
      tx.insert(teamBattleVotes).values({ requestId: input.requestId, roomId: room.id, voteRound: room.voteRound, userId: ctx.user.id, winnerTeam: input.winnerTeam }).run();
      const votes = tx.select().from(teamBattleVotes).where(and(eq(teamBattleVotes.roomId, room.id), eq(teamBattleVotes.voteRound, room.voteRound))).all();
      appendEvent(tx, room.id, "vote_cast", { voteRound: room.voteRound, submitted: votes.length, totalPlayers: players.length }, ctx.user.id, input.requestId);
      const threshold = teamBattleVoteThreshold(room.mode);
      const countA = votes.filter((vote) => vote.winnerTeam === "A").length;
      const countB = votes.filter((vote) => vote.winnerTeam === "B").length;
      if (countA >= threshold || countB >= threshold) settle(tx, room.id, countA >= threshold ? "A" : "B");
      else if (votes.length === players.length) {
        tx.update(teamBattleRooms).set({ status: "disputed", disputeReason: "全员投票完成但无一方达到过半阈值" }).where(eq(teamBattleRooms.id, room.id)).run();
        appendEvent(tx, room.id, "disputed", { voteRound: room.voteRound, submitted: votes.length, threshold });
      }
      return roomView(tx, room.id, ctx.user.id);
    })),

  adminControl: adminQuery.query(() => getDb().transaction((tx) => {
    const config = activeConfig(tx);
    const fund = Number(tx.select({ units: teamBattleFund.balanceUnits }).from(teamBattleFund).where(eq(teamBattleFund.id, 1)).get()?.units ?? 0);
    return { ...configSnapshot(config), singleBetLimit: teamBattleUnitsToDollars(config.singleBetLimitUnits), userBetLimit: teamBattleUnitsToDollars(config.userBetLimitUnits), roomBetLimit: teamBattleUnitsToDollars(config.roomBetLimitUnits), platformFundUnits: fund, platformFund: teamBattleUnitsToDollars(fund) };
  })),

  updateAdminConfig: adminQuery.input(z.object({ enabled: z.boolean(), singleBetLimit: z.number().positive().max(1_000_000), userBetLimit: z.number().positive().max(1_000_000), roomBetLimit: z.number().positive().max(10_000_000) }).strict())
    .mutation(({ input }) => getDb().transaction((tx) => {
      let single: number; let user: number; let room: number;
      try { single = teamBattleDollarsToUnits(input.singleBetLimit); user = teamBattleDollarsToUnits(input.userBetLimit); room = teamBattleDollarsToUnits(input.roomBetLimit); }
      catch (error) { throw new TRPCError({ code: "BAD_REQUEST", message: error instanceof Error ? error.message : "金额无效" }); }
      if (single > user || user > room) throw new TRPCError({ code: "BAD_REQUEST", message: "限制必须满足单笔 ≤ 单用户 ≤ 房间总额" });
      const version = Number(tx.select({ n: sql<number>`COALESCE(MAX(${teamBattleConfigs.version}), 0) + 1` }).from(teamBattleConfigs).get()?.n ?? 1);
      tx.update(teamBattleConfigs).set({ active: false }).where(eq(teamBattleConfigs.active, true)).run();
      const created = tx.insert(teamBattleConfigs).values({ version, active: true, enabled: input.enabled, singleBetLimitUnits: single, userBetLimitUnits: user, roomBetLimitUnits: room }).returning().get();
      tx.insert(adminLogs).values({ action: "更新战队对抗配置", detail: `v${version}；${input.enabled ? "启用" : "关闭"}；单笔 $${input.singleBetLimit}；用户 $${input.userBetLimit}；房间 $${input.roomBetLimit}` }).run();
      return configSnapshot(created);
    })),

  adminRoomsPage: adminQuery.input(paginationInput.extend({ mode: MODE.optional(), status: z.enum(["lobby", "betting", "voting", "settled", "disputed", "cancelled", "refunded"]).optional() }))
    .query(({ input }) => getDb().transaction((tx) => {
      const conditions = [];
      if (input.mode) conditions.push(eq(teamBattleRooms.mode, input.mode));
      if (input.status) conditions.push(eq(teamBattleRooms.status, input.status));
      const where = conditions.length ? and(...conditions) : undefined;
      const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(teamBattleRooms).where(where).get()?.n ?? 0);
      const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
      const items = tx.select().from(teamBattleRooms).where(where).orderBy(desc(teamBattleRooms.createdAt)).limit(pageSize).offset(offset).all();
      return paginatedResult(items, total, page, pageSize);
    })),

  adminBetsPage: adminQuery.input(paginationInput.extend({ roomId: ROOM_ID.optional(), userId: z.number().int().positive().optional(), team: SIDE.optional() }))
    .query(({ input }) => getDb().transaction((tx) => {
      const conditions = [];
      if (input.roomId) conditions.push(eq(teamBattleBets.roomId, input.roomId));
      if (input.userId) conditions.push(eq(teamBattleBets.userId, input.userId));
      if (input.team) conditions.push(eq(teamBattleBets.team, input.team));
      const where = conditions.length ? and(...conditions) : undefined;
      const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(teamBattleBets).where(where).get()?.n ?? 0);
      const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
      const items = tx.select().from(teamBattleBets).where(where).orderBy(desc(teamBattleBets.id)).limit(pageSize).offset(offset).all();
      return paginatedResult(items, total, page, pageSize);
    })),

  adminLedgerPage: adminQuery.input(paginationInput.extend({ roomId: ROOM_ID.optional(), userId: z.number().int().positive().optional(), type: z.string().trim().max(64).optional() }))
    .query(({ input }) => getDb().transaction((tx) => {
      const conditions = [];
      if (input.roomId) conditions.push(eq(teamBattleLedger.roomId, input.roomId));
      if (input.userId) conditions.push(eq(teamBattleLedger.userId, input.userId));
      if (input.type) conditions.push(eq(teamBattleLedger.type, input.type));
      const where = conditions.length ? and(...conditions) : undefined;
      const total = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(teamBattleLedger).where(where).get()?.n ?? 0);
      const { page, pageSize, offset } = resolvePagination(total, input.page, input.pageSize);
      const items = tx.select().from(teamBattleLedger).where(where).orderBy(desc(teamBattleLedger.id)).limit(pageSize).offset(offset).all();
      return paginatedResult(items, total, page, pageSize);
    })),

  adminRoom: adminQuery.input(z.object({ roomId: ROOM_ID })).query(({ input }) => getDb().transaction((tx) => {
    const view = roomView(tx, input.roomId, 0, undefined, true);
    const bets = tx.select().from(teamBattleBets).where(eq(teamBattleBets.roomId, input.roomId)).orderBy(asc(teamBattleBets.id)).all();
    const ledger = tx.select().from(teamBattleLedger).where(eq(teamBattleLedger.roomId, input.roomId)).orderBy(asc(teamBattleLedger.id)).all();
    return { ...view, bets, ledger };
  })),

  adminRefundDisputed: adminQuery.input(z.object({ roomId: ROOM_ID, requestId: REQUEST_ID, reason: z.string().trim().min(2).max(500) })).mutation(({ input }) =>
    getDb().transaction((tx) => {
      const prior = tx.select().from(teamBattleEvents).where(eq(teamBattleEvents.requestId, input.requestId)).limit(1).get();
      if (prior) {
        if (prior.roomId !== input.roomId || prior.type !== "dispute_refunded") throw new TRPCError({ code: "CONFLICT", message: "请求编号已用于其他管理操作" });
        return { ok: true, idempotent: true };
      }
      refundDisputed(tx, input.roomId, input.reason, input.requestId);
      tx.insert(adminLogs).values({ action: "战队争议作废退款", detail: `${input.roomId}；${input.reason}` }).run();
      return { ok: true, idempotent: false };
    })),

  adminReopenVoting: adminQuery.input(z.object({ roomId: ROOM_ID, requestId: REQUEST_ID, reason: z.string().trim().min(2).max(500) })).mutation(({ input }) =>
    getDb().transaction((tx) => {
      const prior = tx.select().from(teamBattleEvents).where(eq(teamBattleEvents.requestId, input.requestId)).limit(1).get();
      if (prior) {
        if (prior.roomId !== input.roomId || prior.type !== "voting_reopened") throw new TRPCError({ code: "CONFLICT", message: "请求编号已用于其他管理操作" });
        return { ok: true, voteRound: Number((JSON.parse(prior.payloadJson) as { voteRound?: number }).voteRound ?? 0), idempotent: true };
      }
      const room = roomOrThrow(tx, input.roomId);
      if (room.status !== "disputed") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "仅争议房可重开投票" });
      tx.update(teamBattleRooms).set({ status: "voting", voteRound: room.voteRound + 1, disputeReason: input.reason })
        .where(eq(teamBattleRooms.id, room.id)).run();
      appendEvent(tx, room.id, "voting_reopened", { previousRound: room.voteRound, voteRound: room.voteRound + 1, reason: input.reason }, null, input.requestId);
      tx.insert(adminLogs).values({ action: "战队争议重开投票", detail: `${room.code}；第 ${room.voteRound + 1} 轮；${input.reason}` }).run();
      return { ok: true, voteRound: room.voteRound + 1, idempotent: false };
    })),
});
