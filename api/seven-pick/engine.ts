import { createHash, randomBytes } from "node:crypto";
import { env } from "node:process";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  beijingDayStart,
  getSevenPickConfig,
  MINUTE_MS,
  SEVEN_PICK_ITEMS,
  SEVEN_PICK_MAX_BETS,
  SEVEN_PICK_MAX_STAKE_UNITS,
  SEVEN_PICK_MIN_STAKE_UNITS,
  SEVEN_PICK_NAME,
  SEVEN_PICK_SIZE,
  type SevenPickItem,
} from "./config";
import { QUICKNET, quicknetRoundAtOrAfter, quicknetRoundTimeMs } from "./drand";
import { DRAW_ALGORITHM_VERSION } from "./draw";
import {
  calculateSevenPickMaxExposure,
  sevenPickItemMask,
  type SevenPickRiskBet,
} from "./risk";
import {
  applySevenPickCash,
  getSevenPickRiskLimitUnits,
  readSevenPickCash,
  SevenPickInsufficientFundsError,
} from "./wallet";

// Configuration/editor switches are NOT a release override. Only change this
// blocked release state after end-to-end verification of independent OTS timing.
const BETTING_ENABLED = false;

export class SevenPickError extends Error {
  readonly code:
    | "BETTING_DISABLED"
    | "INVALID_INPUT"
    | "ROUND_NOT_FOUND"
    | "ROUND_CLOSED"
    | "IDEMPOTENCY_CONFLICT"
    | "DUPLICATE_COMBINATION"
    | "BET_LIMIT"
    | "INSUFFICIENT_FUNDS"
    | "RISK_LIMIT";

  constructor(code: SevenPickError["code"], message: string) {
    super(message);
    this.name = "SevenPickError";
    this.code = code;
  }
}

export type SevenPickRoundStatus =
  | "scheduled"
  | "open"
  | "sealed"
  | "ots_waiting"
  | "review"
  | "risk_skipped"
  | "settled"
  | "refunding"
  | "refunded";

type RoundRow = {
  id: number;
  configVersionId: number;
  status: SevenPickRoundStatus;
  enabled: 0 | 1;
  opensAt: number;
  closesAt: number;
  drawAt: number;
  quicknetRound: number;
  quicknetScheduledAt: number;
  quicknetNetwork: string;
  quicknetChainHash: string;
  quicknetPublicKey: string;
  quicknetScheme: string;
  algorithmVersion: string;
  minStakeUnits: number;
  maxStakeUnits: number;
  multipliersJson: string;
};
type RiskRow = { limitUnits: number; maxExposureUnits: number };
export type SevenPickRound = Omit<RoundRow, "enabled" | "multipliersJson"> & {
  multipliers: number[];
  items: SevenPickItem[];
  riskLimitUnits: string | null;
  maxExposureUnits: string | null;
};

const SELECT_ROUND =
  "SELECT id,config_version_id AS configVersionId,status,enabled,opens_at AS opensAt, " +
  "closes_at AS closesAt,draw_at AS drawAt,quicknet_round AS quicknetRound, " +
  "quicknet_scheduled_at AS quicknetScheduledAt,quicknet_network AS quicknetNetwork, " +
  "quicknet_chain_hash AS quicknetChainHash,quicknet_public_key AS quicknetPublicKey, " +
  "quicknet_scheme AS quicknetScheme,algorithm_version AS algorithmVersion,min_stake_units AS minStakeUnits, " +
  "max_stake_units AS maxStakeUnits,multipliers_json AS multipliersJson FROM seven_pick_rounds";

function readRisk(db: Database.Database, roundId: number): RiskRow | undefined {
  const risk = db
    .prepare<[number], RiskRow>(
      "SELECT limit_units AS limitUnits,max_exposure_units AS maxExposureUnits FROM seven_pick_risk WHERE round_id=?"
    )
    .get(roundId);
  if (
    risk &&
    (!Number.isSafeInteger(risk.limitUnits) ||
      !Number.isSafeInteger(risk.maxExposureUnits))
  ) {
    throw new Error("七星寻宝风控数据溢出");
  }
  return risk;
}

const roundMultipliers = z
  .array(z.number().int().min(0).max(1_000_000))
  .length(8);
function readMultipliers(row: RoundRow) {
  return roundMultipliers.parse(JSON.parse(row.multipliersJson));
}

function roundView(db: Database.Database, row: RoundRow): SevenPickRound {
  const items = db
    .prepare<[number], SevenPickItem>(
      "SELECT item_id AS id,name,description,position,image_url AS imageUrl FROM seven_pick_round_items WHERE round_id=? ORDER BY position"
    )
    .all(row.id);
  if (items.length !== SEVEN_PICK_ITEMS)
    throw new Error("七星寻宝场次物品快照不完整");
  const risk = readRisk(db, row.id);
  return {
    id: row.id,
    configVersionId: row.configVersionId,
    status: row.status,
    opensAt: row.opensAt,
    closesAt: row.closesAt,
    drawAt: row.drawAt,
    quicknetRound: row.quicknetRound,
    quicknetScheduledAt: row.quicknetScheduledAt,
    quicknetNetwork: row.quicknetNetwork,
    quicknetChainHash: row.quicknetChainHash,
    quicknetPublicKey: row.quicknetPublicKey,
    quicknetScheme: row.quicknetScheme,
    algorithmVersion: row.algorithmVersion,
    minStakeUnits: row.minStakeUnits,
    maxStakeUnits: row.maxStakeUnits,
    multipliers: readMultipliers(row),
    items,
    riskLimitUnits: risk?.limitUnits.toString() ?? null,
    maxExposureUnits: risk?.maxExposureUnits.toString() ?? null,
  };
}

export function getSevenPickRound(
  db: Database.Database,
  roundId: number
): SevenPickRound | null {
  return db.transaction(() => {
    const round = db
      .prepare<[number], RoundRow>(SELECT_ROUND + " WHERE id=?")
      .get(roundId);
    return round ? roundView(db, round) : null;
  })();
}

export function getSevenPickSnapshot(
  db: Database.Database,
  nowMs = Date.now()
) {
  const round = db.transaction(() => {
    const active = db
      .prepare<[number, number], RoundRow>(
        SELECT_ROUND +
          " WHERE opens_at<=? AND closes_at>? ORDER BY opens_at DESC LIMIT 1"
      )
      .get(nowMs, nowMs);
    const next =
      active ??
      db
        .prepare<[number], RoundRow>(
          SELECT_ROUND + " WHERE opens_at>? ORDER BY opens_at LIMIT 1"
        )
        .get(nowMs);
    const row =
      next ??
      db
        .prepare<[], RoundRow>(SELECT_ROUND + " ORDER BY opens_at DESC LIMIT 1")
        .get();
    return row ? roundView(db, row) : null;
  })();
  return {
    name: SEVEN_PICK_NAME,
    now: nowMs,
    bettingEnabled:
      BETTING_ENABLED &&
      round?.status === "open" &&
      nowMs >= round.opensAt &&
      nowMs < round.closesAt,
    round,
  };
}

export function createSevenPickRound(
  db: Database.Database,
  opensAt: number,
  nowMs = Date.now()
): SevenPickRound {
  const minuteOfDay = (opensAt - beijingDayStart(opensAt)) / MINUTE_MS;
  return db
    .transaction(() => {
      const existing = db
        .prepare<[number], RoundRow>(SELECT_ROUND + " WHERE opens_at=?")
        .get(opensAt);
      if (existing) return roundView(db, existing);
      if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || nowMs > opensAt)
        throw new SevenPickError("INVALID_INPUT", "须在开盘前创建场次快照");
      const config = getSevenPickConfig(db, opensAt);
      if (
        !config.enabled ||
        config.id === null ||
        !config.openMinutes.includes(minuteOfDay)
      )
        throw new SevenPickError(
          "BETTING_DISABLED",
          "此时间没有启用的七星寻宝场次"
        );
      const closesAt = opensAt + config.closeAfterMinutes * MINUTE_MS;
      const drawAt = opensAt + config.drawAfterMinutes * MINUTE_MS;
      const quicknetRound = quicknetRoundAtOrAfter(drawAt);
      const result = db
        .prepare(
          "INSERT INTO seven_pick_rounds (config_version_id,status,enabled,opens_at,closes_at,draw_at,quicknet_round," +
            "quicknet_scheduled_at,quicknet_network,quicknet_chain_hash,quicknet_public_key,quicknet_scheme,algorithm_version," +
            "min_stake_units,max_stake_units,multipliers_json,created_at) VALUES (?, 'scheduled', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          config.id,
          opensAt,
          closesAt,
          drawAt,
          quicknetRound,
          quicknetRoundTimeMs(quicknetRound),
          QUICKNET.network,
          QUICKNET.chainHash,
          QUICKNET.publicKey,
          QUICKNET.scheme,
          DRAW_ALGORITHM_VERSION,
          config.minStakeUnits,
          config.maxStakeUnits,
          JSON.stringify(config.multipliers),
          nowMs
        );
      const roundId = Number(result.lastInsertRowid);
      const itemInsert = db.prepare(
        "INSERT INTO seven_pick_round_items(round_id,item_id,name,description,position,image_url) VALUES (?,?,?,?,?,?)"
      );
      for (const item of config.items)
        itemInsert.run(
          roundId,
          item.id,
          item.name,
          item.description,
          item.position,
          item.imageUrl
        );
      return roundView(
        db,
        db
          .prepare<[number], RoundRow>(SELECT_ROUND + " WHERE id=?")
          .get(roundId)!
      );
    })
    .immediate();
}

function readRoundBets(db: Database.Database, roundId: number) {
  return db
    .prepare<[number], SevenPickRiskBet>(
      "SELECT item_mask AS itemMask, stake_units AS stakeUnits FROM seven_pick_bets WHERE round_id=?"
    )
    .iterate(roundId);
}

function refundSkippedBets(
  db: Database.Database,
  roundId: number,
  nowMs: number
) {
  const unpaid = db
    .prepare<[number], { betId: number; userId: number; stakeUnits: number }>(
      "SELECT b.id AS betId,b.user_id AS userId,b.stake_units AS stakeUnits " +
        "FROM seven_pick_ledger AS stake JOIN seven_pick_bets b ON b.id=stake.bet_id " +
        "WHERE stake.round_id=? AND stake.kind='stake' AND NOT EXISTS (" +
        "SELECT 1 FROM seven_pick_ledger final WHERE final.bet_id=b.id AND final.kind='refund') ORDER BY b.id"
    )
    .all(roundId);
  for (const b of unpaid)
    applySevenPickCash(db, {
      roundId,
      betId: b.betId,
      userId: b.userId,
      kind: "refund",
      deltaUnits: b.stakeUnits,
      now: nowMs,
    });
}

// Activation runs once, in the same serialized DB stream as wallet writes.
// Re-running on a risk-skipped round only resumes anomaly refunds, never reopens it.
export function openSevenPickRound(
  db: Database.Database,
  roundId: number,
  nowMs = Date.now()
): SevenPickRound {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0)
    throw new RangeError("无效时间");
  const activated = db
    .transaction(() => {
      const select = db.prepare<[number], RoundRow>(
        SELECT_ROUND + " WHERE id=?"
      );
      const round = select.get(roundId);
      if (!round) throw new SevenPickError("ROUND_NOT_FOUND", "场次不存在");
      if (round.status !== "scheduled") return roundView(db, round);
      if (!round.enabled || nowMs < round.opensAt || nowMs >= round.closesAt)
        throw new SevenPickError("ROUND_CLOSED", "场次不在开盘时段");
      const odds = readMultipliers(round);
      const savedRisk = readRisk(db, roundId);
      const limitUnits =
        savedRisk?.limitUnits ?? getSevenPickRiskLimitUnits(db);
      const skipped =
        BigInt(limitUnits) <
        BigInt(round.minStakeUnits) * BigInt(odds[SEVEN_PICK_SIZE]);
      if (!savedRisk) {
        db.prepare(
          "INSERT INTO seven_pick_risk(round_id,limit_units,max_exposure_units,locked_at) VALUES (?,?,0,?)"
        ).run(roundId, limitUnits, nowMs);
      }
      if (skipped) {
        db.prepare(
          "UPDATE seven_pick_rounds SET status='risk_skipped' WHERE id=?"
        ).run(roundId);
      } else {
        const currentExposure = calculateSevenPickMaxExposure(
          readRoundBets(db, roundId),
          odds
        );
        if (currentExposure > BigInt(limitUnits))
          throw new SevenPickError("RISK_LIMIT", "场次已有投注超过风控额度");
        db.prepare(
          "UPDATE seven_pick_risk SET max_exposure_units=? WHERE round_id=?"
        ).run(Number(currentExposure), roundId);
        db.prepare("UPDATE seven_pick_rounds SET status='open' WHERE id=?").run(
          roundId
        );
      }
      return roundView(db, select.get(roundId)!);
    })
    .immediate();
  if (activated.status === "risk_skipped") {
    // Persist the no-open decision independently: a ledger failure must not
    // let a later wallet top-up reopen this round. Retrying activation resumes
    // the refund; the same transaction couples each cash change to its journal.
    db.transaction(() => refundSkippedBets(db, roundId, nowMs)).immediate();
  }
  return activated;
}

const amountInput = z
  .string()
  .max(7)
  .refine(
    value =>
      value === value.trim() && /^(?:0|[1-9]\d{0,2})(?:\.\d{1,3})?$/.test(value)
  );
const positiveId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const sevenPickPlaceInput = z.strictObject({
  roundId: positiveId,
  requestKey: z
    .string()
    .min(1)
    .max(128)
    .refine(key => !/[^A-Za-z0-9_.:-]/.test(key)),
  bets: z
    .array(
      z.strictObject({
        itemIds: z
          .array(z.number().int().min(1).max(SEVEN_PICK_ITEMS))
          .length(SEVEN_PICK_SIZE),
        amount: amountInput,
      })
    )
    .min(1)
    .max(SEVEN_PICK_MAX_BETS),
});
export type SevenPickPlaceInput = z.infer<typeof sevenPickPlaceInput>;

type PrivateBetRow = {
  id: number;
  combinationKey: string;
  stakeUnits: number;
  receiptId: string;
};
export type SevenPickOrder = {
  id: number;
  roundId: number;
  requestKey: string;
  createdAt: number;
  totalStakeUnits: number;
  bets: {
    id: number;
    itemIds: number[];
    stakeUnits: number;
    receiptId: string;
  }[];
};
type OrderRow = Omit<SevenPickOrder, "bets"> & { payloadHash: string };
const SELECT_ORDER =
  "SELECT id,round_id AS roundId,request_key AS requestKey,created_at AS createdAt," +
  "total_stake_units AS totalStakeUnits,payload_hash AS payloadHash FROM seven_pick_orders";

function orderView(db: Database.Database, row: OrderRow): SevenPickOrder {
  const bets = db
    .prepare<[number], PrivateBetRow>(
      "SELECT id,combination_key AS combinationKey,stake_units AS stakeUnits,receipt_id AS receiptId " +
        "FROM seven_pick_bets WHERE order_id=? ORDER BY id"
    )
    .all(row.id)
    .map(({ combinationKey, ...bet }) => ({
      ...bet,
      itemIds: JSON.parse(combinationKey) as number[],
    }));
  return {
    id: row.id,
    roundId: row.roundId,
    requestKey: row.requestKey,
    createdAt: row.createdAt,
    totalStakeUnits: row.totalStakeUnits,
    bets,
  };
}

export function listSevenPickOrders(
  db: Database.Database,
  userId: number,
  limit = 50
): SevenPickOrder[] {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(userId) ||
    userId < 1
  )
    throw new RangeError("无效订单查询");
  return db.transaction(() =>
    db
      .prepare<[number, number], OrderRow>(
        SELECT_ORDER + " WHERE user_id=? ORDER BY id DESC LIMIT ?"
      )
      .all(userId, limit)
      .map(row => orderView(db, row))
  )();
}

export function placeSevenPickOrder(
  db: Database.Database,
  userId: number,
  input: unknown,
  nowMs?: number
): SevenPickOrder {
  if (!BETTING_ENABLED)
    throw new SevenPickError(
      "BETTING_DISABLED",
      "独立时间证明尚未验证通过，暂不接受投注"
    );
  return placeOrder(db, userId, input, nowMs);
}

/** Internal integration entry point. Never wire this function into a public router. */
export function placeSevenPickOrderForTest(
  db: Database.Database,
  userId: number,
  input: unknown,
  nowMs?: number
): SevenPickOrder {
  if (env.NODE_ENV !== "test")
    throw new SevenPickError("BETTING_DISABLED", "仅用于自动化测试");
  return placeOrder(db, userId, input, nowMs);
}

function placeOrder(
  db: Database.Database,
  userId: number,
  input: unknown,
  nowMs?: number
): SevenPickOrder {
  const parsed = sevenPickPlaceInput.safeParse(input);
  if (!parsed.success || !Number.isSafeInteger(userId) || userId <= 0)
    throw new SevenPickError(
      "INVALID_INPUT",
      "投注参数无效，金额最多支持三位小数"
    );
  const { roundId, requestKey } = parsed.data;
  const bets = parsed.data.bets.map(bet => {
    const [integer, fractional = ""] = bet.amount.split(".");
    const stakeUnits =
      Number(integer) * 1000 + Number(fractional.padEnd(3, "0"));
    if (
      stakeUnits < SEVEN_PICK_MIN_STAKE_UNITS ||
      stakeUnits > SEVEN_PICK_MAX_STAKE_UNITS
    )
      throw new SevenPickError("INVALID_INPUT", "投注金额须在 1–100 USDT 之间");
    if (new Set(bet.itemIds).size !== SEVEN_PICK_SIZE)
      throw new SevenPickError("INVALID_INPUT", "每组须选择七个不同物品");
    const itemIds = [...bet.itemIds].sort((a, b) => a - b);
    return {
      combinationKey: JSON.stringify(itemIds),
      itemMask: sevenPickItemMask(itemIds),
      stakeUnits,
    };
  });
  bets.sort((a, b) => a.itemMask - b.itemMask);
  if (new Set(bets.map(bet => bet.itemMask)).size !== bets.length)
    throw new SevenPickError(
      "DUPLICATE_COMBINATION",
      "同场不能重复投注相同组合"
    );
  const payloadHash = createHash("sha256")
    .update(
      JSON.stringify([
        "seven-pick-order-v1",
        roundId,
        bets.map(b => [b.combinationKey, b.stakeUnits]),
      ])
    )
    .digest("hex");
  const totalStakeUnits = bets.reduce(
    (total, bet) => total + bet.stakeUnits,
    0
  );
  try {
    return db
      .transaction(() => {
        const prior = db
          .prepare<[number, string], OrderRow>(
            SELECT_ORDER + " WHERE user_id=? AND request_key=?"
          )
          .get(userId, requestKey);
        if (prior) {
          if (prior.payloadHash !== payloadHash)
            throw new SevenPickError(
              "IDEMPOTENCY_CONFLICT",
              "请求键已用于不同订单"
            );
          return orderView(db, prior);
        }
        const round = db
          .prepare<[number], RoundRow>(SELECT_ROUND + " WHERE id=?")
          .get(roundId);
        if (!round) throw new SevenPickError("ROUND_NOT_FOUND", "场次不存在");
        const assertOpen = () => {
          const time = nowMs ?? Date.now();
          if (
            !Number.isSafeInteger(time) ||
            !round.enabled ||
            round.status !== "open" ||
            time < round.opensAt ||
            time >= round.closesAt
          )
            throw new SevenPickError("ROUND_CLOSED", "场次未开放或已封盘");
          return time;
        };
        assertOpen();
        if (
          bets.some(
            bet =>
              bet.stakeUnits < round.minStakeUnits ||
              bet.stakeUnits > round.maxStakeUnits
          )
        )
          throw new SevenPickError("INVALID_INPUT", "金额超出本场投注限额");
        const existing = db
          .prepare<[number, number], string>(
            "SELECT combination_key FROM seven_pick_bets WHERE round_id=? AND user_id=?"
          )
          .pluck()
          .all(roundId, userId);
        if (bets.some(bet => existing.includes(bet.combinationKey)))
          throw new SevenPickError(
            "DUPLICATE_COMBINATION",
            "同场不能重复投注相同组合"
          );
        if (existing.length + bets.length > SEVEN_PICK_MAX_BETS)
          throw new SevenPickError("BET_LIMIT", "每场最多投注五组");
        if (readSevenPickCash(db, userId) < totalStakeUnits)
          throw new SevenPickError("INSUFFICIENT_FUNDS", "模拟钱包余额不足");
        const risk = readRisk(db, roundId);
        if (!risk)
          throw new SevenPickError("ROUND_CLOSED", "场次尚未锁定风控额度");
        const all = function* () {
          yield* readRoundBets(db, roundId);
          yield* bets;
        };
        const exposure = calculateSevenPickMaxExposure(
          all(),
          readMultipliers(round)
        );
        if (exposure > BigInt(risk.limitUnits))
          throw new SevenPickError(
            "RISK_LIMIT",
            "新增订单将超过本场最大潜在返还额度"
          );
        // Recheck after the in-transaction risk calculation: do not debit if the
        // placement window elapsed while SQLite was processing this order.
        const createdAt = assertOpen();
        const id = Number(
          db
            .prepare(
              "INSERT INTO seven_pick_orders(round_id,user_id,request_key,payload_hash,total_stake_units,created_at) " +
                "VALUES (?,?,?,?,?,?)"
            )
            .run(
              roundId,
              userId,
              requestKey,
              payloadHash,
              totalStakeUnits,
              createdAt
            ).lastInsertRowid
        );
        const insertBet = db.prepare(
          "INSERT INTO seven_pick_bets(order_id,round_id,user_id,combination_key,item_mask,stake_units,receipt_id,created_at) " +
            "VALUES (?,?,?,?,?,?,?,?)"
        );
        for (const bet of bets) {
          const betId = Number(
            insertBet.run(
              id,
              roundId,
              userId,
              bet.combinationKey,
              bet.itemMask,
              bet.stakeUnits,
              randomBytes(16).toString("hex"),
              createdAt
            ).lastInsertRowid
          );
          applySevenPickCash(db, {
            roundId,
            betId,
            userId,
            kind: "stake",
            deltaUnits: -bet.stakeUnits,
            now: createdAt,
          });
        }
        db.prepare(
          "UPDATE seven_pick_risk SET max_exposure_units=? WHERE round_id=?"
        ).run(Number(exposure), roundId);
        return orderView(db, {
          id,
          roundId,
          requestKey,
          payloadHash,
          totalStakeUnits,
          createdAt,
        });
      })
      .immediate();
  } catch (error) {
    if (error instanceof SevenPickInsufficientFundsError)
      throw new SevenPickError("INSUFFICIENT_FUNDS", "模拟钱包余额不足");
    throw error;
  }
}
