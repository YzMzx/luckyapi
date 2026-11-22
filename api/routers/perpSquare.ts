import { z } from "zod";
import { memberQuery } from "../auth";
import { getDb } from "../queries/connection";
import { paginationInput, resolvePagination } from "../pagination";
import { perpSymbolSchema } from "../perp/config";
import { loadPositionQuotes, valueOpenPosition } from "../perp/valuation";

const onlineWindow = 90_000;
export const perpHeartbeat = memberQuery.mutation(({ ctx }) => {
  const now = Date.now();
  getDb()
    .$client.prepare(
      "INSERT INTO perp_presence(user_id,seen_at) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET seen_at=excluded.seen_at WHERE perp_presence.seen_at<=?"
    )
    .run(ctx.user.id, now, now - 15_000);
  return { ok: true };
});
// This member projection intentionally excludes identifiers, balances and exact activity times.
export const positionSquare = memberQuery
  .input(
    paginationInput.extend({
      onlineOnly: z.boolean().default(false),
      symbol: perpSymbolSchema.optional(),
    })
  )
  .query(async ({ ctx, input }) => {
    const db = getDb().$client;
    const cutoff = Date.now() - onlineWindow;
    const from =
      " FROM perp_positions p JOIN users u ON u.id=p.user_id LEFT JOIN perp_presence s ON s.user_id=p.user_id WHERE p.quantity_atoms>0 AND u.banned=0 AND u.group_name IS NOT NULL";
    const { rows, ...result } = db.transaction(() => {
      // Keep all visible contracts selectable even while a single contract or online players are selected.
      const categories = db
        .prepare(
          "SELECT p.symbol, count(*) AS total" +
            from +
            " GROUP BY p.symbol ORDER BY p.symbol"
        )
        .all() as { symbol: string; total: number }[];
      const scopedFrom = from + (input.symbol ? " AND p.symbol=?" : "");
      const scopeArgs = input.symbol ? [input.symbol] : [];
      const onlineHolders = Number(
        db
          .prepare(
            "SELECT count(DISTINCT p.user_id)" + scopedFrom + " AND s.seen_at>?"
          )
          .pluck()
          .get(...scopeArgs, cutoff)
      );
      const filter = input.onlineOnly ? " AND s.seen_at>?" : "",
        args = input.onlineOnly ? [...scopeArgs, cutoff] : scopeArgs;
      const total = Number(
        db
          .prepare("SELECT count(*)" + scopedFrom + filter)
          .pluck()
          .get(...args)
      );
      const { page, pageSize, totalPages, offset } = resolvePagination(
        total,
        input.page,
        input.pageSize
      );
      type Row = {
        nickname: string;
        symbol: string;
        side: "long" | "short";
        quantityAtoms: number;
        entryUnits: number;
        updatedAt: number;
        leverage: number;
        online: number;
        mine: number;
      };
      const rows = db
        .prepare(
          "SELECT u.group_name AS nickname,p.symbol,p.side,p.quantity_atoms AS quantityAtoms,p.entry_units AS entryUnits,p.updated_at AS updatedAt,p.leverage,COALESCE(s.seen_at>?,0) AS online,p.user_id=? AS mine" +
            scopedFrom +
            filter +
            " ORDER BY p.updated_at DESC,p.user_id,p.symbol LIMIT ? OFFSET ?"
        )
        .all(cutoff, ctx.user.id, ...args, pageSize, offset) as Row[];
      return {
        rows,
        categories,
        onlineHolders,
        page,
        pageSize,
        totalPages,
        total,
      };
    })();
    const quotes = await loadPositionQuotes(db, rows);
    const now = Date.now();
    const items = rows.map(r => {
      const value = valueOpenPosition(r, quotes.get(r.symbol), now);
      const mark = value?.markPriceUnits ?? null;
      const pnl = value ? Number(value.pnl) : null;
      const qty = BigInt(r.quantityAtoms),
        entry = BigInt(r.entryUnits);
      return {
        nickname: r.nickname,
        symbol: r.symbol,
        side: r.side,
        quantityAtoms: r.quantityAtoms,
        leverage: r.leverage,
        entryPriceUnits: Number((entry * 100000000n) / qty),
        markPriceUnits: mark,
        pnlUnits: pnl !== null && Number.isSafeInteger(pnl) ? pnl : null,
        online: !!r.online,
        mine: !!r.mine,
      };
    });
    return { ...result, items };
  });
