import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "@db/schema";
import { users, transactions } from "@db/schema";

type LedgerDb = Pick<BetterSQLite3Database<typeof schema>, "select" | "insert">;

export type TxKind = "draw" | "checkin" | "video_reward" | "redeem" | "credit_expire" | "adjust" | "usage" | "duel" | "permanent_debit" | "transfer_out" | "transfer_in" | "loan_disbursement" | "loan_due" | "loan_repayment" | "loan_offer_refund";

/**
 * 记账：读取变动后的余额并写入流水。
 * better-sqlite3 是同步驱动，db 与事务 tx 都可用；调用方无须 await。
 * 注意：必须在余额变动之后调用。
 */
export function recordTx(db: LedgerDb, userId: number, kind: TxKind, amount: number, note: string) {
  const bal =
    db.select({ b: users.balance }).from(users).where(eq(users.id, userId)).get()?.b ?? 0;
  db.insert(transactions)
    .values({ userId, kind, amount, balanceAfter: Number(bal), note })
    .run();
}
