import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

process.env.SQLITE_PATH = join(tmpdir(), `lucky-gateway-settlement-${process.pid}-${Date.now()}.db`);

describe("gateway settlement transaction", () => {
  it("clamps one atomic charge to the available key quota and keeps balance, ledger and log aligned", async () => {
    const [{ getDb }, schema, { gatewayApp }, { sha256 }] = await Promise.all([
      import("../queries/connection"),
      import("../../db/schema"),
      import("./gateway"),
      import("../auth"),
    ]);
    const { users, apiKeys, upstreams, models, transactions, usageLogs } = schema;
    const db = getDb();
    const [user] = await db.insert(users).values({ linuxdoId: "gateway-settlement", username: "gateway-settlement", groupName: "网关守恒", balance: 0.1 }).returning();
    const token = "sk-gateway-settlement";
    const [key] = await db.insert(apiKeys).values({ userId: user.id, name: "限额 Key", prefix: "sk-gatew", keyHash: sha256(token), quota: 0.08 }).returning();
    const [upstream] = await db.insert(upstreams).values({ name: "测试上游", baseUrl: "https://upstream.example", apiKey: "upstream-secret" }).returning();
    await db.insert(models).values({
      name: "settlement-model",
      upstreamId: upstream.id,
      upstreamModel: "settlement-model",
      priceInput: 1000,
      priceOutput: 0,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 1000, completion_tokens: 0 },
    }), { status: 200, headers: { "content-type": "application/json" } });
    try {
      const response = await gatewayApp.request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "settlement-model", messages: [{ role: "user", content: "hello" }] }),
      });
      expect(response.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const updatedUser = (await db.select().from(users).where(eq(users.id, user.id)))[0];
    const updatedKey = (await db.select().from(apiKeys).where(eq(apiKeys.id, key.id)))[0];
    const ledger = await db.select().from(transactions).where(eq(transactions.userId, user.id));
    const logs = await db.select().from(usageLogs).where(eq(usageLogs.userId, user.id));
    expect(updatedUser.balance).toBeCloseTo(0.02, 8);
    expect(updatedKey.quota).toBe(0);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ kind: "usage", amount: -0.08 });
    expect(ledger[0].balanceAfter).toBeCloseTo(updatedUser.balance, 8);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ cost: 0.08, inputCost: 0.08, status: "ok" });
  });
});
