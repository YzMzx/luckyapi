import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminQuery, memberQuery } from "../auth";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  getLatestSevenPickConfig,
  getSevenPickConfig,
  listSevenPickConfigVersions,
  saveSevenPickConfig,
  sevenPickConfigInput,
} from "../seven-pick/config";
import { getSevenPickRound, getSevenPickSnapshot, listSevenPickOrders } from "../seven-pick/engine";
import { readSevenPickCash } from "../seven-pick/wallet";

type Db = ReturnType<typeof getDb>["$client"];
const roundIdInput = z.object({ roundId: z.number().int().positive() });

function recentRounds(db: Db) {
  return db.prepare(
    "SELECT id, status, opens_at AS opensAt, closes_at AS closesAt, draw_at AS drawAt, " +
    "quicknet_round AS quicknetRound FROM seven_pick_rounds WHERE opens_at <= ? ORDER BY opens_at DESC LIMIT 30"
  ).all(Date.now()) as {
    id: number; status: string; opensAt: number; closesAt: number; drawAt: number; quicknetRound: number;
  }[];
}

function publicRound(round: NonNullable<ReturnType<typeof getSevenPickRound>>) {
  // Explicit allowlist: the risk threshold can reveal the site's aggregate cash balance.
  return {
    id: round.id,
    status: round.status,
    opensAt: round.opensAt,
    closesAt: round.closesAt,
    drawAt: round.drawAt,
    quicknetRound: round.quicknetRound,
    quicknetScheduledAt: round.quicknetScheduledAt,
    quicknetNetwork: round.quicknetNetwork,
    quicknetChainHash: round.quicknetChainHash,
    quicknetPublicKey: round.quicknetPublicKey,
    quicknetScheme: round.quicknetScheme,
    algorithmVersion: round.algorithmVersion,
    minStakeUnits: round.minStakeUnits,
    maxStakeUnits: round.maxStakeUnits,
    multipliers: round.multipliers,
    items: round.items,
  };
}

export const sevenPickRouter = createRouter({
  overview: publicQuery.query(() => {
    const db = getDb().$client;
    const state = getSevenPickSnapshot(db);
    const { items, multipliers, minStakeUnits, maxStakeUnits, openMinutes, closeAfterMinutes, drawAfterMinutes } =
      getSevenPickConfig(db, state.now);
    return {
      name: state.name,
      now: state.now,
      round: state.round ? publicRound(state.round) : null,
      acceptingOrders: false as const,
      preview: { items, multipliers, minStakeUnits, maxStakeUnits, openMinutes, closeAfterMinutes, drawAfterMinutes },
    };
  }),
  history: publicQuery.query(() => recentRounds(getDb().$client)),
  round: publicQuery.input(roundIdInput).query(({ input }) => {
    const round = getSevenPickRound(getDb().$client, input.roundId);
    if (!round) throw new TRPCError({ code: "NOT_FOUND", message: "场次不存在" });
    return publicRound(round);
  }),
  account: memberQuery.query(({ ctx }) => {
    const db = getDb().$client;
    return {
      cashUnits: readSevenPickCash(db, ctx.user.id),
      orders: listSevenPickOrders(db, ctx.user.id),
    };
  }),
  // No betting mutation until an independent pre-randomness time proof is validated end-to-end.
});

export const sevenPickAdminRouter = createRouter({
  overview: adminQuery.query(() => {
    const db = getDb().$client;
    return {
      active: getSevenPickConfig(db),
      latest: getLatestSevenPickConfig(db),
      versions: listSevenPickConfigVersions(db, 10).map(({ id, effectiveAt, createdAt, enabled }) => ({ id, effectiveAt, createdAt, enabled })),
      rounds: recentRounds(db).map(({ id }) => getSevenPickRound(db, id)).filter((round) => round !== null),
    };
  }),
  save: adminQuery.input(z.object({
    expectedVersionId: z.number().int().positive().nullable(),
    config: sevenPickConfigInput,
  })).mutation(({ input }) => {
    const db = getDb().$client;
    return db.transaction(() => {
      if (getLatestSevenPickConfig(db).id !== input.expectedVersionId) {
        throw new TRPCError({ code: "CONFLICT", message: "配置已被更新，请刷新后再编辑" });
      }
      const saved = saveSevenPickConfig(db, input.config);
      db.prepare("INSERT INTO admin_logs (action, detail) VALUES (?, ?)")
        .run("seven_pick_config_saved", JSON.stringify({ versionId: saved.id, effectiveAt: saved.effectiveAt }));
      return saved;
    }).immediate();
  }),
});
