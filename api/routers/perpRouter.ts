import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  DEFAULT_PERP_KLINE_INTERVAL,
  PERP_KLINE_INTERVALS,
} from "@contracts/perp-kline";
import { perpHeartbeat, positionSquare } from "./perpSquare";
import { memberQuery } from "../auth";
import { createRouter } from "../middleware";
import { getDb } from "../queries/connection";
import { readControlState, readUserPolicy } from "../queries/policies";
import {
  readPerpConfig,
  perpLeverageSchema,
  perpSymbolSchema as symbol,
} from "../perp/config";
import {
  exchangePerp,
  getPerpAccount,
  PerpRuleError,
  PerpExchangeQuoteChanged,
  placePerpOrder,
  previewPerpExchangeForUser,
} from "../perp/engine";
import {
  getPerpMarket,
  getPerpQuoteStatus,
  getPerpInstrument,
} from "../perp/market";
import {
  createPending,
  cancelPending,
  listPending,
  replayPending,
} from "../perp/pending";
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

const baseOrder = z.object({
  symbol,
  action: z.enum(["openLong", "openShort", "close"]),
  quantityAtoms: units,
  leverage: perpLeverageSchema.optional(),
  requestKey,
});
const trigger = {
  triggerPriceUnits: units,
  triggerDirection: z.enum(["above", "below"]),
};
const pendingInput = z.discriminatedUnion("kind", [
  baseOrder
    .extend({ kind: z.literal("limit"), limitPriceUnits: units })
    .strict(),
  baseOrder
    .extend({ kind: z.literal("conditionalMarket"), ...trigger })
    .strict(),
  baseOrder
    .extend({
      kind: z.literal("conditionalLimit"),
      limitPriceUnits: units,
      ...trigger,
    })
    .strict(),
]);
async function loadSnapshot(
  db: ReturnType<typeof getDb>["$client"],
  ticker: string,
  afterMs?: number
) {
  const [{ quote: q, readOnlyReason }, i] = await Promise.all([
    getPerpQuoteStatus(db, ticker, afterMs),
    getPerpInstrument(db, ticker),
  ]);
  if (readOnlyReason) throw new PerpRuleError(readOnlyReason);
  return q && i
    ? {
        ...q,
        qtyStepAtoms: i.qtyStepUnits,
        minQtyAtoms: i.minQtyUnits,
        maxQtyAtoms: i.maxQtyUnits,
        minNotionalUnits: i.minNotionalUnits,
        maxLeverage: i.maxLeverage,
        tickSizeUnits: i.tickSizeUnits,
      }
    : null;
}
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
  heartbeat: perpHeartbeat,
  positionSquare,
  symbols: memberQuery.query(() => readPerpConfig(getDb().$client).symbols),
  market: memberQuery
    .input(
      z.object({
        symbol,
        interval: z
          .literal(PERP_KLINE_INTERVALS)
          .default(DEFAULT_PERP_KLINE_INTERVAL),
      })
    )
    .query(async ({ input }) => {
      const db = getDb().$client;
      const market = await getPerpMarket(db, input.symbol, input.interval);
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
    .query(({ ctx, input }) =>
      applyRule(() =>
        previewPerpExchangeForUser(
          getDb().$client,
          ctx.user.id,
          input.direction,
          input.amountUnits
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
  placeOrder: memberQuery.input(baseOrder).mutation(({ ctx, input }) => {
    assertWriteAccess(ctx.user.id);
    const db = getDb().$client;
    return applyRule(() =>
      placePerpOrder(db, ctx.user.id, input, (ticker, afterMs) =>
        loadSnapshot(db, ticker, afterMs)
      )
    );
  }),
  pendingOrders: memberQuery.query(({ ctx }) => {
    const db = getDb().$client;
    void refreshPerpMaintenance(db);
    return listPending(db, ctx.user.id);
  }),
  cancelPending: memberQuery
    .input(z.object({ id: units }))
    .mutation(({ ctx, input }) =>
      // Cancelling only reduces exposure; it remains available while opening is paused.
      applyRule(() => cancelPending(getDb().$client, ctx.user.id, input.id))
    ),
  createPending: memberQuery.input(pendingInput).mutation(({ ctx, input }) => {
    assertWriteAccess(ctx.user.id);
    const db = getDb().$client;
    const { kind, ...parameters } = input;
    const order = {
      ...parameters,
      orderType:
        kind === "limit" ? ("limit" as const) : ("conditional" as const),
    };
    return applyRule(async () => {
      const prior = replayPending(db, ctx.user.id, order);
      if (prior) return prior;
      const cfg = readPerpConfig(db),
        listed = cfg.symbols.find(s => s.symbol === order.symbol);
      if (
        !listed ||
        (order.action !== "close" &&
          (!listed.openEnabled || !cfg.tradingEnabled))
      )
        throw new PerpRuleError("合约未开放或已暂停开仓");
      return createPending(
        db,
        ctx.user.id,
        order,
        await loadSnapshot(db, order.symbol)
      );
    });
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
