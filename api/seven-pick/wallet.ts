import type Database from "better-sqlite3";
import {
  PerpInsufficientCashError,
  changePerpCash,
  readPerpCash,
} from "../perp/wallet";

type Db = Database.Database;
export type SevenPickLedgerKind = "stake" | "payout" | "refund";
export type SevenPickCashChange = {
  roundId: number;
  betId: number;
  userId: number;
  kind: SevenPickLedgerKind;
  deltaUnits: number;
  /** Time of the balance mutation, not the scheduled draw or original bet time. */
  now: number;
};
export class SevenPickInsufficientFundsError extends Error {}

export const readSevenPickCash = readPerpCash;

export function applySevenPickCash(db: Db, input: SevenPickCashChange) {
  if (!db.inTransaction) throw new Error("七星寻宝记账需要写事务");
  const { roundId, betId, userId, kind, deltaUnits, now } = input;
  if (
    ![roundId, betId, userId, now].every(
      n => Number.isSafeInteger(n) && n > 0
    ) ||
    !Number.isSafeInteger(deltaUnits) ||
    !["stake", "payout", "refund"].includes(kind) ||
    (kind === "stake" ? deltaUnits >= 0 : deltaUnits <= 0)
  )
    throw new Error("七星寻宝流水参数无效");

  // A savepoint keeps these two writes inseparable even if the caller handles
  // a validation or database error and continues its outer IMMEDIATE transaction.
  return db.transaction(() => {
    const rows = db
      .prepare<
        [number],
        {
          round_id: number;
          user_id: number;
          kind: SevenPickLedgerKind;
          delta_units: number;
          created_at: number;
        }
      >(
        "SELECT round_id,user_id,kind,delta_units,created_at FROM seven_pick_ledger WHERE bet_id=?"
      )
      .all(betId);
    const prior = rows.find(row => row.kind === kind);
    if (prior) {
      if (
        prior.round_id !== roundId ||
        prior.user_id !== userId ||
        prior.delta_units !== deltaUnits
      )
        throw new Error("七星寻宝流水幂等参数冲突");
      return { applied: false, cashUnits: readPerpCash(db, userId) };
    }

    const stakeUnits = db
      .prepare<[number, number, number], number>(
        "SELECT stake_units FROM seven_pick_bets WHERE id=? AND round_id=? AND user_id=?"
      )
      .pluck()
      .get(betId, roundId, userId);
    if (
      stakeUnits === undefined ||
      !Number.isSafeInteger(stakeUnits) ||
      stakeUnits <= 0
    )
      throw new Error("七星寻宝投注不存在或本金无效");
    if (
      (kind === "stake" && deltaUnits !== -stakeUnits) ||
      (kind === "refund" && deltaUnits !== stakeUnits)
    )
      throw new Error("七星寻宝记账金额与本金不符");
    if (kind !== "stake") {
      if (rows.some(row => row.kind !== "stake"))
        throw new Error("七星寻宝投注已完成资金处理");
      const stake = rows.find(row => row.kind === "stake");
      if (
        !stake ||
        stake.delta_units !== -stakeUnits ||
        stake.round_id !== roundId ||
        stake.user_id !== userId ||
        now < stake.created_at
      )
        throw new Error("七星寻宝投注扣款流水无效");
    }

    // Never silently backdate a wallet mutation into an immutable archive.
    // The table is optional for standalone wallet databases, not for app startup.
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='perp_weeks'"
        )
        .get()
    ) {
      const latest = db
        .prepare<[], number>(
          "SELECT week_end FROM perp_weeks ORDER BY week_start DESC LIMIT 1"
        )
        .pluck()
        .get();
      if (latest !== undefined && now < latest)
        throw new Error("七星寻宝流水不能写入已发布的合约周榜周期");
    }

    let cashUnits: number;
    try {
      cashUnits = changePerpCash(db, userId, deltaUnits);
    } catch (error) {
      if (error instanceof PerpInsufficientCashError)
        throw new SevenPickInsufficientFundsError(error.message);
      throw error;
    }
    db.prepare(
      "INSERT INTO seven_pick_ledger(round_id,bet_id,user_id,kind,delta_units,created_at) VALUES(?,?,?,?,?,?)"
    ).run(roundId, betId, userId, kind, deltaUnits, now);
    return { applied: true, cashUnits };
  })();
}
