import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, gte, sql } from "drizzle-orm";
import { createHash, randomInt as secureRandomInt } from "node:crypto";
import { getDb } from "../queries/connection";
import { recordTx } from "../queries/ledger";
import { drawFund, draws, users } from "../../db/schema";
import { createRouter } from "../middleware";
import { clientIp, memberQuery } from "../auth";
import { readDrawConfig } from "../queries/entertainment-control";
import { centsToDollars } from "@contracts/entertainment";
import { SLOT_SYMBOLS, type SlotSymbols } from "@contracts/slot-machine";
import { assertModuleAvailable } from "../queries/policies";

function drawSymbols(row: typeof draws.$inferSelect): SlotSymbols {
  const seed = `${row.requestId ?? "legacy"}|${row.id}|${row.userId ?? "anonymous"}|${row.createdAt.getTime()}|${row.won}`;
  const digest = createHash("sha256").update(seed).digest();
  const pick = (offset: number, length: number) => digest.readUInt32BE(offset) % length;
  if (row.won) {
    const symbol = SLOT_SYMBOLS[pick(0, SLOT_SYMBOLS.length)].id;
    return [symbol, symbol, symbol];
  }
  const ids = SLOT_SYMBOLS.map((symbol) => symbol.id);
  const result: SlotSymbols = [ids[pick(0, ids.length)], ids[pick(4, ids.length)], ids[pick(8, ids.length)]];
  if (result[0] === result[1] && result[1] === result[2]) {
    const index = ids.indexOf(result[2]);
    result[2] = ids[(index + 1 + pick(12, ids.length - 1)) % ids.length];
  }
  return result;
}

function drawResult(row: typeof draws.$inferSelect, idempotent: boolean) {
  return {
    result: row.won ? "won" as const : "not_won" as const,
    participated: true,
    won: row.won,
    amount: row.amount,
    symbols: drawSymbols(row),
    requestId: row.requestId,
    createdAt: row.createdAt,
    idempotent,
    message: row.won
      ? `恭喜！抽中 $${Number(row.amount ?? 0).toFixed(2)} 额度`
      : "本次未中奖，感谢参与",
  };
}

export const drawRouter = createRouter({
  status: memberQuery.query(({ ctx }) => getDb().transaction((tx) => {
    const config = readDrawConfig(tx);
    const row = tx.select().from(draws).where(eq(draws.userId, ctx.user.id)).limit(1).get();
    const fund = tx.select().from(drawFund).where(eq(drawFund.id, 1)).limit(1).get();
    const used = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(draws)
      .where(sql`${draws.userId} IS NOT NULL`).get()?.n ?? 0);
    const capacityAvailable = config.totalLimit === 0 || used < config.totalLimit;
    const budgetAvailable = config.ratePpm === 0 || Number(fund?.balanceUnits ?? 0) >= config.minUnits;
    return {
      enabled: config.enabled,
      participated: !!row,
      result: row ? drawResult(row, true) : null,
      canDraw: config.enabled && !row && capacityAvailable && budgetAvailable,
      unavailableReason: row
        ? "already_participated" as const
        : !config.enabled
          ? "disabled" as const
          : !capacityAvailable
            ? "total_limit_reached" as const
            : !budgetAvailable
              ? "budget_exhausted" as const
              : null,
      config: {
        winRatePercent: config.ratePercent,
        minReward: centsToDollars(config.minUnits),
        maxReward: centsToDollars(config.maxUnits),
        totalLimit: config.totalLimit || null,
        used,
        remainingBudget: centsToDollars(Number(fund?.balanceUnits ?? 0)),
      },
    };
  })),

  draw: memberQuery
    .input(z.object({ requestId: z.string().uuid() }))
    .mutation(({ ctx, input }) => getDb().transaction((tx) => {
      assertModuleAvailable(tx, "draw", ctx.user.id);
      const request = tx.select().from(draws).where(eq(draws.requestId, input.requestId)).limit(1).get();
      if (request) {
        if (request.userId !== ctx.user.id)
          throw new TRPCError({ code: "CONFLICT", message: "请求编号已被占用" });
        return drawResult(request, true);
      }
      const participated = tx.select().from(draws).where(eq(draws.userId, ctx.user.id)).limit(1).get();
      if (participated) return drawResult(participated, true);

      const config = readDrawConfig(tx);
      if (!config.enabled) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "一次性抽奖暂未开放" });
      const used = Number(tx.select({ n: sql<number>`COUNT(*)` }).from(draws)
        .where(sql`${draws.userId} IS NOT NULL`).get()?.n ?? 0);
      if (config.totalLimit > 0 && used >= config.totalLimit)
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "本期抽奖名额已用完" });

      const fund = tx.select().from(drawFund).where(eq(drawFund.id, 1)).limit(1).get();
      const fundBeforeUnits = Number(fund?.balanceUnits ?? 0);
      if (config.ratePpm > 0 && fundBeforeUnits < config.minUnits)
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "本期抽奖预算已用完" });
      const won = secureRandomInt(1_000_000) < config.ratePpm;
      const affordableMax = Math.min(config.maxUnits, fundBeforeUnits);
      const rewardUnits = won ? secureRandomInt(config.minUnits, affordableMax + 1) : 0;
      const amount = won ? centsToDollars(rewardUnits) : null;
      const fundAfterUnits = fundBeforeUnits - rewardUnits;
      const snapshot = JSON.stringify({
        enabled: config.enabled,
        ratePpm: config.ratePpm,
        minUnits: config.minUnits,
        maxUnits: config.maxUnits,
        totalLimit: config.totalLimit,
      });

      let created: typeof draws.$inferSelect;
      try {
        created = tx.insert(draws).values({
          requestId: input.requestId,
          ip: clientIp(ctx.req),
          userId: ctx.user.id,
          won,
          amount,
          configSnapshot: snapshot,
          fundBeforeUnits,
          fundAfterUnits,
        }).returning().get();
      } catch {
        const raced = tx.select().from(draws).where(eq(draws.userId, ctx.user.id)).limit(1).get();
        if (raced) return drawResult(raced, true);
        throw new TRPCError({ code: "CONFLICT", message: "抽奖请求冲突，请刷新后查看结果" });
      }

      if (won) {
        const funded = tx.update(drawFund).set({
          balanceUnits: sql`${drawFund.balanceUnits} - ${rewardUnits}`,
          updatedAt: new Date(),
        }).where(and(eq(drawFund.id, 1), gte(drawFund.balanceUnits, rewardUnits))).run();
        if (funded.changes !== 1)
          throw new TRPCError({ code: "CONFLICT", message: "抽奖预算刚刚发生变化，请重试" });
        tx.update(users).set({
          hasWon: true,
          balance: sql`${users.balance} + ${amount!}`,
          totalWon: sql`${users.totalWon} + ${amount!}`,
        }).where(eq(users.id, ctx.user.id)).run();
        recordTx(tx, ctx.user.id, "draw", amount!, `一次性抽奖中奖（请求 ${input.requestId}）`);
      }
      return drawResult(created, false);
    })),
});
