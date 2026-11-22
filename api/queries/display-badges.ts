import { and, eq, inArray } from "drizzle-orm";
import { getLevelProgress, type DisplayLevelBadge } from "@contracts/levels";
import { levelBadges, levelProfiles } from "@db/schema";
import type { getDb } from "./connection";

/** Resolve the visible members together, after ranking and pagination. The lookup lives for one response. */
export function readDisplayBadges(
  db: Pick<ReturnType<typeof getDb>, "select">,
  userIds: readonly number[]
) {
  const badges = new Map<number, DisplayLevelBadge>();
  const ids = [...new Set(userIds)];
  if (ids.length) {
    const profiles = db
      .select({
        userId: levelProfiles.userId,
        totalExp: levelProfiles.totalExp,
        level: levelBadges.level,
        rank: levelBadges.rank,
      })
      .from(levelProfiles)
      .leftJoin(
        levelBadges,
        and(
          eq(levelBadges.userId, levelProfiles.userId),
          eq(levelBadges.level, levelProfiles.equippedLevel)
        )
      )
      .where(inArray(levelProfiles.userId, ids))
      .all();
    for (const { userId, totalExp, level, rank } of profiles) {
      const badge =
        level !== null && (rank === 1 || rank === 2 || rank === 3)
          ? ({ level, rank } as const)
          : { level: getLevelProgress(totalExp).level, rank: null };
      badges.set(userId, badge);
    }
  }
  return (id: number): DisplayLevelBadge =>
    badges.get(id) ?? { level: 1, rank: null };
}
