import { z } from "zod";
import { memberQuery } from "../auth";
import { paginationInput, resolvePagination } from "../pagination";
import { getDb } from "../queries/connection";
import {
  loadPositionQuotes,
  valueOpenPosition,
  type PositionForValuation,
} from "../perp/valuation";

type Row = PositionForValuation & { userId: number; nickname: string };
type Player = {
  nickname: string;
  positionCount: number;
  pnl: bigint;
  incomplete: boolean;
};

export const perpLiveBoard = memberQuery
  .input(
    paginationInput.extend({
      side: z.enum(["profit", "loss"]).default("profit"),
    })
  )
  .query(async ({ ctx, input }) => {
    const db = getDb().$client;
    // Read all eligible positions in one snapshot; aggregate before sorting or paging.
    const positions = db
      .prepare<[], Row>(
        "SELECT p.user_id AS userId,u.group_name AS nickname,p.symbol,p.side,p.quantity_atoms AS quantityAtoms,p.entry_units AS entryUnits,p.updated_at AS updatedAt" +
          " FROM perp_positions p JOIN users u ON u.id=p.user_id WHERE p.quantity_atoms>0 AND u.banned=0 AND u.group_name IS NOT NULL"
      )
      .all();
    const quotes = await loadPositionQuotes(db, positions);
    const updatedAt = Date.now();
    const players = new Map<number, Player>();
    for (const row of positions) {
      let player = players.get(row.userId);
      if (!player) {
        player = {
          nickname: row.nickname,
          positionCount: 0,
          pnl: 0n,
          incomplete: false,
        };
        players.set(row.userId, player);
      }
      player.positionCount++;
      const value = valueOpenPosition(row, quotes.get(row.symbol), updatedAt);
      if (value) player.pnl += value.pnl;
      else player.incomplete = true;
    }
    const profit = input.side === "profit";
    const candidates: {
      userId: number;
      nickname: string;
      pnlUnits: number;
      positionCount: number;
    }[] = [];
    let pendingPlayers = 0;
    let mine: {
      pnlUnits: number | null;
      rank: number | null;
      positionCount: number;
    } | null = null;
    for (const [userId, player] of players) {
      const total = Number(player.pnl);
      const valid = !player.incomplete && Number.isSafeInteger(total);
      if (userId === ctx.user.id)
        mine = {
          pnlUnits: valid ? total : null,
          rank: null,
          positionCount: player.positionCount,
        };
      if (!valid) pendingPlayers++;
      else if (profit ? total > 0 : total < 0)
        candidates.push({
          userId,
          nickname: player.nickname,
          pnlUnits: total,
          positionCount: player.positionCount,
        });
    }
    candidates.sort(
      (a, b) =>
        (profit ? b.pnlUnits - a.pnlUnits : a.pnlUnits - b.pnlUnits) ||
        a.userId - b.userId
    );
    const total = candidates.length;
    const { page, pageSize, totalPages, offset } = resolvePagination(
      total,
      input.page,
      input.pageSize
    );
    let rank = 0;
    const rows = [];
    for (let i = 0; i < total; i++) {
      const { userId, ...row } = candidates[i];
      if (i === 0 || row.pnlUnits !== candidates[i - 1].pnlUnits) rank = i + 1;
      const isMine = userId === ctx.user.id;
      if (isMine && mine) mine.rank = rank;
      if (i >= offset && i < offset + pageSize)
        rows.push({ ...row, rank, mine: isMine });
    }
    return {
      rows,
      mine,
      pendingPlayers,
      updatedAt,
      page,
      pageSize,
      totalPages,
      total,
    };
  });
