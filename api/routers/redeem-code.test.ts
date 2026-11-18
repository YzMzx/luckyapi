import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

process.env.SQLITE_PATH = join(tmpdir(), `lucky-redeem-code-${process.pid}-${Date.now()}.db`);

describe("redeem code modes and cleanup", () => {
  it("enforces single-use, per-account uniqueness, total limits and audit-safe cleanup", async () => {
    const [{ getDb }, schema, { appRouter }] = await Promise.all([
      import("../queries/connection"),
      import("../../db/schema"),
      import("../router"),
    ]);
    const { users, sessions, adminSessions, inviteCodes, codeRedemptions, transactions, adminLogs } = schema;
    const db = getDb();
    const createdUsers = await db.insert(users).values([
      { linuxdoId: "redeemer-1", username: "redeemer-1", groupName: "兑换者一" },
      { linuxdoId: "redeemer-2", username: "redeemer-2", groupName: "兑换者二" },
      { linuxdoId: "redeemer-3", username: "redeemer-3", groupName: "兑换者三" },
    ]).returning();
    await db.insert(sessions).values(createdUsers.map((user, index) => ({
      token: `member-${index + 1}`,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    })));
    await db.insert(adminSessions).values({ token: "admin", expiresAt: new Date(Date.now() + 60_000) });

    const caller = (token: string) => appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: `ld_session=${token}` } }),
      resHeaders: new Headers(),
    });
    const member1 = caller("member-1");
    const member2 = caller("member-2");
    const member3 = caller("member-3");
    const admin = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_admin=admin" } }),
      resHeaders: new Headers(),
    });

    const [single, reusable, unlimited, unused, usedSingleDelete, partialReusable, racingReusable] = await db.insert(inviteCodes).values([
      { code: "LD-SINGLE", type: "redeem", amount: 5, mode: "single" },
      { code: "LD-MULTI-2", type: "redeem", amount: 3, mode: "reusable", maxUses: 2 },
      { code: "LD-UNLIMITED", type: "redeem", amount: 2, mode: "reusable", maxUses: null },
      { code: "LD-UNUSED", type: "redeem", amount: 1, mode: "single" },
      { code: "LD-USED-DELETE", type: "redeem", amount: 4, mode: "single" },
      { code: "LD-PARTIAL", type: "redeem", amount: 1, mode: "reusable", maxUses: 5 },
      { code: "LD-RACING", type: "redeem", amount: 1, mode: "reusable", maxUses: 5 },
    ]).returning();

    await expect(member1.member.redeemCode({ code: single.code })).resolves.toMatchObject({ amount: 5, mode: "single" });
    await expect(member2.member.redeemCode({ code: single.code })).rejects.toThrow("已用完");

    await expect(member1.member.redeemCode({ code: reusable.code })).resolves.toMatchObject({ remainingUses: 1 });
    await expect(member1.member.redeemCode({ code: reusable.code })).rejects.toThrow("已经兑换过");
    await expect(member2.member.redeemCode({ code: reusable.code })).resolves.toMatchObject({ remainingUses: 0 });
    await expect(member3.member.redeemCode({ code: reusable.code })).rejects.toThrow("已用完");

    const concurrent = await Promise.allSettled([
      member3.member.redeemCode({ code: unlimited.code }),
      member3.member.redeemCode({ code: unlimited.code }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(member1.member.redeemCode({ code: unlimited.code })).resolves.toMatchObject({ remainingUses: null });

    const balances = await db.select({ id: users.id, balance: users.balance }).from(users);
    expect(new Map(balances.map((row) => [row.id, row.balance]))).toEqual(new Map([
      [createdUsers[0].id, 10],
      [createdUsers[1].id, 3],
      [createdUsers[2].id, 2],
    ]));
    expect(await db.select().from(codeRedemptions)).toHaveLength(5);
    expect(await db.select().from(transactions)).toHaveLength(5);
    expect((await db.select().from(inviteCodes).where(eq(inviteCodes.id, reusable.id)))[0].redemptionCount).toBe(2);

    // 单次已用码、仍有余量的可重复码都显示“删除”，后端实际安全归档并保留审计。
    await member2.member.redeemCode({ code: usedSingleDelete.code });
    await member3.member.redeemCode({ code: partialReusable.code });
    await member1.member.redeemCode({ code: racingReusable.code });
    await expect(member1.admin.deleteInvite({ id: unused.id })).rejects.toThrow("需要管理员登录");
    await expect(admin.admin.deleteInvite({ id: usedSingleDelete.id })).resolves.toMatchObject({ action: "archive", auditPreserved: true });
    await expect(admin.admin.deleteInvite({ id: usedSingleDelete.id })).rejects.toThrow("已经归档");
    await expect(member3.member.redeemCode({ code: usedSingleDelete.code })).rejects.toThrow("兑换码无效");
    await expect(admin.admin.deleteInvite({ id: partialReusable.id })).resolves.toMatchObject({ action: "archive", auditPreserved: true });
    await expect(member1.member.redeemCode({ code: partialReusable.code })).rejects.toThrow("兑换码无效");

    // 兑换与归档共享 SQLite 原子事务；无论竞争顺序，归档提交后不能再成功兑换。
    const race = await Promise.allSettled([
      admin.admin.deleteInvite({ id: racingReusable.id }),
      member2.member.redeemCode({ code: racingReusable.code }),
    ]);
    expect(race[0]).toMatchObject({ status: "fulfilled", value: { action: "archive" } });
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(member3.member.redeemCode({ code: racingReusable.code })).rejects.toThrow("兑换码无效");
    expect((await db.select().from(codeRedemptions).where(eq(codeRedemptions.codeId, racingReusable.id)))).toHaveLength(1);
    expect((await admin.admin.listInvites({ status: "archived" })).map((code) => code.id)).toEqual(expect.arrayContaining([
      usedSingleDelete.id, partialReusable.id, racingReusable.id,
    ]));
    expect((await admin.admin.listInvites({ status: "active" })).find((code) => code.id === reusable.id)).toMatchObject({
      canDelete: true,
      deleteAction: "archive",
      auditCount: 2,
    });

    await expect(member1.admin.previewUsedCodeCleanup()).rejects.toThrow("需要管理员登录");
    const preview = await admin.admin.previewUsedCodeCleanup();
    expect(preview).toMatchObject({ eligibleCount: 1, protectedReusableCount: 2, action: "archive" });
    await expect(admin.admin.archiveUsedCodes({
      expectedCount: 2,
      confirmation: "ARCHIVE_USED_CODES",
    })).rejects.toThrow("请重新预览确认");

    const archived = await admin.admin.archiveUsedCodes({
      expectedCount: preview.eligibleCount,
      confirmation: "ARCHIVE_USED_CODES",
    });
    expect(archived.archivedCount).toBe(1);
    expect((await db.select().from(inviteCodes).where(eq(inviteCodes.id, single.id)))[0].archivedAt).not.toBeNull();
    expect((await db.select().from(inviteCodes).where(eq(inviteCodes.id, reusable.id)))[0].archivedAt).toBeNull();
    expect(await db.select().from(codeRedemptions)).toHaveLength(8);
    expect((await admin.admin.listInvites({ status: "active" })).some((code) => code.id === single.id)).toBe(false);

    await expect(admin.admin.deleteInvite({ id: unused.id })).resolves.toMatchObject({ ok: true, action: "hard_delete", auditPreserved: false });
    expect(await db.select().from(inviteCodes).where(eq(inviteCodes.id, unused.id))).toHaveLength(0);
    await expect(admin.admin.deleteInvite({ id: unused.id })).rejects.toThrow("不存在");
    expect(await db.select().from(codeRedemptions)).toHaveLength(8);
    expect((await db.select().from(adminLogs)).filter((log) => ["安全归档已使用码", "物理删除未使用码"].includes(log.action))).toHaveLength(4);

    // Older databases may retain code types outside the current schema.
    const [legacy] = await db.insert(inviteCodes).values({
      code: "LD-LEGACY", type: sql`'report'`, amount: 10,
    }).returning();
    await expect(member1.member.redeemCode({ code: legacy.code })).rejects.toThrow("兑换码无效");
    await db.insert(codeRedemptions).values({ codeId: legacy.id, code: legacy.code, userId: createdUsers[0].id, amount: 10 });
    expect((await admin.admin.listInvites({ status: "all" })).map((code) => code.id)).not.toContain(legacy.id);
    expect(await admin.admin.listInvitesPage({ page: 1, pageSize: 20, status: "all" })).toMatchObject({ total: 6 });
    expect(await admin.admin.listCodeRedemptions({ codeId: legacy.id })).toEqual([]);
    expect(await admin.admin.listCodeRedemptionsPage({ page: 1, pageSize: 20 })).toMatchObject({ total: 8 });
  });
});
