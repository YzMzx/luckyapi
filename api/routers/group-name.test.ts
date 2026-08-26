import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

process.env.SQLITE_PATH = join(tmpdir(), `lucky-group-name-${process.pid}-${Date.now()}.db`);

describe("group name onboarding and profile update", () => {
  it("validates, normalizes and updates only the signed-in user's unique public name", async () => {
    const [
      { getDb },
      { users, pendingUsers, sessions, inviteCodes, adminSessions },
      { appRouter },
      { createPendingSession },
      { upsertOAuthIdentity },
    ] = await Promise.all([
      import("../queries/connection"),
      import("../../db/schema"),
      import("../router"),
      import("../auth"),
      import("../queries/oauth-identity"),
    ]);
    const db = getDb();
    const identity = await upsertOAuthIdentity({
      linuxdoId: "first",
      username: "first",
      displayName: "First OAuth User",
      avatarUrl: "https://example.test/avatar.png",
      trustLevel: 3,
    });
    expect(identity.kind).toBe("pending");
    if (identity.kind !== "pending") throw new Error("expected pending identity");
    expect(await db.select().from(users)).toHaveLength(0);
    expect(await db.select().from(pendingUsers)).toHaveLength(1);
    const pendingToken = await createPendingSession(identity.user.id);
    await db.insert(inviteCodes).values({ code: "INV-GROUP-1", type: "invite" });
    const pendingHeaders = new Headers();
    const firstCaller = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: `ld_pending_session=${pendingToken}` } }),
      resHeaders: pendingHeaders,
    });
    expect(await firstCaller.auth.me()).toMatchObject({ onboarded: false, registrationState: "pending" });
    await expect(firstCaller.member.leaderboard()).rejects.toThrow("请先登录");

    await db.insert(adminSessions).values({ token: "admin-session", expiresAt: new Date(Date.now() + 60_000) });
    const adminCaller = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_admin=admin-session" } }),
      resHeaders: new Headers(),
    });
    expect((await adminCaller.admin.listUsers())).toHaveLength(0);
    expect((await adminCaller.admin.stats()).users).toBe(0);

    await expect(firstCaller.auth.completeOnboarding({ inviteCode: "INV-GROUP-1", groupName: "   " }))
      .rejects.toThrow("请填写群内名称");
    await expect(firstCaller.auth.completeOnboarding({ inviteCode: "INV-GROUP-1", groupName: "admin" }))
      .rejects.toThrow("系统保留名称");
    await expect(firstCaller.auth.completeOnboarding({ inviteCode: "INVALID-CODE", groupName: "有效名称" }))
      .rejects.toThrow("邀请码无效或已被使用");
    expect(await db.select().from(users)).toHaveLength(0);
    expect(await db.select().from(pendingUsers)).toHaveLength(1);
    expect((await db.select().from(inviteCodes).where(eq(inviteCodes.code, "INV-GROUP-1")))[0].usedBy).toBeNull();

    const onboarded = await firstCaller.auth.completeOnboarding({
      inviteCode: "INV-GROUP-1", groupName: "  三　七  ",
    });
    expect(onboarded.groupName).toBe("三 七");
    expect(await db.select().from(pendingUsers)).toHaveLength(0);
    const [first] = await db.select().from(users).where(eq(users.linuxdoId, "first"));
    expect(first.groupName).toBe("三 七");
    expect(first.displayName).toBe("First OAuth User");
    expect((await db.select().from(inviteCodes).where(eq(inviteCodes.code, "INV-GROUP-1")))[0].usedBy).toBe(first.id);
    expect(pendingHeaders.get("set-cookie")).toContain("ld_session=");
    expect(pendingHeaders.get("set-cookie")).toContain("ld_pending_session=");
    expect((await adminCaller.admin.listUsers())).toHaveLength(1);
    expect((await adminCaller.admin.stats()).users).toBe(1);

    const relogin = await upsertOAuthIdentity({
      linuxdoId: "first",
      username: "first-renamed",
      displayName: "Updated OAuth Profile",
      avatarUrl: "https://example.test/new-avatar.png",
      trustLevel: 4,
    });
    expect(relogin.kind).toBe("registered");
    expect(await db.select().from(pendingUsers)).toHaveLength(0);
    expect((await db.select().from(users).where(eq(users.id, first.id)))[0]).toMatchObject({
      username: "first-renamed",
      displayName: "Updated OAuth Profile",
      groupName: "三 七",
    });

    const [formalSession] = await db.select().from(sessions).where(eq(sessions.userId, first.id));
    const registeredCaller = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: `ld_session=${formalSession.token}` } }),
      resHeaders: new Headers(),
    });

    const [second] = await db.insert(users).values({
      linuxdoId: "second", username: "second", groupName: "Beta",
    }).returning();
    await expect(registeredCaller.member.updateGroupName({ groupName: " beta " })).rejects.toThrow("已被占用");
    await expect(registeredCaller.member.updateGroupName({ groupName: "<script>" })).rejects.toThrow("不能包含控制字符或 < >");

    const updated = await registeredCaller.member.updateGroupName({ groupName: "  新　名字  " });
    expect(updated.groupName).toBe("新 名字");
    expect((await db.select().from(users).where(eq(users.id, first.id)))[0].groupName).toBe("新 名字");
    expect((await db.select().from(users).where(eq(users.id, second.id)))[0].groupName).toBe("Beta");
  });
});
