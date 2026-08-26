import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

process.env.SQLITE_PATH = join(tmpdir(), `lucky-balance-ledger-${process.pid}-${Date.now()}.db`);

describe("balance and ledger conservation", () => {
  it("records the actual clamped admin adjustment in one transaction", async () => {
    const [{ getDb }, schema, { appRouter }] = await Promise.all([
      import("../queries/connection"),
      import("../../db/schema"),
      import("../router"),
    ]);
    const { users, adminSessions, transactions, adminLogs } = schema;
    const db = getDb();
    const [user] = await db.insert(users).values({ linuxdoId: "balance-ledger", username: "balance-ledger", groupName: "守恒测试", balance: 3 }).returning();
    await db.insert(adminSessions).values({ token: "balance-ledger-admin", expiresAt: new Date(Date.now() + 60_000) });
    const admin = appRouter.createCaller({
      req: new Request("http://localhost/api/trpc", { headers: { cookie: "ld_admin=balance-ledger-admin" } }),
      resHeaders: new Headers(),
    });

    await expect(admin.admin.adjustBalance({ userId: user.id, delta: -10 })).resolves.toMatchObject({
      balanceBefore: 3,
      balanceAfter: 0,
      actualDelta: -3,
    });
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].balance).toBe(0);
    const ledger = await db.select().from(transactions).where(eq(transactions.userId, user.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ amount: -3, balanceAfter: 0 });
    expect((await db.select().from(adminLogs)).some((row) => row.action === "调整余额" && row.detail.includes("实际 -3"))).toBe(true);
  });
});
