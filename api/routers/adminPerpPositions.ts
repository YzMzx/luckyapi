import { z } from "zod";
import { adminQuery } from "../auth";
import { paginationInput, resolvePagination } from "../pagination";
import { getDb } from "../queries/connection";
import { describePosition } from "../perp/engine";
import { getPerpQuote } from "../perp/market";
import { perpSymbolSchema } from "../perp/config";

type Row = Parameters<typeof describePosition>[0] & {
  username: string;
  groupName: string | null;
};
export const listPerpPositions = adminQuery
  .input(
    paginationInput.extend({
      user: z.string().trim().max(64).optional(),
      symbol: perpSymbolSchema.optional(),
      side: z.enum(["long", "short"]).optional(),
    })
  )
  .query(async ({ input }) => {
    const db = getDb().$client;
    const filters = ["p.quantity_atoms>0"],
      args: string[] = [];
    if (input.user) {
      filters.push(
        "(CAST(u.id AS TEXT)=? OR u.linuxdo_id=? OR instr(lower(u.username),lower(?))>0 OR instr(lower(u.group_name),lower(?))>0)"
      );
      args.push(input.user, input.user, input.user, input.user);
    }
    if (input.side) {
      filters.push("p.side=?");
      args.push(input.side);
    }
    if (input.symbol) {
      filters.push("p.symbol=?");
      args.push(input.symbol);
    }
    const from =
      " FROM perp_positions p JOIN users u ON u.id=p.user_id WHERE " +
      filters.join(" AND ");
    // Count and page see the same holdings. Never wait on the market inside a DB transaction.
    const { rows, page, totalPages, total, pageSize, asOf } = db.transaction(
      () => {
        const n = Number(
          db
            .prepare("SELECT count(*)" + from)
            .pluck()
            .get(...args)
        );
        const paging = resolvePagination(n, input.page, input.pageSize);
        const rows = db
          .prepare(
            "SELECT u.username,u.group_name AS groupName,p.user_id AS userId,p.symbol,p.side,p.leverage,p.quantity_atoms AS quantityAtoms,p.entry_units AS entryNotionalUnits,p.margin_units AS marginUnits,p.opened_at AS openedAt,p.updated_at AS updatedAt,p.next_funding_at AS nextFundingAt" +
              from +
              " ORDER BY p.updated_at DESC,p.user_id,p.symbol LIMIT ? OFFSET ?"
          )
          .all(...args, paging.pageSize, paging.offset) as Row[];
        return { ...paging, rows, asOf: Date.now() };
      }
    )();
    const quotes = new Map(
      await Promise.all(
        [...new Set(rows.map(p => p.symbol))].map(
          async symbol =>
            [symbol, await getPerpQuote(db, symbol).catch(() => null)] as const
        )
      )
    );
    const items = rows.map(row => {
      const q = quotes.get(row.symbol);
      const marked =
        q && Date.now() - q.asOf < 5000 && q.asOf >= row.updatedAt ? q : null;
      const pnl = marked
        ? ((BigInt(row.quantityAtoms) * BigInt(marked.markUnits)) / 100000000n -
            BigInt(row.entryNotionalUnits)) *
          (row.side === "long" ? 1n : -1n)
        : null;
      return {
        ...describePosition(row),
        username: row.username,
        groupName: row.groupName,
        markPriceUnits: marked?.markUnits ?? null,
        markAt: marked?.asOf ?? null,
        pnlUnits:
          pnl !== null && Number.isSafeInteger(Number(pnl))
            ? Number(pnl)
            : null,
      };
    });
    return { items, page, totalPages, total, pageSize, asOf };
  });
