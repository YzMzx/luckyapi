import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

process.env.SQLITE_PATH = join(tmpdir(), `lucky-entertainment-${process.pid}-${Date.now()}.db`);

describe("entertainment transactions and administration", () => {
  it("enforces one-time draw, daily limits/signin, announcements and balance thresholds", async () => {
    const [{ getDb }, schema, { appRouter }] = await Promise.all([
      import("../queries/connection"),
      import("../../db/schema"),
      import("../router"),
    ]);
    const {
      users, sessions, adminSessions, draws, dailySignins, checkins, experienceEvents, signinFund,
      inviteCodes, codeRedemptions, transactions, adminLogs,
    } = schema;
    const db = getDb();
    const createdUsers = await db.insert(users).values([
      { linuxdoId: "ent-1", username: "ent-1", groupName: "娱乐一", balance: 10 },
      { linuxdoId: "ent-2", username: "ent-2", groupName: "娱乐二", balance: 10 },
      { linuxdoId: "ent-3", username: "ent-3", groupName: "娱乐三", balance: 10 },
    ]).returning();
    await db.insert(sessions).values(createdUsers.map((user, index) => ({
      token: `ent-member-${index + 1}`,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    })));
    await db.insert(adminSessions).values({ token: "ent-admin", expiresAt: new Date(Date.now() + 60_000) });
    const caller = (token: string) => appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: `ld_session=${token}`, "x-real-ip": "203.0.113.8" } }),
      resHeaders: new Headers(),
    });
    const member1 = caller("ent-member-1");
    const member2 = caller("ent-member-2");
    const member3 = caller("ent-member-3");
    const admin = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_admin=ent-admin" } }),
      resHeaders: new Headers(),
    });

    await admin.admin.updateEntertainmentConfig({
      businessTimezoneOffsetMinutes: 480,
      businessDayStartHour: 4,
      drawEnabled: true,
      drawWinRatePercent: 100,
      drawMinReward: 1,
      drawMaxReward: 1,
      drawTotalLimit: 2,
      drawBudgetRemaining: 3,
      slotEnabled: true,
      slotDailyLimit: 2,
      signinEnabled: true,
      signinMinReward: 1,
      signinMaxReward: 5,
      signinMode: "fixed",
      signinFixedReward: 1,
      signinTiers: [{ reward: 1, probabilityPpm: 1_000_000 }],
      signinBudgetRemaining: 10,
    });
    expect(await admin.admin.getEntertainmentControl()).toMatchObject({
      config: { slotDailyLimit: 2, drawBudgetRemaining: 3 },
      semantics: { zeroDailyLimit: expect.stringContaining("关闭") },
    });

    const drawRequest = randomUUID();
    const firstDraw = await member1.draw.draw({ requestId: drawRequest });
    expect(firstDraw).toMatchObject({ result: "won", amount: 1, idempotent: false });
    const repeatedDraw = await member1.draw.draw({ requestId: drawRequest });
    expect(repeatedDraw).toMatchObject({ result: "won", amount: 1, idempotent: true, symbols: firstDraw.symbols });
    const concurrent = await Promise.all([
      member2.draw.draw({ requestId: randomUUID() }),
      member2.draw.draw({ requestId: randomUUID() }),
    ]);
    expect(concurrent.map((result) => result.amount)).toEqual([1, 1]);
    expect(concurrent.filter((result) => !result.idempotent)).toHaveLength(1);
    await expect(member3.draw.draw({ requestId: randomUUID() })).rejects.toThrow("名额已用完");
    expect(await db.select().from(draws)).toHaveLength(2);
    expect(await member1.draw.status()).toMatchObject({ participated: true, result: { symbols: firstDraw.symbols } });

    const signinRequest = randomUUID();
    const signin = await member1.entertainment.signin({ requestId: signinRequest });
    expect(signin).toMatchObject({ reward: 1, idempotent: false });
    await expect(member1.entertainment.signin({ requestId: signinRequest })).resolves.toMatchObject({ reward: 1, idempotent: true });
    await expect(member1.entertainment.signin({ requestId: randomUUID() })).resolves.toMatchObject({ reward: 1, idempotent: true });
    expect(await db.select().from(dailySignins)).toHaveLength(1);
    expect(await member1.entertainment.signinStatus()).toMatchObject({ done: true, result: { reward: 1 } });
    const signinKey = `signin:${signin.day}`;
    const signinEvents = await db.select({ amount: experienceEvents.amount }).from(experienceEvents)
      .where(and(eq(experienceEvents.userId, createdUsers[0].id), eq(experienceEvents.eventKey, signinKey)));
    expect(signinEvents).toEqual([{ amount: 200 }]);

    // A conflicting EXP event must roll back the sign-in row, cash reward and funding together.
    const { grantExperience } = await import("../queries/levels");
    grantExperience(createdUsers[2].id, signinKey, 1);
    const readBudget = () => db.select({ units: signinFund.balanceUnits }).from(signinFund).where(eq(signinFund.id, 1)).get();
    const budgetBefore = readBudget();
    await expect(member3.entertainment.signin({ requestId: randomUUID() })).rejects.toThrow("同一事件的经验值不一致");
    expect(await member3.entertainment.signinStatus()).toMatchObject({ done: false });
    expect(db.select({ balance: users.balance }).from(users).where(eq(users.id, createdUsers[2].id)).get())
      .toEqual({ balance: createdUsers[2].balance });
    expect(db.select().from(transactions).where(eq(transactions.userId, createdUsers[2].id)).all()).toEqual([]);
    expect(readBudget()).toEqual(budgetBefore);

    const slot = await member1.member.checkinStatus();
    const firstSpin = await member1.member.checkin({ requestId: randomUUID(), expectedConfigVersion: slot.rules.configVersion, bet: 0.1 });
    expect(firstSpin.configVersion).toBe(slot.rules.configVersion);
    await member1.member.checkin({ requestId: randomUUID(), expectedConfigVersion: slot.rules.configVersion, bet: 0.1 });
    await expect(member1.member.checkin({ requestId: randomUUID(), expectedConfigVersion: slot.rules.configVersion, bet: 0.1 }))
      .rejects.toThrow("次数已经用完");
    expect(await db.select().from(checkins).where(eq(checkins.userId, createdUsers[0].id))).toHaveLength(2);
    expect(await member1.member.checkinStatus()).toMatchObject({ dailyLimit: 2, used: 2, remaining: 0 });


    const draft = await admin.admin.createAnnouncement({
      title: " 维护通知 ",
      content: "<script>alert(1)</script>今晚维护",
      status: "draft",
      severity: "important",
      pinned: true,
      sortOrder: 10,
      publishedAt: null,
      endsAt: null,
    });
    expect((await member1.entertainment.announcements())).toHaveLength(0);
    await admin.admin.publishAnnouncement({ id: draft.id });
    const publicNotices = await member1.entertainment.announcements();
    expect(publicNotices).toHaveLength(1);
    expect(publicNotices[0]).toMatchObject({ title: "维护通知", pinned: true });
    expect(publicNotices[0].content).not.toContain("<script>");
    const future = await admin.admin.createAnnouncement({
      title: "未来公告", content: "尚未开始", status: "published", severity: "info", pinned: false, sortOrder: 0,
      publishedAt: new Date(Date.now() + 60_000), endsAt: new Date(Date.now() + 120_000),
    });
    expect((await member1.entertainment.announcements()).some((row) => row.id === future.id)).toBe(false);
    await expect(member1.entertainment.announcement({ id: draft.id })).resolves.toMatchObject({ id: draft.id });
    await admin.admin.withdrawAnnouncement({ id: draft.id });
    expect((await member1.entertainment.announcements())).toHaveLength(0);

    const [single, reusable] = await db.insert(inviteCodes).values([
      { code: "LD-THRESHOLD-S", type: "redeem", amount: 2, mode: "single", balanceBelow: 12 },
      { code: "LD-THRESHOLD-R", type: "redeem", amount: 2, mode: "reusable", maxUses: 5, balanceBelow: 12 },
    ]).returning();
    // user 1 has at least draw + signin rewards, so equality/above the threshold is rejected without consuming the code.
    await db.update(users).set({ balance: 12 }).where(eq(users.id, createdUsers[0].id));
    await expect(member1.member.redeemCode({ code: single.code })).rejects.toThrow("严格低于 $12.00");
    expect((await db.select().from(inviteCodes).where(eq(inviteCodes.id, single.id)))[0].redemptionCount).toBe(0);
    await db.update(users).set({ balance: 11.99 }).where(eq(users.id, createdUsers[0].id));
    await expect(member1.member.redeemCode({ code: single.code })).resolves.toMatchObject({ amount: 2, balanceBefore: 11.99, balanceBelow: 12 });
    await admin.admin.updateInviteBalanceThreshold({ id: reusable.id, balanceBelow: 20 });
    await expect(member2.member.redeemCode({ code: reusable.code })).resolves.toMatchObject({ balanceBelow: 20 });
    expect(await db.select().from(codeRedemptions)).toHaveLength(2);

    const summary = await member1.entertainment.summary();
    expect(summary).toMatchObject({
      draw: { participated: true },
      slot: { dailyLimit: 2, remaining: 0 },
      signin: { done: true },
    });
    expect((await db.select().from(transactions)).length).toBeGreaterThanOrEqual(7);
    expect((await db.select().from(adminLogs)).some((row) => row.action === "更新娱乐中心配置")).toBe(true);
  });
});
