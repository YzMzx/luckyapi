import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

process.env.SQLITE_PATH = join(tmpdir(), `lucky-report-card-${process.pid}-${Date.now()}.db`);

describe("permanent report cards", () => {
  it("redeems integer uses, spends them only after free quota, and stays idempotent", async () => {
    const [{ getDb }, schema, { appRouter }] = await Promise.all([
      import("../queries/connection"),
      import("../../db/schema"),
      import("../router"),
    ]);
    const { users, sessions, adminSessions, inviteCodes, reportCardBalances, reportCardLedger, reports } = schema;
    const db = getDb();
    const [reporter, target] = await db.insert(users).values([
      { linuxdoId: "card-reporter", username: "card-reporter", groupName: "卡片举报人", balance: 100 },
      { linuxdoId: "card-target", username: "card-target", groupName: "卡片目标", balance: 100 },
    ]).returning();
    await db.insert(sessions).values({ token: "card-member", userId: reporter.id, expiresAt: new Date(Date.now() + 60_000) });
    await db.insert(adminSessions).values({ token: "card-admin", expiresAt: new Date(Date.now() + 60_000) });
    const member = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_session=card-member" } }),
      resHeaders: new Headers(),
    });
    const admin = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_admin=card-admin" } }),
      resHeaders: new Headers(),
    });

    await admin.admin.reportSettings.update({ taxPercent: 0, targetedDailyLimit: 0, randomDailyLimit: 0, successRatePercent: 100 });
    expect(await admin.admin.reportSettings.get()).toMatchObject({ successRatePercent: 100, targetedDailyLimit: 0, randomDailyLimit: 0 });
    await expect(admin.admin.generateInvites({ count: 1, type: "report", amount: 1.5, mode: "single" }))
      .rejects.toThrow("整数次数");
    const generated = await admin.admin.generateInvites({ count: 1, type: "report", amount: 2, mode: "single" });
    const code = generated.codes[0];
    expect((await db.select().from(inviteCodes).where(eq(inviteCodes.code, code)))[0]).toMatchObject({ type: "report", amount: 2, creditExpiresAt: null });

    const before = (await db.select().from(users).where(eq(users.id, reporter.id)))[0].balance;
    await expect(member.member.redeemCode({ code })).resolves.toMatchObject({ rewardType: "report_card", amount: 2 });
    expect((await db.select().from(users).where(eq(users.id, reporter.id)))[0].balance).toBe(before);
    const publicQuota = await member.member.reportQuota();
    expect(publicQuota).toMatchObject({ cardRemaining: 2, targeted: { remaining: 0, canReport: true } });
    expect("successRatePercent" in publicQuota).toBe(false);
    await expect(member.member.redeemCode({ code })).rejects.toThrow();

    const requestId = randomUUID();
    const first = await member.member.report({ requestId, targetUserId: target.id });
    expect(first).toMatchObject({ success: true, quotaSource: "card", idempotent: false });
    expect("successBasisPoints" in first).toBe(false);
    expect((await member.member.reportQuota()).cardRemaining).toBe(1);
    const repeated = await member.member.report({ requestId, targetUserId: target.id });
    expect(repeated).toMatchObject({ quotaSource: "card", idempotent: true });
    expect((await member.member.reportQuota()).cardRemaining).toBe(1);
    expect(await db.select().from(reports).where(eq(reports.requestId, requestId))).toHaveLength(1);
    expect(await db.select().from(reportCardLedger).where(eq(reportCardLedger.userId, reporter.id))).toHaveLength(2);
    expect((await db.select().from(reportCardBalances).where(eq(reportCardBalances.userId, reporter.id)))[0]).toMatchObject({ grantedCount: 2, consumedCount: 1, remainingCount: 1 });

    await admin.admin.reportSettings.update({ taxPercent: 0, targetedDailyLimit: 1, randomDailyLimit: 0, successRatePercent: 100 });
    await admin.admin.reportSettings.resetToday({ reason: "测试恢复免费次数" });
    const afterReset = await member.member.reportQuota();
    expect(afterReset).toMatchObject({ cardRemaining: 1, targeted: { used: 0, remaining: 1 } });
    const free = await member.member.report({ requestId: randomUUID(), targetUserId: target.id });
    expect(free.quotaSource).toBe("daily");
    expect((await member.member.reportQuota()).cardRemaining).toBe(1);
  });
});
