import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { duelLeaderboardPeriodBounds } from "@contracts/duel";

process.env.SQLITE_PATH = join(tmpdir(), `lucky-duel-leaderboard-${process.pid}-${Date.now()}.db`);

describe("duel winner and loser leaderboards", () => {
  it("ranks settled net results, returns out-of-page mine, filters periods/games/voids and protects privacy", async () => {
    const [{ getDb }, schema, { appRouter }] = await Promise.all([
      import("../queries/connection"),
      import("../../db/schema"),
      import("../router"),
    ]);
    const { users, sessions, adminSessions, adminLogs, duelRooms, duelPlayers, duelEvents } = schema;
    const db = getDb();
    const createdUsers = await db.insert(users).values(Array.from({ length: 28 }, (_, index) => ({
      linuxdoId: `duel-board-${index + 1}`,
      username: `duel-board-${index + 1}`,
      groupName: index === 27 ? null : `榜单玩家${String(index + 1).padStart(2, "0")}`,
      avatarUrl: index === 0 ? "data:image/svg+xml,unsafe" : `https://example.com/avatar-${index + 1}.png`,
      banned: index === 26,
      balance: 100,
    }))).returning();
    const currentIndex = 21;
    await db.insert(sessions).values({
      token: "duel-board-member",
      userId: createdUsers[currentIndex].id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await db.insert(adminSessions).values({ token: "duel-board-admin", expiresAt: new Date(Date.now() + 60_000) });

    const member = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_session=duel-board-member" } }),
      resHeaders: new Headers(),
    });
    const admin = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_admin=duel-board-admin" } }),
      resHeaders: new Headers(),
    });
    const anonymous = appRouter.createCaller({ req: new Request("http://localhost/api/trpc"), resHeaders: new Headers() });
    const today = duelLeaderboardPeriodBounds("today");
    const settledAt = new Date(today.startMs! + 60_000);
    let roomCounter = 0;
    const addResult = async ({
      userIndex, netUnits, game = "dice", result, at = settledAt, roomVoided = false, roomStatus = "settled",
    }: {
      userIndex: number;
      netUnits: number;
      game?: "dice" | "blackjack";
      result?: "win" | "loss" | "refund";
      at?: Date;
      roomVoided?: boolean;
      roomStatus?: "settled" | "refunded";
    }) => {
      roomCounter += 1;
      const roomId = randomUUID();
      const stakeUnits = 10_000_000;
      await db.insert(duelRooms).values({
        id: roomId,
        code: `B${String(roomCounter).padStart(5, "0")}`,
        game,
        visibility: "private",
        ownerId: createdUsers[userIndex].id,
        status: roomStatus,
        configId: 1,
        configVersion: roomCounter % 2 ? 1 : 2,
        configSnapshotJson: JSON.stringify({ winnerTaxBasisPoints: roomCounter % 2 ? 300 : 1_000 }),
        betUnits: stakeUnits,
        minPlayers: 2,
        maxPlayers: 2,
        winnerTaxBasisPoints: roomCounter % 2 ? 300 : 1_000,
        feeBasisPoints: roomCounter % 2 ? 300 : 1_000,
        potUnits: stakeUnits * 2,
        grossPrizePoolUnits: stakeUnits * 2,
        winnerTaxUnits: roomCounter % 2 ? 600_000 : 2_000_000,
        netPrizePoolUnits: roomCounter % 2 ? 19_400_000 : 18_000_000,
        feeUnits: roomCounter % 2 ? 600_000 : 2_000_000,
        finishedAt: at,
        voidedAt: roomVoided ? at : null,
        voidReason: roomVoided ? "测试异常房间" : null,
      });
      await db.insert(duelPlayers).values({
        roomId,
        userId: createdUsers[userIndex].id,
        gameType: game,
        seat: 1,
        status: result === "refund" ? "refunded" : result === "loss" || netUnits < 0 ? "lost" : "winner",
        stakeUnits,
        payoutUnits: stakeUnits + netUnits,
        settledNetUnits: netUnits,
        result: result ?? (netUnits < 0 ? "loss" : "win"),
        settledAt: at,
        voidedAt: roomVoided ? at : null,
      });
      return roomId;
    };

    // 22 个正收益玩家：当前用户排第 22，第一页仍需单独返回真实名次。
    const firstRoomId = await addResult({ userIndex: 0, netUnits: 22_000_000 });
    await addResult({ userIndex: 1, netUnits: 11_000_000 });
    await addResult({ userIndex: 1, netUnits: 11_000_000 }); // 同收益时胜场更多者优先
    for (let index = 2; index < 22; index += 1) {
      await addResult({ userIndex: index, netUnits: (22 - index) * 1_000_000 });
    }
    await addResult({ userIndex: 22, netUnits: -5_000_000 });
    await addResult({ userIndex: 23, netUnits: -3_000_000 });
    await addResult({ userIndex: 24, netUnits: -1_000_000 });
    await addResult({ userIndex: 25, netUnits: 0 }); // 零收益不上任何榜
    await addResult({ userIndex: 26, netUnits: 99_000_000 }); // 封禁用户排除
    await addResult({ userIndex: 27, netUnits: 98_000_000 }); // 未完成注册排除
    await addResult({ userIndex: 25, netUnits: 90_000_000, result: "refund", roomStatus: "refunded" });
    await addResult({ userIndex: 25, netUnits: 80_000_000, roomVoided: true });

    // 边界：today 的 start 包含，end 排除；不同玩法可独立筛选。
    await addResult({ userIndex: 0, netUnits: 50_000_000, game: "blackjack", at: new Date(today.startMs! - 1) });
    await addResult({ userIndex: 0, netUnits: 60_000_000, game: "blackjack", at: new Date(today.endMs!) });

    await expect(anonymous.duel.leaderboard({ board: "winner", period: "all", game: "all", page: 1 }))
      .rejects.toThrow("请先登录");

    const { grantExperience } = await import("../queries/levels");
    grantExperience(createdUsers[currentIndex].id, "duel-test", 80);
    const winners = await member.duel.leaderboard({ board: "winner", period: "today", game: "dice", page: 1 });
    expect(winners).toMatchObject({ page: 1, pageSize: 20, total: 22, totalPages: 2, metric: "税后净收益", timezone: "Asia/Shanghai" });
    expect(winners.rows).toHaveLength(20);
    expect(winners.rows[0].badge).toEqual({ level: 1, rank: null });
    expect(winners.mine.badge).toEqual({ level: 2, rank: null });
    expect(winners.rows[0]).toMatchObject({ groupName: "榜单玩家02", net: 22, wins: 2, games: 2, rank: 1 });
    expect(winners.rows[1]).toMatchObject({ groupName: "榜单玩家01", net: 22, wins: 1, rank: 2, avatarUrl: null });
    expect(winners.rows.some((row) => row.groupName === createdUsers[currentIndex].groupName)).toBe(false);
    expect(winners.mine).toMatchObject({ isRanked: true, rank: 22, groupName: createdUsers[currentIndex].groupName, net: 1 });
    expect(JSON.stringify({ rows: winners.rows, mine: winners.mine })).not.toMatch(/userId|linuxdo|balance|OAuth|data:image/);

    const secondPage = await member.duel.leaderboard({ board: "winner", period: "today", game: "dice", page: 2 });
    expect(secondPage.rows.map((row) => row.rank)).toEqual([21, 22]);

    const losers = await member.duel.leaderboard({ board: "loser", period: "today", game: "dice", page: 1 });
    expect(losers.mine.badge).toEqual(winners.mine.badge);
    expect(losers.rows.map((row) => [row.groupName, row.value])).toEqual([
      ["榜单玩家23", 5], ["榜单玩家24", 3], ["榜单玩家25", 1],
    ]);
    expect(losers.mine).toMatchObject({ isRanked: false, rank: null, net: 1, reason: "税后净收益未小于 0，未进入逆风榜" });

    const blackjackToday = await member.duel.leaderboard({ board: "winner", period: "today", game: "blackjack", page: 1 });
    expect(blackjackToday.total).toBe(0);
    const blackjackAll = await member.duel.leaderboard({ board: "winner", period: "all", game: "blackjack", page: 1 });
    expect(blackjackAll.rows[0]).toMatchObject({ groupName: "榜单玩家01", net: 110 });

    // 管理员只作废排行榜统计：财务快照/流水不反转，审计事件与日志保留。
    const voided = await admin.admin.voidDuelRoom({ roomId: firstRoomId, reason: "确认存在异常刷分" });
    expect(voided).toMatchObject({ ok: true, statisticsOnly: true });
    await expect(admin.admin.voidDuelRoom({ roomId: firstRoomId, reason: "再次尝试重复作废" })).rejects.toThrow("已经作废");
    const preserved = (await db.select().from(duelPlayers).where(eq(duelPlayers.roomId, firstRoomId)))[0];
    expect(preserved).toMatchObject({ result: "void", settledNetUnits: 22_000_000 });
    expect((await db.select().from(duelEvents).where(eq(duelEvents.roomId, firstRoomId))).some((event) => event.type === "admin_voided")).toBe(true);
    expect((await db.select().from(adminLogs)).some((log) => log.action === "作废决斗场排行榜统计")).toBe(true);
    const afterVoid = await member.duel.leaderboard({ board: "winner", period: "today", game: "dice", page: 1 });
    expect(afterVoid.total).toBe(21);
    expect(afterVoid.rows.some((row) => row.groupName === "榜单玩家01")).toBe(false);
  });
});
