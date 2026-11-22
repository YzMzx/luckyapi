import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { memberQuery } from "../auth";
import { createRouter } from "../middleware";
import { getDb } from "../queries/connection";
import { readControlState, readUserPolicy } from "../queries/policies";
import { readPerpConfig, perpSymbolSchema as symbol } from "../perp/config";
import {
  exchangePerp,
  getPerpAccount,
  PerpRuleError,
  PerpExchangeQuoteChanged,
  placePerpOrder,
  previewPerpExchange,
} from "../perp/engine";
import { getPerpMarket, getPerpQuote, getPerpInstrument } from "../perp/market";
import { refreshPerpMaintenance } from "../perp/maintenance";
import { getPerpWeeklyBoard, listPerpWeeks } from "../perp/weekly";

const units = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const requestKey = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[a-zA-Z0-9:_-]+$/);
const exchangeInput = z.object({
  direction: z.enum(["in", "out"]),
  amountUnits: units,
});

function assertWriteAccess(userId: number) {
  const db = getDb();
  const policy = readUserPolicy(db, userId);
  if (policy.allFrozen || policy.financeFrozen || policy.entertainmentFrozen) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "账户的金融或娱乐操作权限已被冻结",
    });
  }
  if (readControlState(db).maintenance)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "系统维护中，请稍后重试",
    });
}
async function applyRule<T>(action: () => T | Promise<T>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof PerpExchangeQuoteChanged)
      throw new TRPCError({ code: "CONFLICT", message: error.message });
    if (error instanceof PerpRuleError)
      throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
    throw error;
  }
}

export const perpRouter = createRouter({
  symbols: memberQuery.query(() => readPerpConfig(getDb().$client).symbols),
  market: memberQuery.input(z.object({ symbol })).query(async ({ input }) => {
    const db = getDb().$client;
    const market = await getPerpMarket(db, input.symbol);
    const config = readPerpConfig(db);
    return {
      ...market,
      tradingEnabled:
        config.tradingEnabled &&
        config.symbols.some(s => s.symbol === input.symbol && s.openEnabled),
    };
  }),
  account: memberQuery.query(({ ctx }) => {
    const db = getDb().$client;
    void refreshPerpMaintenance(db);
    const config = readPerpConfig(db);
    return {
      ...getPerpAccount(db, ctx.user.id),
      config,
      depositsEnabled: config.depositsEnabled,
      tradingEnabled: config.tradingEnabled,
    };
  }),
  exchangePreview: memberQuery
    .input(exchangeInput)
    .query(({ input }) =>
      applyRule(() =>
        previewPerpExchange(
          input.direction,
          input.amountUnits,
          readPerpConfig(getDb().$client)
        )
      )
    ),
  exchange: memberQuery
    .input(
      exchangeInput.extend({
        requestKey,
        expectedExchangeRate: z.number().int().min(1).max(1_000_000),
        expectedRedemptionFeeBps: z.number().int().min(0).max(9999),
      })
    )
    .mutation(({ ctx, input }) => {
      assertWriteAccess(ctx.user.id);
      const db = getDb().$client;
      return applyRule(() => exchangePerp(db, ctx.user.id, input));
    }),
  placeOrder: memberQuery
    .input(
      z.object({
        symbol,
        action: z.enum(["openLong", "openShort", "close"]),
        quantityAtoms: units,
        leverage: z
          .union([z.literal(1), z.literal(2), z.literal(5)])
          .optional(),
        requestKey,
      })
    )
    .mutation(({ ctx, input }) => {
      assertWriteAccess(ctx.user.id);
      const db = getDb().$client;
      return applyRule(() =>
        placePerpOrder(db, ctx.user.id, input, async (ticker, afterMs) => {
          const [quote, instrument] = await Promise.all([
            getPerpQuote(db, ticker, afterMs),
            getPerpInstrument(db, ticker),
          ]);
          if (!quote || !instrument) return null;
          if (
            input.quantityAtoms > instrument.maxQtyUnits ||
            (input.leverage ?? 1) > instrument.maxLeverage
          ) {
            throw new PerpRuleError("数量或杠杆超过该合约当前允许范围");
          }
          return {
            ...quote,
            qtyStepAtoms: instrument.qtyStepUnits,
            minQtyAtoms: instrument.minQtyUnits,
            maxQtyAtoms: instrument.maxQtyUnits,
            minNotionalUnits: instrument.minNotionalUnits,
            maxLeverage: instrument.maxLeverage,
          };
        })
      );
    }),
  weeks: memberQuery
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).optional(),
          offset: z.number().int().min(0).optional(),
        })
        .optional()
    )
    .query(({ input }) => {
      const db = getDb().$client;
      void refreshPerpMaintenance(db);
      return listPerpWeeks(db, input);
    }),
  weekBoard: memberQuery
    .input(
      z.object({
        weekStart: units,
        side: z.enum(["profit", "loss"]),
        page: z.number().int().min(1).max(1_000_000).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
      })
    )
    .query(({ ctx, input }) =>
      getPerpWeeklyBoard(getDb().$client, { ...input, userId: ctx.user.id })
    ),
});
