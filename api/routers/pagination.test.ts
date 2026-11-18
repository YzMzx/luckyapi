import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

process.env.SQLITE_PATH = join(tmpdir(), `lucky-pagination-${process.pid}-${Date.now()}.db`);

describe("server-side pagination", () => {
  it("counts with the same filters, clamps stale pages, enforces privacy and caps page size", async () => {
    const [{ getDb }, schema, { appRouter }] = await Promise.all([
      import("../queries/connection"),
      import("../../db/schema"),
      import("../router"),
    ]);
    const { users, sessions, adminSessions, usageLogs, announcements, adminLogs } = schema;
    const db = getDb();
    const created = await db.insert(users).values(Array.from({ length: 5 }, (_, index) => ({
      linuxdoId: `page-${index + 1}`,
      username: `page-user-${index + 1}`,
      groupName: `分页用户${index + 1}`,
      banned: index === 4,
    }))).returning();
    await db.insert(sessions).values(created.slice(0, 2).map((user, index) => ({
      token: `page-member-${index + 1}`,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    })));
    await db.insert(adminSessions).values({ token: "page-admin", expiresAt: new Date(Date.now() + 60_000) });
    await db.insert(usageLogs).values([
      { userId: created[0].id, model: "alpha", cost: 0.0123 },
      { userId: created[0].id, model: "beta", cost: 0.0345 },
      { userId: created[1].id, model: "private-other", cost: 0.2 },
    ]);
    await db.insert(announcements).values([
      { title: "公开", content: "可见", status: "published", publishedAt: new Date(Date.now() - 1_000) },
      { title: "草稿", content: "不可见", status: "draft" },
      { title: "下线", content: "不可见", status: "published", publishedAt: new Date(Date.now() - 2_000), endsAt: new Date(Date.now() - 1_000) },
    ]);
    await db.insert(adminLogs).values(Array.from({ length: 5 }, (_, index) => ({
      action: index % 2 ? "编辑模型" : "调整余额",
      detail: `记录 ${index}`,
    })));

    const { grantExperience } = await import("../queries/levels");
    grantExperience(created[0].id, "activity:first", 7980);
    grantExperience(created[1].id, "activity:second", 7979);

    const admin = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_admin=page-admin" } }),
      resHeaders: new Headers(),
    });
    const member = (token: string) => appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: `ld_session=${token}` } }),
      resHeaders: new Headers(),
    });

    await expect(admin.admin.levels.hall()).resolves.toEqual([
      { level: 10, rank: 1, userName: created[0].groupName, awardedAt: expect.any(Number) },
    ]);
    const guest = appRouter.createCaller({ req: new Request("http://localhost/api/trpc"), resHeaders: new Headers() });
    await expect(guest.admin.levels.hall()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(member("page-member-1").admin.levels.hall()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(admin.admin.listUsersPage({ page: 1, pageSize: 101 })).rejects.toThrow();
    await expect(admin.admin.listUsersPage({ page: 999, pageSize: 2 })).resolves.toMatchObject({
      page: 3,
      pageSize: 2,
      total: 5,
      totalPages: 3,
      items: [{ id: created[0].id, siteLevel: 10, totalExp: 7980 }],
    });
    await expect(admin.admin.listUsersPage({ page: 1, pageSize: 20, banned: true })).resolves.toMatchObject({
      total: 1,
      totalPages: 1,
      items: [{ id: created[4].id, siteLevel: 1, totalExp: 0 }],
    });
    const userPage = await admin.admin.listUsersPage({ page: 1, pageSize: 20 });
    expect(userPage.items.find((user) => user.id === created[1].id)).toMatchObject({ siteLevel: 9, totalExp: 7979 });
    const consumed = new Map(userPage.items.map((user) => [user.id, user.totalConsumed]));
    expect(consumed.get(created[0].id)).toBeCloseTo(0.0468, 8);
    expect(consumed.get(created[1].id)).toBeCloseTo(0.2, 8);
    expect(consumed.get(created[2].id)).toBe(0);
    const legacyUsers = await admin.admin.listUsers();
    const legacyConsumed = new Map(legacyUsers.map((user) => [user.id, user.totalConsumed]));
    expect(legacyConsumed.get(created[0].id)).toBeCloseTo(0.0468, 8);
    expect(legacyConsumed.get(created[1].id)).toBeCloseTo(0.2, 8);
    expect(legacyConsumed.get(created[2].id)).toBe(0);
    await expect(admin.admin.listAdminLogsPage({ page: 1, pageSize: 2, keyword: "模型" })).resolves.toMatchObject({
      total: 2,
      items: [{ action: "编辑模型" }, { action: "编辑模型" }],
    });

    const mine = member("page-member-1");
    await expect(mine.member.myUsage({ page: 99, pageSize: 1 })).resolves.toMatchObject({
      page: 2,
      total: 2,
      totalPages: 2,
      logs: [{ model: "alpha" }],
    });
    await expect(mine.entertainment.announcementsPage({ page: 1, pageSize: 20 })).resolves.toMatchObject({
      total: 1,
      items: [{ title: "公开" }],
    });
    await expect(mine.admin.listUsersPage({ page: 1, pageSize: 20 })).rejects.toThrow();
  });
});
