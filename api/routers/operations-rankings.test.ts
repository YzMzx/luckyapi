import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

process.env.SQLITE_PATH = join(tmpdir(), `lucky-operations-rankings-${process.pid}-${Date.now()}.db`);

describe("unified rankings and operational controls", () => {
  it("returns stable real-data rankings and enforces audited module and user controls", async () => {
    const [{ getDb }, schema, { appRouter }] = await Promise.all([import("../queries/connection"), import("../../db/schema"), import("../router")]);
    const db = getDb();
    const [adminUser, other] = await db.insert(schema.users).values([
      { linuxdoId: "990001", username: "private-one", groupName: "榜单一号", balance: 20 },
      { linuxdoId: "990002", username: "private-two", groupName: "榜单二号", balance: 10 },
    ]).returning();
    await db.insert(schema.sessions).values({ token: "ops-user", userId: adminUser.id, expiresAt: new Date(Date.now() + 60_000) });
    await db.insert(schema.adminSessions).values({ token: "ops-admin", expiresAt: new Date(Date.now() + 60_000) });
    await db.insert(schema.usageLogs).values([
      { userId: adminUser.id, requestId: "ops-usage-1", model: "m1", status: "ok", cost: 1.5, promptTokens: 100, completionTokens: 50, durationMs: 200, ttftMs: 50 },
      { userId: other.id, requestId: "ops-usage-2", model: "m1", status: "ok", cost: 0.5, promptTokens: 10, completionTokens: 10, durationMs: 100, ttftMs: 30 },
    ]);
    const user = appRouter.createCaller({ req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_session=ops-user" } }), resHeaders: new Headers() });
    const admin = appRouter.createCaller({ req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_admin=ops-admin" } }), resHeaders: new Headers() });

    const catalog = await user.rankings.catalog();
    expect(catalog.categories.map((item) => item.key)).toEqual(["overall", "api", "finance", "entertainment", "contracts"]);
    const retiredBoards = ["report_wins", "report_income", "team_wins", "team_bet_net"];
    for (const board of retiredBoards) {
      expect(catalog.boards.some((item) => item.key === board)).toBe(false);
      await expect(user.rankings.query({ category: "entertainment", board, period: "week", page: 1, pageSize: 20 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(catalog.boards.some((item) => item.key === "duel_wins")).toBe(true);
    const spending = await user.rankings.query({ category: "api", board: "spend", period: "today", page: 1, pageSize: 20 });
    expect(spending.rows[0]).toMatchObject({ displayName: "榜单一号", metric: 1.5, rank: 1 });
    expect(spending.rows[0]).not.toHaveProperty("username");
    expect(spending.myRank?.rank).toBe(1);

    const state = await admin.admin.control.get();
    const authSettings = await admin.admin.authSettings.get();
    expect(authSettings).not.toHaveProperty("primaryClientSecret");
    expect(authSettings).not.toHaveProperty("adminPassword");
    await expect(admin.admin.authSettings.update({
      primaryOrigin: "https://entry.example.com/path",
      primaryClientId: "client-id",
      adminUsername: "admin",
    })).rejects.toThrow("只能填写协议和域名");
    await admin.admin.control.update({ ...state, modules: { ...state.modules, transfer: false }, reason: "测试关闭转账" });
    await expect(user.finance.transfer({ accountId: other.linuxdoId, amount: 1, requestId: "ops-transfer-1" })).rejects.toThrow("转账功能当前已由管理员关闭");
    await admin.admin.control.update({ ...state, reason: "测试恢复转账" });
    await admin.admin.userPolicy.update({ userId: adminUser.id, allFrozen: false, apiFrozen: false, financeFrozen: true, entertainmentFrozen: false, apiDailySpendLimit: null, apiKeyLimit: null, apiConcurrencyLimit: null, transferDailyLimit: null, lendingDailyLimit: null, outstandingBorrowLimit: null });
    await expect(user.finance.transfer({ accountId: other.linuxdoId, amount: 1, requestId: "ops-transfer-2" })).rejects.toThrow("金融权限已被冻结");
    const details = await admin.admin.userDetail({ userId: adminUser.id });
    expect(details.policy.financeFrozen).toBe(true);
    expect(details.levelProfile).toEqual({ progress: { level: 1, totalExp: 0, currentExp: 0, requiredExp: 80 }, badges: [], equippedLevel: null });
    await expect(user.admin.userDetail({ userId: other.id })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(admin.admin.userDetail({ userId: 99999 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { grantExperience, equipLevelBadge } = await import("../queries/levels");
    const { getLevelThreshold, MAX_LEVEL } = await import("@contracts/levels");
    const totalExp = getLevelThreshold(MAX_LEVEL);
    grantExperience(other.id, "admin-detail-test", totalExp);
    equipLevelBadge(other.id, 10);
    const otherDetails = await admin.admin.userDetail({ userId: other.id });
    expect(otherDetails.levelProfile.progress).toEqual({ level: MAX_LEVEL, totalExp, currentExp: 0, requiredExp: null });
    expect(otherDetails.levelProfile.equippedLevel).toBe(10);
    expect(otherDetails.levelProfile.badges).toContainEqual({ level: 10, rank: 1 });
    await admin.admin.userPolicy.update({ userId: adminUser.id, allFrozen: true, apiFrozen: false, financeFrozen: false, entertainmentFrozen: false, apiDailySpendLimit: null, apiKeyLimit: null, apiConcurrencyLimit: null, transferDailyLimit: null, lendingDailyLimit: null, outstandingBorrowLimit: null });
    await expect(user.finance.transfer({ accountId: other.linuxdoId, amount: 1, requestId: "ops-transfer-all-frozen" })).rejects.toThrow("金融权限已被冻结");
    const allFrozenDetails = await admin.admin.userDetail({ userId: adminUser.id });
    expect(allFrozenDetails.policy.allFrozen).toBe(true);
    expect((await db.select().from(schema.adminLogs)).some((row) => row.action === "更新运营控制")).toBe(true);
  });

  it("ranks contract fills in simulated USDT using business-day bounds and global personal ranks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-15T03:00:00+08:00"));
    try {
      const [{ getDb }, schema, { appRouter }, { SETTING_KEYS }] = await Promise.all([
        import("../queries/connection"), import("../../db/schema"), import("../router"), import("../settings"),
      ]);
      const db = getDb();
      for (const [key, value] of [[SETTING_KEYS.businessTimezoneOffsetMinutes, "480"], [SETTING_KEYS.businessDayStartHour, "4"]]) {
        await db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
      }
      const [leader, runner, tiedLater, tiedEarlier, fifth, mine, flat, negative, banned, unregistered] = await db.insert(schema.users).values(
        Array.from({ length: 10 }, (_, index) => ({
          linuxdoId: "contract-rank-" + index, username: "contract-private-" + index,
          groupName: index === 9 ? null : "合约用户" + index, banned: index === 8, balance: 98765,
        })),
      ).returning();
      await db.insert(schema.sessions).values({ token: "contract-rank-member", userId: mine.id, expiresAt: new Date(Date.now() + 60_000) });
      const member = appRouter.createCaller({
        req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_session=contract-rank-member" } }), resHeaders: new Headers(),
      });
      const dayStart = Date.parse("2026-03-14T04:00:00+08:00");
      const dayEnd = Date.parse("2026-03-15T04:00:00+08:00");
      const weekStart = Date.parse("2026-03-08T04:00:00+08:00");
      const monthStart = Date.parse("2026-03-01T04:00:00+08:00");
      const insertOrder = db.$client.prepare(
        "INSERT INTO perp_orders(user_id,symbol,action,side,quantity_atoms,leverage,price_units,mark_units,fee_units,pnl_units,created_at) VALUES (?,'BTCUSDT',?,'long',100000000,10,100000,100000,?,?,?)",
      );
      const order = (userId: number, action: "openLong" | "close" | "liquidate", pnl: number, fee: number, createdAt = dayStart) =>
        insertOrder.run(userId, action, fee, pnl, createdAt);
      order(leader.id, "close", 12_500, 175);
      order(leader.id, "close", -2_000, 125);
      order(leader.id, "close", 600, 300);
      order(runner.id, "close", 7_000, 250);
      order(tiedLater.id, "close", 4_000, 111, dayStart + 1);
      order(tiedEarlier.id, "close", 4_000, 111);
      order(fifth.id, "close", 2_000, 100);
      order(mine.id, "close", 1_234, 123);
      order(flat.id, "close", 25, 25);
      order(negative.id, "close", 1_000, 10);
      order(negative.id, "close", -1_000, 10);
      order(banned.id, "close", 90_000, 0);
      order(unregistered.id, "close", 90_000, 0);
      // The upper bound is exclusive. Earlier orders enter on the exact week/month lower bounds.
      order(leader.id, "close", 1_000, 0, dayStart - 1);
      order(leader.id, "close", 2_000, 0, weekStart);
      order(leader.id, "close", 4_000, 0, weekStart - 1);
      order(leader.id, "close", 8_000, 0, monthStart);
      order(leader.id, "close", 16_000, 0, monthStart - 1);
      order(leader.id, "close", 32_000, 0, dayEnd);
      order(leader.id, "liquidate", -1_250, 250);
      order(leader.id, "liquidate", 450, 573);
      order(leader.id, "liquidate", 500, 250); // Positive PnL on this fill must not offset another liquidation's loss.
      order(runner.id, "liquidate", -900, 100);
      order(mine.id, "liquidate", 50, 50);
      order(leader.id, "openLong", 0, 50_000);

      const catalog = await member.rankings.catalog();
      expect(catalog.categories).toContainEqual({ key: "contracts", label: "合约" });
      expect(catalog.boards.filter((board) => board.category === "contracts")).toEqual([
        expect.objectContaining({ key: "liquidation_loss", title: "爆仓亏损榜", unit: "sim", periods: ["today", "week", "month", "all"] }),
        expect.objectContaining({ key: "closed_profit", title: "平仓盈利榜", unit: "sim", periods: ["today", "week", "month", "all"] }),
      ]);
      const today = await member.rankings.query({ category: "contracts", board: "closed_profit", period: "today", pageSize: 5 });
      expect(today).toMatchObject({ board: { unit: "sim" }, total: 6, page: 1, totalPages: 2, periodStart: new Date(dayStart), periodEnd: new Date(dayEnd) });
      expect(today.rows.map(({ userId, rank, metric }) => [userId, rank, metric])).toEqual([
        [leader.id, 1, 10.5], [runner.id, 2, 6.75], [tiedEarlier.id, 3, 3.889], [tiedLater.id, 4, 3.889], [fifth.id, 5, 1.9],
      ]);
      expect(today.podium).toEqual(today.rows.slice(0, 3));
      expect(today.myRank).toMatchObject({ userId: mine.id, rank: 6, metric: 1.111 });
      const lastPage = await member.rankings.query({ category: "contracts", board: "closed_profit", period: "today", page: 99, pageSize: 5 });
      expect(lastPage.page).toBe(2);
      expect(lastPage.rows).toEqual([today.myRank]);
      expect(lastPage.podium).toEqual(today.podium);
      for (const [period, start, metric] of [["week", weekStart, 13.5], ["month", monthStart, 25.5], ["all", null, 73.5]] as const) {
        const result = await member.rankings.query({ category: "contracts", board: "closed_profit", period });
        expect(result).toMatchObject({ period, periodStart: start === null ? null : new Date(start), periodEnd: start === null ? null : new Date(dayEnd) });
        expect(result.rows[0]).toMatchObject({ userId: leader.id, metric });
      }
      const liquidations = await member.rankings.query({ category: "contracts", board: "liquidation_loss", period: "today" });
      expect(liquidations).toMatchObject({ board: { unit: "sim" }, total: 2, myRank: null });
      expect(liquidations.rows.map(({ userId, rank, metric }) => [userId, rank, metric])).toEqual([
        [leader.id, 1, 1.623], [runner.id, 2, 1],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
