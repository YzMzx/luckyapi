import { TRPCError } from "@trpc/server";
import { and, eq, max, sql } from "drizzle-orm";
import { EXP_PER_USD, getLevelProgress, LEVEL_STAGES } from "@contracts/levels";
import { MONEY_SCALE, unitsFromMoney } from "@contracts/finance";
import {
  experienceEvents,
  levelBadges,
  levelProfiles,
  users,
} from "@db/schema";
import { getDb } from "./connection";

function readProfile(
  db: Pick<ReturnType<typeof getDb>, "select">,
  userId: number
) {
  const profile = db
    .select({
      totalExp: levelProfiles.totalExp,
      expRemainder: levelProfiles.expRemainder,
      equippedLevel: levelProfiles.equippedLevel,
    })
    .from(users)
    .leftJoin(levelProfiles, eq(users.id, levelProfiles.userId))
    .where(eq(users.id, userId))
    .get();
  if (!profile) throw new Error("用户不存在");
  return profile;
}

export function readLevelProfile(
  tx: Pick<ReturnType<typeof getDb>, "select">,
  userId: number
) {
  const profile = readProfile(tx, userId);
  const badges = tx
    .select({ level: levelBadges.level, rank: levelBadges.rank })
    .from(levelBadges)
    .where(eq(levelBadges.userId, userId))
    .orderBy(levelBadges.level)
    .all();
  return {
    progress: getLevelProgress(profile.totalExp ?? 0),
    badges,
    equippedLevel: profile.equippedLevel,
  };
}

export function getLevelProfile(userId: number) {
  return getDb().transaction(tx => readLevelProfile(tx, userId));
}

type AwardDb = Pick<ReturnType<typeof getDb>, "select" | "insert">;

/** Caller owns the SQLite transaction, including the underlying business event. */
function applyAward(
  tx: AwardDb,
  userId: number,
  eventKey: string,
  wholeExp: number,
  fractionalUnits: number,
  usdUnits: number | null
) {
  if (typeof eventKey !== "string" || !eventKey.trim())
    throw new Error("缺少经验事件标识");
  const profile = readProfile(tx, userId);
  const previous = profile.totalExp ?? 0;
  // Remainder is in millionths of one EXP, shared across all award sources.
  const fractions = (profile.expRemainder ?? 0) + fractionalUnits;
  const amount = wholeExp + Math.floor(fractions / MONEY_SCALE);
  const expRemainder = fractions % MONEY_SCALE;
  const now = Date.now();
  const event = tx
    .insert(experienceEvents)
    .values({ userId, eventKey, amount, usdUnits, createdAt: now })
    .onConflictDoNothing({
      target: [experienceEvents.userId, experienceEvents.eventKey],
    })
    .returning({ id: experienceEvents.id })
    .get();
  if (!event) {
    const existing = tx
      .select()
      .from(experienceEvents)
      .where(
        and(
          eq(experienceEvents.userId, userId),
          eq(experienceEvents.eventKey, eventKey)
        )
      )
      .get();
    // Replay the input, not the whole EXP computed with today's remainder.
    if (
      !existing ||
      existing.usdUnits !== usdUnits ||
      (usdUnits === null && existing.amount !== wholeExp)
    )
      throw new Error("同一事件的经验值不一致");
    return false;
  }
  const totalExp = previous + amount;
  if (!Number.isSafeInteger(totalExp)) throw new Error("累计经验超出范围");
  tx.insert(levelProfiles)
    .values({ userId, totalExp, expRemainder })
    .onConflictDoUpdate({
      target: levelProfiles.userId,
      set: { totalExp, expRemainder },
    })
    .run();
  const oldLevel = getLevelProgress(previous).level;
  const newLevel = getLevelProgress(totalExp).level;
  for (const { level } of LEVEL_STAGES) {
    if (level <= oldLevel || level > newLevel) continue;
    const seat = tx
      .select({ lastRank: max(levelBadges.rank) })
      .from(levelBadges)
      .where(eq(levelBadges.level, level))
      .get();
    const rank = (seat?.lastRank ?? 0) + 1;
    if (rank <= 3)
      tx.insert(levelBadges)
        .values({ level, rank, userId, eventId: event.id, awardedAt: now })
        .run();
  }
  return true;
}

export function awardExperienceInTransaction(
  tx: AwardDb,
  userId: number,
  eventKey: string,
  amount: number
) {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error("经验必须为正整数");
  return applyAward(tx, userId, eventKey, amount, 0, null);
}

function usdExperienceParts(units: number, source: keyof typeof EXP_PER_USD) {
  const unitsPerExp = MONEY_SCALE / EXP_PER_USD[source];
  return {
    wholeExp: Math.floor(units / unitsPerExp),
    fractionalUnits: (units % unitsPerExp) * EXP_PER_USD[source],
  };
}

/** Predict the whole EXP credited by a USD award without updating the profile. */
export function previewUsdExperience(
  db: Pick<ReturnType<typeof getDb>, "select">,
  userId: number,
  units: number,
  source: keyof typeof EXP_PER_USD
) {
  if (units === 0) return 0;
  const { wholeExp, fractionalUnits } = usdExperienceParts(units, source);
  const { expRemainder } = readProfile(db, userId);
  return (
    wholeExp + Math.floor(((expRemainder ?? 0) + fractionalUnits) / MONEY_SCALE)
  );
}

export function awardUsdExperience(
  tx: AwardDb,
  userId: number,
  eventKey: string,
  usdAmount: number,
  source: keyof typeof EXP_PER_USD
) {
  const units = unitsFromMoney(usdAmount);
  if (units <= 0) throw new Error("奖励金额必须为正数");
  const { wholeExp, fractionalUnits } = usdExperienceParts(units, source);
  return applyAward(
    tx,
    userId,
    `${source}:${eventKey}`,
    wholeExp,
    fractionalUnits,
    units
  );
}

/** Standalone entry point for trusted server-side grants. */
export function grantExperience(
  userId: number,
  eventKey: string,
  amount: number
) {
  return getDb().transaction(
    tx => awardExperienceInTransaction(tx, userId, eventKey, amount),
    { behavior: "immediate" }
  );
}

export function equipLevelBadge(userId: number, level: number | null) {
  const db = getDb();
  db.transaction(
    tx => {
      readProfile(tx, userId);
      if (level !== null) {
        const badge = tx
          .select({ level: levelBadges.level })
          .from(levelBadges)
          .where(
            and(eq(levelBadges.userId, userId), eq(levelBadges.level, level))
          )
          .get();
        if (!badge)
          throw new TRPCError({ code: "FORBIDDEN", message: "尚未获得该铭牌" });
      }
      tx.update(levelProfiles)
        .set({ equippedLevel: level })
        .where(eq(levelProfiles.userId, userId))
        .run();
    },
    { behavior: "immediate" }
  );
}

export function getLevelHall() {
  return getDb()
    .select({
      level: levelBadges.level,
      rank: levelBadges.rank,
      awardedAt: levelBadges.awardedAt,
      userName: sql<string>`coalesce(nullif(${users.groupName}, ''), ${users.username})`,
    })
    .from(levelBadges)
    .innerJoin(users, eq(users.id, levelBadges.userId))
    .orderBy(levelBadges.level, levelBadges.rank)
    .all();
}
