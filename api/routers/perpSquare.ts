import { z } from "zod";
import { memberQuery } from "../auth";
import { getDb } from "../queries/connection";
import { DEFAULT_PAGE_SIZE, resolvePagination } from "../pagination";
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

// Only return public position data; each contract has its own page.
export const positionSquare = memberQuery
  .input(
    z.strictObject({
      pages: z
        .record(perpSymbolSchema, z.number().int().min(1))
        .refine(
          pages => Object.keys(pages).length <= 30,
          "最多支持 30 个合约的页码"
        )
        .default({}),
    })
  )
  .query(async ({ ctx, input }) => {
    const db = getDb().$client;
    const cutoff = Date.now() - onlineWindow;
    const from =
      " FROM perp_positions p JOIN users u ON u.id=p.user_id" +
      " LEFT JOIN perp_presence s ON s.user_id=p.user_id" +
      " WHERE p.quantity_atoms>0 AND u.banned=0 AND u.group_name IS NOT NULL";
    const { onlineHolders, snapshots } = db.transaction(() => {
      const categories = db
        .prepare<[], { symbol: string; total: number }>(
          "SELECT p.symbol, count(*) AS total" +
            from +
            " GROUP BY p.symbol ORDER BY p.symbol"
        )
        .all();
      const onlineHolders = Number(
        db
          .prepare(
            "SELECT count(DISTINCT p.user_id)" + from + " AND s.seen_at>?"
          )
          .pluck()
          .get(cutoff)
      );
      const select = db.prepare<[number, number, string, number, number], Row>(
        "SELECT u.group_name AS nickname,p.symbol,p.side,p.quantity_atoms AS quantityAtoms,p.entry_units AS entryUnits,p.updated_at AS updatedAt,p.leverage,COALESCE(s.seen_at>?,0) AS online,p.user_id=? AS mine" +
          from +
          " AND p.symbol=? ORDER BY p.updated_at DESC,p.user_id LIMIT ? OFFSET ?"
      );
      const snapshots = categories.map(({ symbol, total }) => {
        const { offset, ...pagination } = resolvePagination(
          total,
          input.pages[symbol] ?? 1,
          DEFAULT_PAGE_SIZE
        );
        return {
          symbol,
          ...pagination,
          rows: select.all(
            cutoff,
            ctx.user.id,
            symbol,
            pagination.pageSize,
            offset
          ),
        };
      });
      return { onlineHolders, snapshots };
    })();
    const quotes = await loadPositionQuotes(
      db,
      snapshots.flatMap(group => group.rows)
    );
    const now = Date.now();
    const groups = snapshots.map(({ rows, ...group }) => ({
      ...group,
      items: rows.map(r => {
        const value = valueOpenPosition(r, quotes.get(r.symbol), now);
        const pnl = value ? Number(value.pnl) : null;
        return {
          nickname: r.nickname,
          symbol: r.symbol,
          side: r.side,
          quantityAtoms: r.quantityAtoms,
          leverage: r.leverage,
          entryPriceUnits: Number(
            (BigInt(r.entryUnits) * 100000000n) / BigInt(r.quantityAtoms)
          ),
          markPriceUnits: value?.markPriceUnits ?? null,
          pnlUnits: pnl !== null && Number.isSafeInteger(pnl) ? pnl : null,
          online: !!r.online,
          mine: !!r.mine,
        };
      }),
    }));
    return { groups, onlineHolders };
  });
