import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "@db/schema";
import { users, transactions } from "@db/schema";
import { awardUsdExperience } from "./levels";

type LedgerDb = Pick<BetterSQLite3Database<typeof schema>, "select" | "insert">;

export type TxKind = "draw" | "checkin" | "video_reward" | "redeem" | "credit_expire" | "adjust" | "usage" | "duel" | "permanent_debit" | "transfer_out" | "transfer_in" | "loan_disbursement" | "loan_due" | "loan_repayment" | "loan_offer_refund" | "perp_exchange_in" | "perp_exchange_out";

/**
 * 记账：读取变动后的余额并写入流水。
 * better-sqlite3 是同步驱动，db 与事务 tx 都可用；调用方无须 await。
 * 调用方在余额变动后、同一事务内写入。混合本金/利息、押金/奖金或调整/退款的
 * 流水，由业务方明确传入其中的净获得额；缺省为零。
 */
export function recordTx(db: LedgerDb, userId: number, kind: TxKind, amount: number, note: string, netIncomeUsd = 0) {
  const bal =
    db.select({ b: users.balance }).from(users).where(eq(users.id, userId)).get()?.b ?? 0;
  const row = db.insert(transactions)
    .values({ userId, kind, amount, balanceAfter: Number(bal), note })
    .returning({ id: transactions.id }).get();
  const eventKey = `ledger:${row.id}`;
  if (kind === "usage" && amount < 0) {
    awardUsdExperience(db, userId, eventKey, -amount, "api_usage");
    return;
  }
  if (amount <= 0) return;
  switch (kind) {
    case "draw":
    case "checkin": // 签到奖励，或老虎机已扣除下注后的净变化
    case "video_reward":
    case "redeem":
      awardUsdExperience(db, userId, eventKey, amount, "income");
      break;
    case "duel":
    case "loan_repayment":
    case "perp_exchange_out":
    case "adjust":
      if (netIncomeUsd > 0) awardUsdExperience(db, userId, eventKey, netIncomeUsd, "income");
      break;
  }
}
