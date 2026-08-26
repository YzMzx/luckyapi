import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  DEFAULT_SLOT_RULES,
  formatMultiplier,
  formatProbabilityPercent,
  multiplyMoneyUnits,
} from "@contracts/slot-machine";

process.env.SQLITE_PATH = join(tmpdir(), `lucky-slot-machine-${process.pid}-${Date.now()}.db`);

const configInput = (mode: "base" | "promotion", name: string) => ({
  name,
  mode,
  minBet: "0.10",
  maxBet: "5.00",
  tiers: DEFAULT_SLOT_RULES.tiers.map((tier) => ({
    id: tier.id,
    symbol: tier.symbol,
    name: tier.name,
    probabilityPercent: formatProbabilityPercent(tier.probabilityPpm),
    multiplier: formatMultiplier(tier.multiplierBasisPoints),
  })),
});

describe("daily slot control and settlement", () => {
  it("versions rules, enforces risk, settles atomically, audits both sides and expires promo budgets", async () => {
    const [{ getDb }, schema, { appRouter }] = await Promise.all([
      import("../queries/connection"),
      import("../../db/schema"),
      import("../router"),
    ]);
    const {
      users, sessions, adminSessions, checkins, transactions, slotConfigs, slotFund,
      slotFundLedger, slotPromotions, adminLogs,
    } = schema;
    const db = getDb();
    const seededConfigs = await db.select().from(slotConfigs);
    expect(seededConfigs).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: "daily-slot-v1", status: "retired" }),
      expect.objectContaining({ version: "daily-slot-v2-2505", status: "active", winRatePpm: 250_500, rtpPpm: 920_000 }),
    ]));
    expect((await db.select().from(slotFund))[0]).toMatchObject({ balanceUnits: 1_000_000, reserveUnits: 300_000 });

    const createdUsers = await db.insert(users).values([
      { linuxdoId: "slot-funded", username: "slot-funded", groupName: "老虎机玩家", balance: 100 },
      { linuxdoId: "slot-empty", username: "slot-empty", groupName: "零余额玩家", balance: 0 },
      { linuxdoId: "slot-retry", username: "slot-retry", groupName: "重试玩家", balance: 100 },
    ]).returning();
    await db.insert(sessions).values(createdUsers.map((user, index) => ({
      token: `slot-${index + 1}`,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    })));
    await db.insert(adminSessions).values({ token: "slot-admin", expiresAt: new Date(Date.now() + 60_000) });
    const caller = (token: string) => appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: `ld_session=${token}` } }),
      resHeaders: new Headers(),
    });
    const funded = caller("slot-1");
    const empty = caller("slot-2");
    const retrying = caller("slot-3");
    const admin = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_admin=slot-admin" } }),
      resHeaders: new Headers(),
    });
    const anonymous = appRouter.createCaller({ req: new Request("http://localhost/api/trpc"), resHeaders: new Headers() });
    await expect(anonymous.admin.getSlotControl()).rejects.toThrow("需要管理员登录");

    const before = await funded.member.checkinStatus();
    expect(before).toMatchObject({ enabled: true, done: false, result: null });
    expect(before.rules).toMatchObject({
      configVersion: "daily-slot-v2-2505",
      allowedMaxBet: 5,
      mode: "base",
      theoretical: { winRatePpm: 250_500, rtpPpm: 920_000, maxGrossPayout: 1100, maxNetLiability: 1095 },
    });

    await expect(funded.member.checkin({ requestId: randomUUID(), expectedConfigVersion: "stale-version", bet: 1 }))
      .rejects.toThrow("规则刚刚更新");
    expect(await db.select().from(checkins)).toHaveLength(0);

    const requestId = randomUUID();
    const result = await funded.member.checkin({ requestId, expectedConfigVersion: before.rules.configVersion, bet: 1 });
    expect(result.symbols).not.toBeNull();
    if (!result.symbols) throw new Error("expected symbols");
    expect(result.configVersion).toBe("daily-slot-v2-2505");
    expect(result.rtpPpm).toBe(920_000);
    expect(result.winRatePpm).toBe(250_500);
    if (result.win) {
      expect(new Set(result.symbols).size).toBe(1);
      expect(result.grossPayout).toBe(multiplyMoneyUnits(100, Math.round(result.payoutMultiplier * 10_000)) / 100);
    } else {
      expect(new Set(result.symbols).size).toBeGreaterThan(1);
      expect(result.grossPayout).toBe(0);
    }
    const fundedAfter = (await db.select().from(users).where(eq(users.id, createdUsers[0].id)))[0];
    expect(fundedAfter.balance).toBeCloseTo(100 + result.netChange, 8);
    const round = (await db.select().from(checkins).where(eq(checkins.requestId, requestId)))[0];
    expect(round).toMatchObject({
      userId: createdUsers[0].id,
      bet: 1,
      symbols: result.symbols.join(","),
      configVersion: "daily-slot-v2-2505",
      rulesSnapshot: expect.stringContaining("2505"),
      fundBeforeUnits: 1_000_000,
      winRatePpm: 250_500,
      rtpPpm: 920_000,
    });
    expect(await db.select().from(transactions).where(eq(transactions.userId, createdUsers[0].id))).toHaveLength(1);
    const fundEntries = await db.select().from(slotFundLedger).where(eq(slotFundLedger.requestId, requestId));
    expect(fundEntries.map((entry) => entry.type)).toEqual(["bet", "payout"]);
    expect(fundEntries[1].balanceAfterUnits).toBe(round.fundAfterUnits);

    const repeated = await funded.member.checkin({ requestId, expectedConfigVersion: "any-retry-version", bet: 1 });
    expect(repeated).toMatchObject({ requestId, symbols: result.symbols, netChange: result.netChange, idempotent: true });
    expect(await db.select().from(checkins).where(eq(checkins.userId, createdUsers[0].id))).toHaveLength(1);
    expect(await db.select().from(slotFundLedger).where(eq(slotFundLedger.requestId, requestId))).toHaveLength(2);
    await expect(funded.member.checkin({ requestId: randomUUID(), expectedConfigVersion: before.rules.configVersion, bet: 1 })).rejects.toThrow("今天已经玩过了");

    const fundBeforeFailure = (await db.select().from(slotFund))[0].balanceUnits;
    await expect(empty.member.checkin({ requestId: randomUUID(), expectedConfigVersion: before.rules.configVersion, bet: 1 })).rejects.toThrow("余额不足");
    expect((await db.select().from(slotFund))[0].balanceUnits).toBe(fundBeforeFailure);
    expect(await db.select().from(checkins).where(eq(checkins.userId, createdUsers[1].id))).toHaveLength(0);

    await db.update(slotFund).set({ balanceUnits: 100_000, reserveUnits: 78_100, dailyLossLimitUnits: 300_000, dayNetUnits: 0 }).where(eq(slotFund.id, 1));
    const riskLimited = await retrying.member.checkinStatus();
    expect(riskLimited.rules.allowedMaxBet).toBe(1);
    await expect(retrying.member.checkin({ requestId: randomUUID(), expectedConfigVersion: riskLimited.rules.configVersion, bet: 2 }))
      .rejects.toThrow("当前允许下注");
    await db.update(slotFund).set({ balanceUnits: 1_000_000, reserveUnits: 300_000, dailyLossLimitUnits: 300_000, dayNetUnits: 0 }).where(eq(slotFund.id, 1));

    const preview = await admin.admin.previewSlotConfig(configInput("base", "新基础规则"));
    expect(preview).toMatchObject({ winRatePercent: "25.05", rtpPercent: "92", maxGrossPayout: 1100, maxNetLiability: 1095 });
    await expect(admin.admin.previewSlotConfig({
      ...configInput("base", "非法规则"),
      tiers: configInput("base", "非法规则").tiers.map((tier) => ({ ...tier, probabilityPercent: "100" })),
    })).rejects.toThrow();
    const draft = await admin.admin.createSlotDraft(configInput("base", "新基础规则"));
    await admin.admin.activateSlotConfig({ configId: draft.id });
    const switched = await retrying.member.checkinStatus();
    expect(switched.rules.configVersion).toBe(draft.version);
    await expect(retrying.member.checkin({ requestId: randomUUID(), expectedConfigVersion: before.rules.configVersion, bet: 1 }))
      .rejects.toThrow("规则刚刚更新");

    const concurrentRequest = randomUUID();
    const concurrent = await Promise.all([
      retrying.member.checkin({ requestId: concurrentRequest, expectedConfigVersion: switched.rules.configVersion, bet: 0.5 }),
      retrying.member.checkin({ requestId: concurrentRequest, expectedConfigVersion: switched.rules.configVersion, bet: 0.5 }),
    ]);
    expect(concurrent[0].symbols).toEqual(concurrent[1].symbols);
    expect(concurrent.filter((entry) => entry.idempotent)).toHaveLength(1);
    expect(await db.select().from(checkins).where(eq(checkins.userId, createdUsers[2].id))).toHaveLength(1);

    const promoConfig = await admin.admin.createSlotDraft(configInput("promotion", "限时放水规则"));
    const now = Date.now();
    const promotion = await admin.admin.createSlotPromotion({
      configId: promoConfig.id,
      name: "测试放水",
      startsAt: now - 1_000,
      endsAt: now + 60_000,
      budget: "100",
    });
    const promoState = await funded.member.checkinStatus();
    expect(promoState.rules).toMatchObject({ mode: "promotion", promotion: { id: promotion.id, name: "测试放水" } });
    const promoRow = (await db.select().from(slotPromotions).where(eq(slotPromotions.id, promotion.id)))[0];
    await db.update(slotPromotions).set({ spentUnits: promoRow.budgetUnits - 1 })
      .where(eq(slotPromotions.id, promotion.id));
    const exhaustedState = await funded.member.checkinStatus();
    expect(exhaustedState.rules.mode).toBe("base");
    expect((await db.select().from(slotPromotions).where(eq(slotPromotions.id, promotion.id)))[0].status).toBe("exhausted");

    await admin.admin.updateSlotRisk({ reserve: "3000", dailyLossLimit: "2500" });
    await admin.admin.adjustSlotFund({ amount: "25.50", reason: "测试人工划拨" });
    expect((await db.select().from(slotFund))[0]).toMatchObject({ reserveUnits: 300_000, dailyLossLimitUnits: 250_000 });
    expect((await db.select().from(slotFundLedger).where(eq(slotFundLedger.type, "adjustment")))[0].amountUnits).toBe(2_550);
    expect((await db.select().from(adminLogs)).some((row) => row.action.includes("老虎机"))).toBe(true);

    const requestCollision = randomUUID();
    await db.insert(checkins).values({ requestId: requestCollision, userId: createdUsers[0].id, day: "2000-01-01", delta: 0 });
    await expect(retrying.member.checkin({ requestId: requestCollision, expectedConfigVersion: switched.rules.configVersion, bet: 1 }))
      .rejects.toThrow("请求编号已被占用");
    expect(await db.select().from(slotFundLedger).where(eq(slotFundLedger.requestId, requestCollision))).toHaveLength(0);
    expect(await db.select().from(checkins).where(and(eq(checkins.requestId, requestCollision), eq(checkins.userId, createdUsers[2].id)))).toHaveLength(0);
  });
});
