import { TRPCError } from "@trpc/server";
import { and, eq, max, sql } from "drizzle-orm";
import { getLevelProgress, LEVEL_STAGES } from "@contracts/levels";
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
      equippedLevel: levelProfiles.equippedLevel,
    })
    .from(users)
    .leftJoin(levelProfiles, eq(users.id, levelProfiles.userId))
    .where(eq(users.id, userId))
    .get();
  if (!profile) throw new Error("用户不存在");
  return profile;
}

export function getLevelProfile(userId: number) {
  const db = getDb();
  return db.transaction(tx => {
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
  });
}

/** Trusted server-side entry point. Event keys must be stable across retries and namespaced by source. */
export function grantExperience(
  userId: number,
  eventKey: string,
  amount: number
) {
  if (typeof eventKey !== "string" || !eventKey.trim())
    throw new Error("缺少经验事件标识");
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error("经验必须为正整数");
  const db = getDb();
  return db.transaction(
    tx => {
      const previous = readProfile(tx, userId).totalExp ?? 0;
      const now = Date.now();
      const event = tx
        .insert(experienceEvents)
        .values({ userId, eventKey, amount, createdAt: now })
        .onConflictDoNothing({
          target: [experienceEvents.userId, experienceEvents.eventKey],
        })
        .returning({ id: experienceEvents.id })
        .get();
      if (!event) {
        const existing = tx
          .select({ amount: experienceEvents.amount })
          .from(experienceEvents)
          .where(
            and(
              eq(experienceEvents.userId, userId),
              eq(experienceEvents.eventKey, eventKey)
            )
          )
          .get();
        if (existing?.amount !== amount)
          throw new Error("同一事件的经验值不一致");
        return false;
      }
      const totalExp = previous + amount;
      if (!Number.isSafeInteger(totalExp)) throw new Error("累计经验超出范围");
      tx.insert(levelProfiles)
        .values({ userId, totalExp })
        .onConflictDoUpdate({ target: levelProfiles.userId, set: { totalExp } })
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
    },
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
