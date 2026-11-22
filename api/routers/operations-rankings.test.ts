import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

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
    expect(catalog.categories.map((item) => item.key)).toEqual(["overall", "api", "finance", "entertainment"]);
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
});
