import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const randomIntMock = vi.hoisted(() => vi.fn());
vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return { ...actual, randomInt: randomIntMock };
});

process.env.SQLITE_PATH = join(tmpdir(), `lucky-report-tax-${process.pid}-${Date.now()}.db`);

describe("configurable report tax", () => {
  it("computes a direction-symmetric half of the lower pre-settlement balance", async () => {
    const { calculateReportGross } = await import("../../contracts/report-tax");
    expect(calculateReportGross(100, 20)).toEqual({
      reporterBalanceBefore: 100, targetBalanceBefore: 20, lowerBalance: 20, grossAmount: 10,
    });
    expect(calculateReportGross(20, 100)).toEqual({
      reporterBalanceBefore: 20, targetBalanceBefore: 100, lowerBalance: 20, grossAmount: 10,
    });
    expect(calculateReportGross(80, 80).grossAmount).toBe(40);
    expect(calculateReportGross(0.000001, 10).grossAmount).toBe(0.000001);
  });

  it("snapshots basis-point tax, settles atomically and makes duplicate decisions idempotent", async () => {
    const [{ getDb }, schema, { appRouter }] = await Promise.all([
      import("../queries/connection"),
      import("../../db/schema"),
      import("../router"),
    ]);
    const { users, sessions, adminSessions, reports, transactions, adminLogs, creditGrants } = schema;
    const db = getDb();
    const startingBalances = [100, 20, 100, 20, 20, 100, 20, 100, 80, 80, 80, 80, 100, 100, 20, 100];
    const createdUsers = await db.insert(users).values(startingBalances.map((balance, index) => ({
      linuxdoId: `report-${index + 1}`,
      username: `report-${index + 1}`,
      groupName: `举报测试${index + 1}`,
      balance,
    }))).returning();
    await db.insert(sessions).values(createdUsers.map((user, index) => ({
      token: `report-member-${index + 1}`,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    })));
    await db.insert(adminSessions).values({ token: "report-admin", expiresAt: new Date(Date.now() + 60_000) });

    const member = (index: number) => appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: `ld_session=report-member-${index + 1}` } }),
      resHeaders: new Headers(),
    });
    const admin = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_admin=report-admin" } }),
      resHeaders: new Headers(),
    });
    const unauthenticated = appRouter.createCaller({ req: new Request("http://localhost/api/trpc"), resHeaders: new Headers() });

    const setTax = async (reportTaxPercent: string) => {
      return admin.admin.reportSettings.update({ taxPercent: Number(reportTaxPercent) });
    };
    await expect(unauthenticated.admin.reportSettings.update({ taxPercent: 5 })).rejects.toThrow("需要管理员登录");
    await expect(setTax("100.01")).rejects.toThrow("0–100");
    await expect(setTax("5.555")).rejects.toThrow("举报税率最多保留两位小数");

    const cases = [
      { reporterIndex: 0, targetIndex: 1, success: true, percent: "0", basisPoints: 0, tax: 0, credited: 10, reporterBefore: 100, targetBefore: 20, lower: 20 },
      { reporterIndex: 2, targetIndex: 3, success: false, percent: "100", basisPoints: 10_000, tax: 10, credited: 0, reporterBefore: 100, targetBefore: 20, lower: 20 },
      { reporterIndex: 4, targetIndex: 5, success: true, percent: "12.34", basisPoints: 1_234, tax: 1.234, credited: 8.766, reporterBefore: 20, targetBefore: 100, lower: 20 },
      { reporterIndex: 6, targetIndex: 7, success: false, percent: "0", basisPoints: 0, tax: 0, credited: 10, reporterBefore: 20, targetBefore: 100, lower: 20 },
      { reporterIndex: 8, targetIndex: 9, success: true, percent: "100", basisPoints: 10_000, tax: 40, credited: 0, reporterBefore: 80, targetBefore: 80, lower: 80 },
      { reporterIndex: 10, targetIndex: 11, success: false, percent: "12.34", basisPoints: 1_234, tax: 4.936, credited: 35.064, reporterBefore: 80, targetBefore: 80, lower: 80 },
    ];
    for (const testCase of cases) {
      await setTax(testCase.percent);
      randomIntMock.mockReturnValueOnce(testCase.success ? 0 : 9_999);
      const requestId = randomUUID();
      const reporter = member(testCase.reporterIndex);
      const beforeBalances = await db.select({ id: users.id, balance: users.balance }).from(users);
      const result = await reporter.member.report({
        requestId,
        targetUserId: createdUsers[testCase.targetIndex].id,
      });
      expect(result).toMatchObject({
        success: testCase.success,
        reporterBalanceBefore: testCase.reporterBefore,
        targetBalanceBefore: testCase.targetBefore,
        lowerBalance: testCase.lower,
        grossAmount: testCase.lower / 2,
        deductedAmount: testCase.lower / 2,
        taxBasisPoints: testCase.basisPoints,
        tax: testCase.tax,
        creditedAmount: testCase.credited,
        amount: testCase.credited,
        idempotent: false,
      });
      expect(result.title).toBe(result.success ? "举报成功" : "非必要不举报");
      if (!result.success) expect(result.message).not.toContain("举报失败");
      const [stored] = await db.select().from(reports).where(eq(reports.requestId, requestId));
      expect(stored).toMatchObject({
        reporterBalanceBefore: testCase.reporterBefore,
        targetBalanceBefore: testCase.targetBefore,
        lowerBalance: testCase.lower,
        grossAmount: testCase.lower / 2,
        deductedAmount: testCase.lower / 2,
        taxBasisPoints: testCase.basisPoints,
        tax: testCase.tax,
        creditedAmount: testCase.credited,
        amount: testCase.credited,
      });
      const balancesAfter = await db.select({ id: users.id, balance: users.balance }).from(users);
      expect(balancesAfter.reduce((sum, row) => sum + row.balance, 0)).toBeCloseTo(
        beforeBalances.reduce((sum, row) => sum + row.balance, 0) - testCase.tax,
        6,
      );
      const reporterAfter = balancesAfter.find((row) => row.id === createdUsers[testCase.reporterIndex].id)!.balance;
      const targetAfter = balancesAfter.find((row) => row.id === createdUsers[testCase.targetIndex].id)!.balance;
      expect(reporterAfter).toBeCloseTo(testCase.reporterBefore + (testCase.success ? testCase.credited : -testCase.lower / 2), 6);
      expect(targetAfter).toBeCloseTo(testCase.targetBefore + (testCase.success ? -testCase.lower / 2 : testCase.credited), 6);
      const reporterTx = await db.select().from(transactions).where(eq(transactions.userId, createdUsers[testCase.reporterIndex].id));
      const targetTx = await db.select().from(transactions).where(eq(transactions.userId, createdUsers[testCase.targetIndex].id));
      expect(reporterTx).toHaveLength(1);
      expect(targetTx).toHaveLength(1);
      expect(reporterTx[0].amount).toBeCloseTo(testCase.success ? testCase.credited : -testCase.lower / 2, 6);
      expect(targetTx[0].amount).toBeCloseTo(testCase.success ? -testCase.lower / 2 : testCase.credited, 6);

      const repeat = await reporter.member.report({ requestId, targetUserId: createdUsers[testCase.targetIndex].id });
      expect(repeat).toMatchObject({
        idempotent: true,
        reporterBalanceBefore: testCase.reporterBefore,
        targetBalanceBefore: testCase.targetBefore,
        lowerBalance: testCase.lower,
        grossAmount: testCase.lower / 2,
        taxBasisPoints: testCase.basisPoints,
        tax: testCase.tax,
      });
      expect(await db.select().from(reports).where(eq(reports.requestId, requestId))).toHaveLength(1);
      await expect(member(12).member.report({ requestId, targetUserId: createdUsers[0].id })).rejects.toThrow("请求编号已被占用");
    }

    // 两个并发请求会由 SQLite 写事务串行化；后一笔必须读取前一笔提交后的余额，不能复用陈旧快照。
    await setTax("0");
    randomIntMock.mockReturnValueOnce(0).mockReturnValueOnce(0);
    const concurrent = await Promise.all([
      member(12).member.report({ requestId: randomUUID(), targetUserId: createdUsers[14].id }),
      member(13).member.report({ requestId: randomUUID(), targetUserId: createdUsers[14].id }),
    ]);
    expect(concurrent.map((result) => result.targetBalanceBefore)).toEqual([20, 10]);
    expect(concurrent.map((result) => result.lowerBalance)).toEqual([20, 10]);
    expect(concurrent.map((result) => result.grossAmount)).toEqual([10, 5]);
    expect((await db.select().from(users).where(eq(users.id, createdUsers[14].id)))[0].balance).toBe(5);

    await setTax("5");
    const snapshots = await db.select().from(reports);
    expect(snapshots.map((row) => row.taxBasisPoints)).toEqual([0, 10_000, 1_234, 0, 10_000, 1_234, 0, 0]);
    expect((await db.select().from(adminLogs)).some((row) => row.detail.includes("举报收益税率 12.34%"))).toBe(true);

    const untouched = createdUsers[15];
    await expect(member(15).member.report({ requestId: randomUUID(), targetUserId: 999_999 })).rejects.toThrow("对方不存在");
    expect((await db.select().from(users).where(eq(users.id, untouched.id)))[0].balance).toBe(100);

    // 举报资格和风险额只认永久额度；临时额度不能赋予举报资格，也不能成为可举报资产。
    const [temporaryReporter, directReporter, temporaryTarget, permanentTarget, mixedReporter, mixedTarget, mixedWinner] = await db.insert(users).values([
      { linuxdoId: "report-temp-reporter", username: "report-temp-reporter", groupName: "临时举报人", balance: 5 },
      { linuxdoId: "report-direct-reporter", username: "report-direct-reporter", groupName: "指定举报人", balance: 20 },
      { linuxdoId: "report-temp-target", username: "report-temp-target", groupName: "临时目标", balance: 5 },
      { linuxdoId: "report-permanent-target", username: "report-permanent-target", groupName: "永久目标", balance: 20 },
      { linuxdoId: "report-mixed-reporter", username: "report-mixed-reporter", groupName: "混合举报人", balance: 15 },
      { linuxdoId: "report-mixed-target", username: "report-mixed-target", groupName: "混合目标", balance: 15 },
      { linuxdoId: "report-mixed-winner", username: "report-mixed-winner", groupName: "混合对手", balance: 20 },
    ]).returning();
    const extraUsers = [temporaryReporter, directReporter, temporaryTarget, permanentTarget, mixedReporter, mixedTarget, mixedWinner];
    await db.insert(sessions).values(extraUsers.map((user) => ({
      token: `report-extra-${user.id}`,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    })));
    const extraMember = (userId: number) => appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: `ld_session=report-extra-${userId}` } }),
      resHeaders: new Headers(),
    });
    await db.insert(creditGrants).values([
      { redemptionId: 98_001, codeId: 98_001, code: "REPORT-TEMP-REPORTER", userId: temporaryReporter.id, originalUnits: 5_000_000, remainingUnits: 5_000_000, expiresAt: new Date(Date.now() + 60_000) },
      { redemptionId: 98_002, codeId: 98_002, code: "REPORT-TEMP-TARGET", userId: temporaryTarget.id, originalUnits: 5_000_000, remainingUnits: 5_000_000, expiresAt: new Date(Date.now() + 60_000) },
      { redemptionId: 98_003, codeId: 98_003, code: "REPORT-MIXED-REPORTER", userId: mixedReporter.id, originalUnits: 5_000_000, remainingUnits: 5_000_000, expiresAt: new Date(Date.now() + 60_000) },
      { redemptionId: 98_004, codeId: 98_004, code: "REPORT-MIXED-TARGET", userId: mixedTarget.id, originalUnits: 5_000_000, remainingUnits: 5_000_000, expiresAt: new Date(Date.now() + 60_000) },
    ]);

    await expect(extraMember(temporaryReporter.id).member.report({
      requestId: randomUUID(), targetUserId: permanentTarget.id,
    })).rejects.toThrow("永久可用额度必须大于 0");
    await expect(extraMember(directReporter.id).member.report({
      requestId: randomUUID(), targetUserId: temporaryTarget.id,
    })).rejects.toThrow("只能举报永久可用额度大于 0");

    // 仅保留一个永久目标与一个临时-only 目标；随机举报必须跳过临时-only 目标。
    await db.update(users).set({ banned: true });
    await db.update(users).set({ banned: false }).where(eq(users.id, directReporter.id));
    await db.update(users).set({ banned: false }).where(eq(users.id, temporaryTarget.id));
    await db.update(users).set({ banned: false }).where(eq(users.id, permanentTarget.id));
    randomIntMock.mockReturnValueOnce(0).mockReturnValueOnce(0);
    const randomResult = await extraMember(directReporter.id).member.report({ requestId: randomUUID() });
    expect(randomResult.targetName).toBe("永久目标");

    await db.update(users).set({ banned: false }).where(eq(users.id, mixedReporter.id));
    await db.update(users).set({ banned: false }).where(eq(users.id, mixedTarget.id));
    await db.update(users).set({ banned: false }).where(eq(users.id, mixedWinner.id));

    // 举报失败：混合举报人输 5 永久额度，临时桶 remainingUnits 必须原样保留。
    randomIntMock.mockReturnValueOnce(9_999);
    const mixedReporterGrantBefore = (await db.select().from(creditGrants).where(eq(creditGrants.userId, mixedReporter.id)))[0].remainingUnits;
    const mixedFailure = await extraMember(mixedReporter.id).member.report({ requestId: randomUUID(), targetUserId: mixedWinner.id });
    expect(mixedFailure).toMatchObject({ success: false, reporterBalanceBefore: 10, grossAmount: 5 });
    expect((await db.select().from(users).where(eq(users.id, mixedReporter.id)))[0].balance).toBe(10);
    expect((await db.select().from(creditGrants).where(eq(creditGrants.userId, mixedReporter.id)))[0].remainingUnits).toBe(mixedReporterGrantBefore);

    // 举报成功：混合目标输 5 永久额度，临时桶不能被消费或洗成赢家永久额度之外的资金。
    randomIntMock.mockReturnValueOnce(0);
    const mixedTargetGrantBefore = (await db.select().from(creditGrants).where(eq(creditGrants.userId, mixedTarget.id)))[0].remainingUnits;
    const winnerBefore = (await db.select().from(users).where(eq(users.id, mixedWinner.id)))[0].balance;
    const mixedSuccess = await extraMember(mixedWinner.id).member.report({ requestId: randomUUID(), targetUserId: mixedTarget.id });
    expect(mixedSuccess).toMatchObject({ success: true, targetBalanceBefore: 10, grossAmount: 5 });
    expect((await db.select().from(users).where(eq(users.id, mixedTarget.id)))[0].balance).toBe(10);
    expect((await db.select().from(creditGrants).where(eq(creditGrants.userId, mixedTarget.id)))[0].remainingUnits).toBe(mixedTargetGrantBefore);
    expect((await db.select().from(users).where(eq(users.id, mixedWinner.id)))[0].balance).toBeCloseTo(winnerBefore + mixedSuccess.creditedAmount, 6);
  });
});
