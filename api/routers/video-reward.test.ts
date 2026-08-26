import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

process.env.SQLITE_PATH = join(tmpdir(), `lucky-video-reward-${process.pid}-${Date.now()}.db`);

describe("daily video reward", () => {
  it("uses server-timed heartbeats and claims exactly once with auditable pagination", async () => {
    const [{ getDb }, schema, { appRouter }] = await Promise.all([
      import("../queries/connection"),
      import("../../db/schema"),
      import("../router"),
    ]);
    const { users, sessions, adminSessions, videoRewardSessions, videoRewardLedger, videoRewardFund, transactions } = schema;
    const db = getDb();
    const [user, user2, user3] = await db.insert(users).values([
      { linuxdoId: "video-reward-1", username: "video-reward-1", groupName: "Video Member", balance: 2 },
      { linuxdoId: "video-reward-2", username: "video-reward-2", groupName: "Video Member 2", balance: 2 },
      { linuxdoId: "video-reward-3", username: "video-reward-3", groupName: "Video Member 3", balance: 2 },
    ]).returning();
    await db.insert(sessions).values([
      { token: "video-member", userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
      { token: "video-member-2", userId: user2.id, expiresAt: new Date(Date.now() + 60_000) },
      { token: "video-member-3", userId: user3.id, expiresAt: new Date(Date.now() + 60_000) },
    ]);
    await db.insert(adminSessions).values({ token: "video-admin", expiresAt: new Date(Date.now() + 60_000) });
    const member = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_session=video-member" } }),
      resHeaders: new Headers(),
    });
    const admin = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_admin=video-admin" } }),
      resHeaders: new Headers(),
    });
    const member2 = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_session=video-member-2" } }),
      resHeaders: new Headers(),
    });
    const member3 = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_session=video-member-3" } }),
      resHeaders: new Headers(),
    });
    const anonymous = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc"), resHeaders: new Headers(),
    });
    await expect(anonymous.admin.getVideoRewardControl()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await admin.admin.getVideoRewardControl()).toMatchObject({
      config: { dailyLimit: 1, videoResource: "/media/lucky-video-red-envelope-15s.mp4" },
    });

    await expect(admin.admin.updateVideoRewardConfig({
      enabled: true, dailyLimit: 2, minWatchSeconds: 15, minReward: 0.123456, maxReward: 0.123456,
      dailyBudget: 1, useFund: true, fundBalance: 2, videoResource: "https://example.com/video.webm",
    })).rejects.toThrow("local public path");
    await expect(admin.admin.updateVideoRewardConfig({
      enabled: true, dailyLimit: 101, minWatchSeconds: 15, minReward: 0.123456, maxReward: 0.123456,
      dailyBudget: 1, useFund: true, fundBalance: 2,
      videoResource: "/media/lucky-video-red-envelope-15s.webm",
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await admin.admin.updateVideoRewardConfig({
      enabled: true, dailyLimit: 2, minWatchSeconds: 15, minReward: 0.123456, maxReward: 0.123456,
      dailyBudget: 1, useFund: true, fundBalance: 2,
      videoResource: "/media/lucky-video-red-envelope-15s.webm",
    });
    expect(await admin.admin.getVideoRewardControl()).toMatchObject({
      config: { enabled: true, dailyLimit: 2, minWatchSeconds: 15, minRewardUnits: 123456 },
    });

    const started = await member.entertainment.startVideoRewardSession({ requestId: randomUUID() });
    const token = started.session?.sessionToken;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const resumed = await member.entertainment.startVideoRewardSession({ requestId: randomUUID() });
    expect(resumed).toMatchObject({ idempotent: true, session: { id: started.session?.id } });
    await expect(member.entertainment.heartbeatVideoReward({ sessionToken: token!, sequence: 1 }))
      .rejects.toThrow("too quickly");
    await db.update(videoRewardSessions).set({ lastHeartbeatAt: new Date(Date.now() - 6_000) })
      .where(eq(videoRewardSessions.id, started.session!.id));
    await expect(member.entertainment.heartbeatVideoReward({ sessionToken: token!, sequence: 1 }))
      .resolves.toMatchObject({ accepted: false, reason: "gap_too_large", creditedMs: 0 });
    await expect(member.entertainment.heartbeatVideoReward({ sessionToken: token!, sequence: 1 }))
      .rejects.toThrow("sequence 2");
    await expect(member.entertainment.claimVideoReward({ sessionToken: token!, requestId: randomUUID() }))
      .rejects.toThrow("viewing time");

    for (let sequence = 2; sequence <= 16; sequence += 1) {
      await db.update(videoRewardSessions).set({ lastHeartbeatAt: new Date(Date.now() - 1_100) })
        .where(eq(videoRewardSessions.id, started.session!.id));
      await member.entertainment.heartbeatVideoReward({ sessionToken: token!, sequence });
    }
    expect(await member.entertainment.videoRewardStatus()).toMatchObject({
      canResume: true,
      session: { status: "ready", ready: true, requiredSeconds: 15, remainingSeconds: 0 },
    });

    const requestId = randomUUID();
    const [first, replay] = await Promise.all([
      member.entertainment.claimVideoReward({ sessionToken: token!, requestId }),
      member.entertainment.claimVideoReward({ sessionToken: token!, requestId }),
    ]);
    expect(first).toMatchObject({ rewardUnits: 123456, reward: 0.123456 });
    expect(replay).toMatchObject({ rewardUnits: 123456, idempotent: true });
    expect(await db.select().from(videoRewardLedger)).toHaveLength(1);
    expect(await db.select().from(transactions).where(eq(transactions.kind, "video_reward"))).toHaveLength(1);
    expect((await db.select().from(videoRewardFund).where(eq(videoRewardFund.id, 1)))[0].balanceUnits).toBe(1_876_544);
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].balance).toBeCloseTo(2.123456, 6);
    expect(await member.entertainment.videoRewardStatus()).toMatchObject({
      dailyLimit: 2, claimedCount: 1, remainingCount: 1, canStart: true, canResume: false,
    });

    const second = await member.entertainment.startVideoRewardSession({ requestId: randomUUID() });
    await db.update(videoRewardSessions).set({ status: "ready", watchedMs: 15_000 })
      .where(eq(videoRewardSessions.id, second.session!.id));
    await expect(member.entertainment.claimVideoReward({
      sessionToken: second.session!.sessionToken!, requestId,
    })).rejects.toThrow("another viewing session");
    await admin.admin.updateVideoRewardConfig({
      enabled: true, dailyLimit: 1, minWatchSeconds: 15, minReward: 0.123456, maxReward: 0.123456,
      dailyBudget: 1, useFund: true, fundBalance: 1.876544,
      videoResource: "/media/lucky-video-red-envelope-15s.webm",
    });
    await expect(member.entertainment.claimVideoReward({
      sessionToken: second.session!.sessionToken!, requestId: randomUUID(),
    })).rejects.toThrow("daily_limit_reached");
    await admin.admin.updateVideoRewardConfig({
      enabled: true, dailyLimit: 2, minWatchSeconds: 15, minReward: 0.123456, maxReward: 0.123456,
      dailyBudget: 1, useFund: true, fundBalance: 1.876544,
      videoResource: "/media/lucky-video-red-envelope-15s.webm",
    });
    await member.entertainment.claimVideoReward({
      sessionToken: second.session!.sessionToken!, requestId: randomUUID(),
    });
    expect(await member.entertainment.videoRewardStatus()).toMatchObject({
      dailyLimit: 2, claimedCount: 2, remainingCount: 0, canStart: false,
      unavailableReason: "daily_limit_reached",
    });
    await expect(member.entertainment.startVideoRewardSession({ requestId: randomUUID() }))
      .rejects.toThrow("daily_limit_reached");

    const crossed = await member2.entertainment.startVideoRewardSession({ requestId: randomUUID() });
    await db.update(videoRewardSessions).set({
      startedAt: new Date(Date.now() - 31 * 60_000),
    }).where(eq(videoRewardSessions.id, crossed.session!.id));
    const replacement = await member2.entertainment.startVideoRewardSession({ requestId: randomUUID() });
    expect(replacement.session?.id).not.toBe(crossed.session?.id);
    expect(await member2.entertainment.videoRewardStatus()).toMatchObject({ claimedCount: 0, remainingCount: 2 });
    await db.update(videoRewardSessions).set({
      businessDay: "2000-01-01",
      lastHeartbeatAt: new Date(Date.now() - 1_100),
    }).where(eq(videoRewardSessions.id, replacement.session!.id));
    await expect(member2.entertainment.heartbeatVideoReward({
      sessionToken: replacement.session!.sessionToken!, sequence: 1,
    })).rejects.toThrow("business-day boundary");
    expect((await db.select().from(videoRewardSessions).where(eq(videoRewardSessions.id, replacement.session!.id)))[0].status).toBe("expired");
    expect(await member2.entertainment.videoRewardStatus()).toMatchObject({ claimedCount: 0, remainingCount: 2, canStart: true });

    await db.update(videoRewardFund).set({ balanceUnits: 0 }).where(eq(videoRewardFund.id, 1));
    await expect(member3.entertainment.startVideoRewardSession({ requestId: randomUUID() }))
      .rejects.toThrow("fund_exhausted");
    await admin.admin.updateVideoRewardConfig({
      enabled: true, dailyLimit: 2, minWatchSeconds: 15, minReward: 0.123456, maxReward: 0.123456,
      dailyBudget: 0.123456, useFund: true, fundBalance: 2,
      videoResource: "/media/lucky-video-red-envelope-15s.webm",
    });
    await expect(member3.entertainment.startVideoRewardSession({ requestId: randomUUID() }))
      .rejects.toThrow("daily_budget_exhausted");

    const page = await admin.admin.listVideoRewardSessionsPage({ page: 1, pageSize: 10, status: "claimed" });
    expect(page).toMatchObject({ total: 2, totalPages: 1 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ rewardUnits: 123456 });
    expect(page.items[0].tokenPrefix).toHaveLength(10);
    expect(page.items[0]).not.toHaveProperty("sessionToken");
  });
});
