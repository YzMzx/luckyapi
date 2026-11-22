import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const dbFile = join(tmpdir(), `lucky-leaderboard-${process.pid}-${Date.now()}.db`);
process.env.SQLITE_PATH = dbFile;

describe("available balance leaderboard", () => {
  it("ranks by current balance and always returns the current user's rank", async () => {
    const [{ getDb }, { users, sessions, creditGrants }, { appRouter }] = await Promise.all([
      import("../queries/connection"),
      import("../../db/schema"),
      import("../router"),
    ]);
    const db = getDb();

    for (let index = 0; index < 25; index++) {
      await db.insert(users).values({
        linuxdoId: `ranked-${index}`,
        username: `ranked-${index}`,
        groupName: `榜友${index}`,
        balance: 100 - index,
        // 故意与余额反向，证明接口不再按抽奖累计所得排序。
        totalWon: index * 1000,
      });
    }
    const [mine] = await db.insert(users).values({
      linuxdoId: "mine",
      username: "mine-private-username",
      groupName: "我的群昵称",
      balance: 1,
      totalWon: 999999,
    }).returning();
    const [zero, negative, temporary] = await db.insert(users).values([
      { linuxdoId: "zero", username: "zero", groupName: "零余额", balance: 0, totalWon: 9999999 },
      { linuxdoId: "negative", username: "negative", groupName: "负资产", balance: -3, totalWon: 9999999 },
      { linuxdoId: "temporary", username: "temporary", groupName: "临时额度", balance: 50, totalWon: 9999999 },
      { linuxdoId: "banned", username: "banned", groupName: "已封禁", balance: 9999, totalWon: 1, banned: true },
      { linuxdoId: "unfinished", username: "unfinished", groupName: null, balance: 9999, totalWon: 1 },
    ]).returning();
    await db.insert(creditGrants).values({
      redemptionId: 97_001,
      codeId: 97_001,
      code: "TEMP-RANK",
      userId: temporary.id,
      originalUnits: 50_000_000,
      remainingUnits: 50_000_000,
      // 即使已经到期但清退任务尚未处理，remainingUnits 也不能变成榜单永久资产。
      expiresAt: new Date(Date.now() - 60_000),
    });
    await db.insert(sessions).values({
      token: "leaderboard-session",
      userId: mine.id,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const caller = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_session=leaderboard-session" } }),
      resHeaders: new Headers(),
    });
    const firstPage = await caller.member.leaderboard({ page: 1 });

    expect(firstPage.ranking.metric).toBe("permanent_available_balance");
    expect(firstPage.total).toBe(29);
    expect(firstPage.rows).toHaveLength(20);
    expect(firstPage.rows[0].balance).toBe(100);
    expect(firstPage.rows.some((row) => row.id === mine.id)).toBe(false);
    expect(firstPage.mine).toMatchObject({ rank: 26, isRanked: true, isOnPage: false, balance: 1 });
    expect(firstPage.rows[0]).not.toHaveProperty("username");
    expect(firstPage.rows[0]).not.toHaveProperty("linuxdoId");
    expect(firstPage.rows.some((row) => row.groupName === "已封禁")).toBe(false);

    expect(firstPage.rows[0].badge).toEqual({ level: 1, rank: null });
    const { grantExperience, equipLevelBadge } = await import("../queries/levels");
    const { getLevelThreshold } = await import("@contracts/levels");
    grantExperience(firstPage.rows[0].id, "rank-test", getLevelThreshold(10));
    equipLevelBadge(firstPage.rows[0].id, 10);
    grantExperience(mine.id, "rank-test", getLevelThreshold(21));
    await caller.levels.equip({ level: 10 });
    // Page two, the podium and the current member all contain different people.
    const queryBoard = () => caller.rankings.query({ category: "overall", board: "balance", period: "all", page: 2, pageSize: 5 });
    const prepared = vi.spyOn(db.$client, "prepare");
    let unified: Awaited<ReturnType<typeof queryBoard>>;
    try {
      unified = await queryBoard();
      expect(prepared.mock.calls.filter(([sql]) => /from "level_profiles"/i.test(sql))).toHaveLength(1);
    } finally {
      prepared.mockRestore();
    }
    expect(unified.rows.map(row => row.rank)).toEqual([6, 7, 8, 9, 10]);
    expect(unified.rows[0].badge).toEqual({ level: 1, rank: null });
    expect(unified.podium[0]).toMatchObject({ userId: firstPage.rows[0].id, rank: 1, badge: { level: 10, rank: 1 } });
    expect(unified.myRank).toMatchObject({ userId: mine.id, badge: { level: 10, rank: 2 } });
    await caller.levels.equip({ level: 20 });
    expect((await queryBoard()).myRank?.badge).toEqual({ level: 20, rank: 1 });
    await caller.levels.equip({ level: null });
    expect((await queryBoard()).myRank?.badge).toEqual({ level: 21, rank: null });

    const lastPage = await caller.member.leaderboard({ page: 2 });
    expect(lastPage.mine.badge).toEqual({ level: 21, rank: null });
    expect(lastPage.rows.find(row => row.id === mine.id)?.badge).toEqual(lastPage.mine.badge);
    expect(lastPage.rows.find((row) => row.id === temporary.id)?.balance).toBe(0);
    expect(lastPage.rows.find((row) => row.id === temporary.id)?.rank).toBe(28);
    expect(lastPage.rows.find((row) => row.id === zero.id)?.balance).toBe(0);
    expect(lastPage.rows.find((row) => row.id === negative.id)?.balance).toBe(-3);
    expect(lastPage.rows.at(-1)?.id).toBe(negative.id);

    await db.update(users).set({ balance: 0 }).where(eq(users.id, mine.id));
    const stillRanked = await caller.member.leaderboard({ page: 1 });
    expect(stillRanked.total).toBe(29);
    expect(stillRanked.mine).toMatchObject({ rank: 26, isRanked: true, balance: 0, unrankedReason: null });
  });
});
