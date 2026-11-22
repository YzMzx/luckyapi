import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminQuery } from "../auth";
import { createRouter } from "../middleware";
import { getDb } from "../queries/connection";
import {
  PerpConfigError,
  perpSettingsInput,
  readPerpConfig,
  verifyAndSavePerpConfig,
  requireVerifiedPerpInstrument,
  perpSymbolSchema,
} from "../perp/config";

export const perpSettingsAdminRouter = createRouter({
  get: adminQuery.query(() => readPerpConfig(getDb().$client)),
  lookup: adminQuery
    .input(z.object({ symbol: perpSymbolSchema }))
    .query(async ({ input }) => {
      try {
        return await requireVerifiedPerpInstrument(
          getDb().$client,
          input.symbol
        );
      } catch (cause) {
        if (cause instanceof PerpConfigError)
          throw new TRPCError({ code: "BAD_REQUEST", message: cause.message });
        throw cause;
      }
    }),
  update: adminQuery.input(perpSettingsInput).mutation(async ({ input }) => {
    try {
      return await verifyAndSavePerpConfig(getDb().$client, input);
    } catch (cause) {
      if (cause instanceof PerpConfigError)
        throw new TRPCError({ code: "BAD_REQUEST", message: cause.message });
      throw cause;
    }
  }),
});
