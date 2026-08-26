import { and, asc, eq, gt, lte } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "@db/schema";
import { creditGrantLedger, creditGrants, users } from "@db/schema";
import { recordTx } from "./ledger";
import type { TxKind } from "./ledger";

export const CREDIT_GRANT_SCALE = 1_000_000;

type CreditDb = Pick<BetterSQLite3Database<typeof schema>, "select" | "insert" | "update">;

export function creditDollarsToUnits(amount: number) {
  const units = Math.round(amount * CREDIT_GRANT_SCALE);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(units) || Math.abs(amount * CREDIT_GRANT_SCALE - units) > 1e-6)
    throw new Error("额度金额最多支持 6 位小数");
  return units;
}

export function creditUnitsToDollars(units: number) {
  if (!Number.isSafeInteger(units)) throw new Error("额度单位无效");
  return units / CREDIT_GRANT_SCALE;
}

function userBalanceUnits(db: CreditDb, userId: number) {
  const value = db.select({ balance: users.balance }).from(users).where(eq(users.id, userId)).limit(1).get()?.balance;
  if (value === undefined) throw new Error("用户不存在");
  const units = Math.round(Number(value) * CREDIT_GRANT_SCALE);
  if (!Number.isFinite(Number(value)) || !Number.isSafeInteger(units)) throw new Error("余额单位无效");
  return units;
}

export function createTimedCreditGrant(db: CreditDb, input: {
  redemptionId: number;
  codeId: number;
  code: string;
  userId: number;
  amountUnits: number;
  expiresAt: Date;
}) {
  if (input.expiresAt.getTime() <= Date.now()) throw new Error("额度失效时间必须晚于兑换时间");
  const grant = db.insert(creditGrants).values({
    redemptionId: input.redemptionId,
    codeId: input.codeId,
    code: input.code,
    userId: input.userId,
    originalUnits: input.amountUnits,
    remainingUnits: input.amountUnits,
    expiresAt: input.expiresAt,
  }).returning().get();
  db.insert(creditGrantLedger).values({
    grantId: grant.id,
    userId: input.userId,
    type: "grant",
    amountUnits: input.amountUnits,
    remainingAfterUnits: input.amountUnits,
    sourceKind: "redeem",
    note: `兑换码 ${input.code} 限时额度到账`,
  }).run();
  return grant;
}

/** 在调用方 SQLite 事务中清退指定用户已到期额度。 */
export function expireUserCreditGrants(db: CreditDb, userId: number, now = new Date()) {
  const active = db.select().from(creditGrants).where(and(
    eq(creditGrants.userId, userId),
    eq(creditGrants.status, "active"),
    gt(creditGrants.remainingUnits, 0),
  )).orderBy(asc(creditGrants.expiresAt), asc(creditGrants.id)).all();
  const expired = active.filter((grant) => grant.expiresAt.getTime() <= now.getTime());
  const balanceBeforeUnits = userBalanceUnits(db, userId);
  if (!expired.length) return { expiredGrantCount: 0, expiredUnits: 0, balanceAfter: creditUnitsToDollars(balanceBeforeUnits) };

  const totalExpiredUnits = expired.reduce((sum, grant) => sum + grant.remainingUnits, 0);
  // remainingUnits is the still-unspent portion already included in users.balance.
  // Removing that exact amount preserves permanent funds, including a negative
  // permanent balance created by an overdue peer loan.
  const removableUnits = totalExpiredUnits;
  let removalLeft = removableUnits;
  for (const grant of expired) {
    const removed = Math.min(grant.remainingUnits, removalLeft);
    removalLeft -= removed;
    db.update(creditGrants).set({
      remainingUnits: 0,
      expiredUnits: grant.expiredUnits + grant.remainingUnits,
      status: "expired",
      expiredAt: now,
    }).where(and(eq(creditGrants.id, grant.id), eq(creditGrants.status, "active"))).run();
    db.insert(creditGrantLedger).values({
      grantId: grant.id,
      userId,
      type: "expire",
      amountUnits: -removed,
      remainingAfterUnits: 0,
      sourceKind: "credit_expire",
      note: removed === grant.remainingUnits ? "限时额度到期清退" : "限时额度到期清退（余额保护修正）",
    }).run();
  }
  const balanceAfterUnits = balanceBeforeUnits - removableUnits;
  db.update(users).set({ balance: creditUnitsToDollars(balanceAfterUnits) }).where(eq(users.id, userId)).run();
  if (removableUnits > 0) recordTx(db, userId, "credit_expire", -creditUnitsToDollars(removableUnits), `限时额度到期清退（${expired.length} 笔）`);
  return { expiredGrantCount: expired.length, expiredUnits: removableUnits, balanceAfter: creditUnitsToDollars(balanceAfterUnits) };
}

/** 转账和放贷只允许消耗永久额度，避免把有时效的临时额度洗成他人的永久额度。 */
export function debitPermanentBalance(db: CreditDb, input: {
  userId: number;
  amount: number;
  note: string;
  kind?: TxKind;
  now?: Date;
}) {
  const amountUnits = creditDollarsToUnits(input.amount);
  if (amountUnits <= 0) throw new Error("扣款金额必须大于 0");
  const now = input.now ?? new Date();
  expireUserCreditGrants(db, input.userId, now);
  const rawBalance = db.select({ balance: users.balance }).from(users).where(eq(users.id, input.userId)).limit(1).get()?.balance;
  if (rawBalance === undefined) throw new Error("用户不存在");
  const balanceUnits = Math.round(Number(rawBalance) * CREDIT_GRANT_SCALE);
  if (!Number.isFinite(Number(rawBalance)) || !Number.isSafeInteger(balanceUnits)) throw new Error("余额单位无效");
  const activeGrants = db.select({ remainingUnits: creditGrants.remainingUnits }).from(creditGrants).where(and(
    eq(creditGrants.userId, input.userId),
    eq(creditGrants.status, "active"),
    gt(creditGrants.remainingUnits, 0),
    gt(creditGrants.expiresAt, now),
  )).all();
  const temporaryUnits = activeGrants.reduce((sum, grant) => sum + grant.remainingUnits, 0);
  const permanentUnits = balanceUnits - temporaryUnits;
  if (permanentUnits < amountUnits) throw new Error("可转移的永久额度不足（临时额度不能转移或放贷）");
  const balanceAfterUnits = balanceUnits - amountUnits;
  db.update(users).set({ balance: creditUnitsToDollars(balanceAfterUnits) }).where(eq(users.id, input.userId)).run();
  recordTx(db, input.userId, input.kind ?? "permanent_debit", -input.amount, input.note);
  return {
    amount: input.amount,
    balanceBefore: creditUnitsToDollars(balanceUnits),
    balanceAfter: creditUnitsToDollars(balanceAfterUnits),
    permanentBefore: creditUnitsToDollars(permanentUnits),
  };
}

/** 集中余额扣款：先懒清退，再按最早到期顺序消耗临时额度，剩余部分才消耗永久余额。 */
export function debitUserBalance(db: CreditDb, input: {
  userId: number;
  amount: number;
  sourceKind: string;
  requestId?: string | null;
  note: string;
  now?: Date;
}) {
  const amountUnits = creditDollarsToUnits(input.amount);
  if (amountUnits <= 0) throw new Error("扣款金额必须大于 0");
  const now = input.now ?? new Date();
  expireUserCreditGrants(db, input.userId, now);
  const balanceBeforeUnits = userBalanceUnits(db, input.userId);
  if (balanceBeforeUnits < amountUnits) throw new Error("余额不足");
  let left = amountUnits;
  let temporaryUnits = 0;
  const grants = db.select().from(creditGrants).where(and(
    eq(creditGrants.userId, input.userId),
    eq(creditGrants.status, "active"),
    gt(creditGrants.remainingUnits, 0),
    gt(creditGrants.expiresAt, now),
  )).orderBy(asc(creditGrants.expiresAt), asc(creditGrants.id)).all();
  for (const grant of grants) {
    if (left <= 0) break;
    const consumed = Math.min(left, grant.remainingUnits);
    const remaining = grant.remainingUnits - consumed;
    left -= consumed;
    temporaryUnits += consumed;
    db.update(creditGrants).set({
      consumedUnits: grant.consumedUnits + consumed,
      remainingUnits: remaining,
      status: remaining === 0 ? "exhausted" : "active",
      exhaustedAt: remaining === 0 ? now : null,
    }).where(and(eq(creditGrants.id, grant.id), eq(creditGrants.status, "active"))).run();
    db.insert(creditGrantLedger).values({
      grantId: grant.id,
      userId: input.userId,
      type: "consume",
      amountUnits: -consumed,
      remainingAfterUnits: remaining,
      sourceKind: input.sourceKind,
      requestId: input.requestId ?? null,
      note: input.note,
    }).run();
  }
  const balanceAfterUnits = balanceBeforeUnits - amountUnits;
  db.update(users).set({ balance: creditUnitsToDollars(balanceAfterUnits) }).where(eq(users.id, input.userId)).run();
  return {
    balanceBefore: creditUnitsToDollars(balanceBeforeUnits),
    balanceAfter: creditUnitsToDollars(balanceAfterUnits),
    temporaryConsumed: creditUnitsToDollars(temporaryUnits),
    permanentConsumed: creditUnitsToDollars(amountUnits - temporaryUnits),
  };
}

/**
 * Reverse one escrow debit without turning consumed temporary credit into permanent credit.
 * The original debit must have a stable requestId. Unexpired grant consumption is restored
 * to the same grant; temporary credit whose absolute expiry has passed is deliberately not
 * credited. Only the permanent portion of the original debit returns as permanent balance.
 */
export function reverseUserBalanceDebit(db: CreditDb, input: {
  userId: number;
  amount: number;
  sourceKind: string;
  requestId: string;
  note: string;
  now?: Date;
}) {
  const amountUnits = creditDollarsToUnits(input.amount);
  if (amountUnits <= 0) throw new Error("退款金额必须大于 0");
  const now = input.now ?? new Date();
  expireUserCreditGrants(db, input.userId, now);
  const entries = db.select().from(creditGrantLedger).where(and(
    eq(creditGrantLedger.userId, input.userId),
    eq(creditGrantLedger.sourceKind, input.sourceKind),
    eq(creditGrantLedger.requestId, input.requestId),
  )).orderBy(asc(creditGrantLedger.id)).all();
  const consumedByGrant = new Map<number, number>();
  const restoredByGrant = new Map<number, number>();
  for (const entry of entries) {
    if (entry.type === "consume" && entry.amountUnits < 0)
      consumedByGrant.set(entry.grantId, (consumedByGrant.get(entry.grantId) ?? 0) - entry.amountUnits);
    if (entry.type === "restore" && entry.amountUnits > 0)
      restoredByGrant.set(entry.grantId, (restoredByGrant.get(entry.grantId) ?? 0) + entry.amountUnits);
  }
  const temporaryOriginalUnits = [...consumedByGrant.values()].reduce((sum, units) => sum + units, 0);
  if (temporaryOriginalUnits > amountUnits) throw new Error("退款审计金额与原扣款不一致");
  const permanentUnits = amountUnits - temporaryOriginalUnits;
  let restoredTemporaryUnits = 0;
  let expiredTemporaryUnits = 0;
  for (const [grantId, consumedUnits] of consumedByGrant) {
    const unrestoredUnits = consumedUnits - (restoredByGrant.get(grantId) ?? 0);
    if (unrestoredUnits <= 0) continue;
    const grant = db.select().from(creditGrants).where(and(
      eq(creditGrants.id, grantId),
      eq(creditGrants.userId, input.userId),
    )).limit(1).get();
    if (!grant || grant.expiresAt.getTime() <= now.getTime()) {
      expiredTemporaryUnits += unrestoredUnits;
      continue;
    }
    const remaining = grant.remainingUnits + unrestoredUnits;
    db.update(creditGrants).set({
      consumedUnits: Math.max(0, grant.consumedUnits - unrestoredUnits),
      remainingUnits: remaining,
      status: "active",
      exhaustedAt: null,
    }).where(eq(creditGrants.id, grant.id)).run();
    db.insert(creditGrantLedger).values({
      grantId: grant.id,
      userId: input.userId,
      type: "restore",
      amountUnits: unrestoredUnits,
      remainingAfterUnits: remaining,
      sourceKind: input.sourceKind,
      requestId: input.requestId,
      note: input.note,
    }).run();
    restoredTemporaryUnits += unrestoredUnits;
  }
  const creditedUnits = permanentUnits + restoredTemporaryUnits;
  if (creditedUnits > 0) {
    const balanceBeforeUnits = userBalanceUnits(db, input.userId);
    db.update(users).set({ balance: creditUnitsToDollars(balanceBeforeUnits + creditedUnits) })
      .where(eq(users.id, input.userId)).run();
  }
  return {
    credited: creditUnitsToDollars(creditedUnits),
    permanentRestored: creditUnitsToDollars(permanentUnits),
    temporaryRestored: creditUnitsToDollars(restoredTemporaryUnits),
    expiredTemporary: creditUnitsToDollars(expiredTemporaryUnits),
  };
}

export function expireAllCreditGrants(db: CreditDb, now = new Date()) {
  const userIds = db.select({ userId: creditGrants.userId }).from(creditGrants).where(and(
    eq(creditGrants.status, "active"),
    gt(creditGrants.remainingUnits, 0),
    lte(creditGrants.expiresAt, now),
  )).groupBy(creditGrants.userId).all();
  return userIds.reduce((summary, row) => {
    const result = expireUserCreditGrants(db, row.userId, now);
    summary.users += 1;
    summary.grants += result.expiredGrantCount;
    summary.units += result.expiredUnits;
    return summary;
  }, { users: 0, grants: 0, units: 0 });
}
