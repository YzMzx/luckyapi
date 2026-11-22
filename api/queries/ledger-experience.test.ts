import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";
import {
  experienceEvents,
  levelProfiles,
  transactions,
  users,
  sessions,
  adminSessions,
  peerLoans,
  apiKeys,
  upstreams,
  models,
} from "@db/schema";
import type { TxKind } from "./ledger";

const directory = mkdtempSync(join(tmpdir(), "lucky-ledger-exp-"));
vi.stubEnv("SQLITE_PATH", join(directory, "ledger.db"));
const { getDb } = await import("./connection");
const { recordTx } = await import("./ledger");
const db = getDb();
afterAll(() => {
  db.$client.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function events(userId: number) {
  return db
    .select()
    .from(experienceEvents)
    .where(eq(experienceEvents.userId, userId))
    .orderBy(experienceEvents.id)
    .all();
}

async function member(account: string) {
  const user = db
    .insert(users)
    .values({
      linuxdoId: account,
      username: account,
      groupName: account,
      balance: 100,
    })
    .returning()
    .get();
  const token = randomUUID();
  db.insert(sessions)
    .values({
      token,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    })
    .run();
  const { appRouter } = await import("../router");
  const caller = appRouter.createCaller({
    req: new Request("http://localhost/api/trpc", {
      headers: { cookie: `ld_session=${token}` },
    }),
    resHeaders: new Headers(),
  });
  return { user, caller };
}

it("awards reward credits and excludes transfers, refunds, costs and lost bets", () => {
  const { id } = db
    .insert(users)
    .values({ linuxdoId: "policy", username: "policy" })
    .returning()
    .get();
  const rewards: TxKind[] = ["draw", "checkin", "video_reward", "redeem"];
  const excluded: [TxKind, number][] = [
    ["transfer_in", 20],
    ["transfer_out", -20],
    ["loan_disbursement", 20],
    ["loan_offer_refund", 20],
    ["loan_repayment", 20],
    ["loan_due", -20],
    ["duel", 20],
    ["adjust", 20],
    ["credit_expire", -1],
    ["permanent_debit", -1],
    ["checkin", -1],
    ["checkin", 0],
    ["usage", 0],
  ];
  db.transaction(tx => {
    for (const kind of rewards) recordTx(tx, id, kind, 0.1, "reward");
    for (const [kind, amount] of excluded)
      recordTx(tx, id, kind, amount, "no reward");
  });
  expect(events(id).map(row => row.amount)).toEqual([10, 10, 10, 10]);
  expect(() =>
    db.transaction(tx => {
      tx.update(users).set({ balance: 100 }).where(eq(users.id, id)).run();
      recordTx(tx, id, "draw", 100, "rolled back");
      throw new Error("abort settlement");
    })
  ).toThrow("abort settlement");
  expect(events(id)).toHaveLength(4);
  expect(
    db.select().from(levelProfiles).where(eq(levelProfiles.userId, id)).get()
      ?.totalExp
  ).toBe(40);
  expect(db.select().from(users).where(eq(users.id, id)).get()?.balance).toBe(
    0
  );
  expect(
    db.select().from(transactions).where(eq(transactions.userId, id)).all()
  ).toHaveLength(rewards.length + excluded.length);
});

it("awards a positive admin grant and skips a balance correction triggered by a debit", async () => {
  const { appRouter } = await import("../router");
  const { id } = db
    .insert(users)
    .values({ linuxdoId: "admin-grant", username: "admin-grant", balance: -4 })
    .returning()
    .get();
  const token = randomUUID();
  db.insert(adminSessions)
    .values({ token, expiresAt: new Date(Date.now() + 60_000) })
    .run();
  const admin = appRouter.createCaller({
    req: new Request("http://localhost/api/trpc", {
      headers: { cookie: `ld_admin=${token}` },
    }),
    resHeaders: new Headers(),
  });
  // A negative adjustment on a debtor can still write a positive ledger amount due to the zero floor.
  await expect(
    admin.admin.adjustBalance({ userId: id, delta: -1 })
  ).resolves.toMatchObject({ actualDelta: 4 });
  db.update(users).set({ balance: -4 }).where(eq(users.id, id)).run();
  await expect(
    admin.admin.adjustBalance({ userId: id, delta: 0.125 })
  ).resolves.toMatchObject({ actualDelta: 4 });
  expect(events(id)).toMatchObject([{ usdUnits: 125_000, amount: 12 }]);
});

it("awards the lender only the collected after-tax interest, once across retries", async () => {
  const lender = await member("8101"),
    borrower = await member("8102");
  const monthMs = 30 * 86_400_000;
  const offer = await lender.caller.finance.createLoan({
    borrowerAccountId: "8102",
    principal: 10,
    monthlyRatePercent: 10,
    dueAt: new Date(Date.now() + monthMs),
    requestId: randomUUID(),
  });
  await borrower.caller.finance.acceptLoan({ loanId: offer.id });
  const now = Date.now();
  db.update(peerLoans)
    .set({ acceptedAt: new Date(now - monthMs), dueAt: new Date(now) })
    .where(eq(peerLoans.id, offer.id))
    .run();
  const { processDueLoans } = await import("../routers/financeRouter");
  processDueLoans(new Date(now));
  processDueLoans(new Date(now + 1));
  expect(events(borrower.user.id)).toEqual([]);
  expect(events(lender.user.id)).toMatchObject([
    { amount: 90, usdUnits: 900_000 },
  ]);
  expect(
    db
      .select()
      .from(transactions)
      .where(eq(transactions.userId, lender.user.id))
      .all()
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "loan_repayment", amount: 10.9 }),
    ])
  );
});

it("awards only the dice winner's payout less the escrowed stake", async () => {
  const first = await member("8103"),
    second = await member("8104");
  const config = await first.caller.duel.config();
  const room = await first.caller.duel.create({
    requestId: randomUUID(),
    game: "dice",
    visibility: "private",
    bet: 1,
    maxPlayers: 2,
    expectedConfigVersion: config.version,
  });
  await second.caller.duel.join({ requestId: randomUUID(), code: room.code });
  await first.caller.duel.setReady({
    roomId: room.id,
    requestId: randomUUID(),
    ready: true,
  });
  let result = await second.caller.duel.setReady({
    roomId: room.id,
    requestId: randomUUID(),
    ready: true,
  });
  for (let rolls = 0; result.status === "active" && rolls < 20; rolls++) {
    result = await first.caller.duel.rollDice({
      roomId: room.id,
      requestId: randomUUID(),
    });
  }
  expect(result.status).toBe("settled");
  for (const player of result.players) {
    expect(events(player.userId).map(row => row.amount)).toEqual(
      player.result === "win" ? [94] : []
    );
  }
});

it("awards only the API charge that survives quota clamping; upstream errors earn zero", async () => {
  const { gatewayApp } = await import("../routes/gateway");
  const { sha256 } = await import("../auth");
  const { id } = db
    .insert(users)
    .values({
      linuxdoId: "api-usage",
      username: "api",
      groupName: "api",
      balance: 5,
    })
    .returning()
    .get();
  const token = "sk-ledger-experience";
  db.insert(apiKeys)
    .values({
      userId: id,
      name: "key",
      prefix: "sk-ledge",
      keyHash: sha256(token),
      quota: 0.2,
    })
    .run();
  const upstream = db
    .insert(upstreams)
    .values({
      name: "ledger-upstream",
      baseUrl: "https://example.invalid",
      apiKey: "local",
    })
    .returning()
    .get();
  db.insert(models)
    .values({
      name: "ledger-model",
      upstreamId: upstream.id,
      upstreamModel: "model",
      priceInput: 1000,
      priceOutput: 0,
    })
    .run();
  const request = () =>
    gatewayApp.request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "ledger-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
  const upstreamFetch = vi.spyOn(globalThis, "fetch");
  try {
    upstreamFetch.mockResolvedValueOnce(
      new Response("upstream error", { status: 503 })
    );
    expect((await request()).status).toBe(503);
    expect(events(id)).toEqual([]);
    upstreamFetch.mockResolvedValueOnce(
      Response.json({
        choices: [],
        usage: { prompt_tokens: 1000, completion_tokens: 0 },
      })
    );
    expect((await request()).status).toBe(200);
  } finally {
    upstreamFetch.mockRestore();
  }
  const charge = db
    .select()
    .from(transactions)
    .where(eq(transactions.userId, id))
    .get();
  expect(charge).toMatchObject({ kind: "usage", amount: -0.2 });
  expect(events(id)).toMatchObject([
    {
      eventKey: `api_usage:ledger:${charge!.id}`,
      amount: 2,
      usdUnits: 200_000,
    },
  ]);
});
