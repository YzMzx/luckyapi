import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminQuery, memberQuery } from "../auth";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { readControlState, readUserPolicy } from "../queries/policies";
import {
  getLatestSevenPickConfig,
  getSevenPickConfig,
  listSevenPickConfigVersions,
  saveSevenPickConfig,
  sevenPickConfigInput,
} from "../seven-pick/config";
import {
  getSevenPickRound, getSevenPickSnapshot, listSevenPickOrders,
  placeSevenPickOrder, SevenPickError, sevenPickPlaceInput,
} from "../seven-pick/engine";
import { approveSevenPickRefund, getSevenPickLifecycle, listSevenPickAudit, SevenPickLifecycleError } from "../seven-pick/lifecycle";
import { getSevenPickRuntime, setSevenPickRuntime } from "../seven-pick/release";
import { readSevenPickCash } from "../seven-pick/wallet";
import { getSevenPickSealTimestampTime } from "../seven-pick/seal-timestamp";

type Db = ReturnType<typeof getDb>["$client"];
const roundIdInput = z.object({ roundId: z.number().int().positive() });

function recentRounds(db: Db, beforeOpensAt = Date.now() + 1) {
  return db.prepare(
    "SELECT id, status, opens_at AS opensAt, closes_at AS closesAt, draw_at AS drawAt, " +
    "quicknet_round AS quicknetRound FROM seven_pick_rounds WHERE opens_at < ? ORDER BY opens_at DESC LIMIT 30"
  ).all(Math.min(beforeOpensAt, Date.now() + 1)) as {
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
    const { enabled, items, multipliers, minStakeUnits, maxStakeUnits, openMinutes, closeAfterMinutes, drawAfterMinutes } =
      getSevenPickConfig(db, state.now);
    return {
      name: state.name,
      now: state.now,
      round: state.round ? publicRound(state.round) : null,
      launchReady: !state.paused,
      paused: state.paused,
      configured: enabled,
      acceptingOrders: state.bettingEnabled && !readControlState(getDb()).maintenance,
      preview: { items, multipliers, minStakeUnits, maxStakeUnits, openMinutes, closeAfterMinutes, drawAfterMinutes },
    };
  }),
  history: publicQuery.input(z.object({ beforeOpensAt: z.number().int().positive() }).optional())
    .query(({ input }) => recentRounds(getDb().$client, input?.beforeOpensAt)),
  round: publicQuery.input(roundIdInput).query(({ input }) => {
    const db = getDb().$client;
    const round = getSevenPickRound(db, input.roundId);
    if (!round) throw new TRPCError({ code: "NOT_FOUND", message: "场次不存在" });
    return { ...publicRound(round), lifecycle: getSevenPickLifecycle(db, input.roundId), timestampUpperBoundMs: getSevenPickSealTimestampTime(db, input.roundId) };
  }),
  account: memberQuery.query(({ ctx }) => {
    const db = getDb().$client;
    return db.transaction(() => ({
      cashUnits: readSevenPickCash(db, ctx.user.id),
      orders: listSevenPickOrders(db, ctx.user.id),
    }))();
  }),
  place: memberQuery.input(sevenPickPlaceInput).mutation(({ ctx, input }) => {
    const db = getDb();
    try {
      return db.$client.transaction(() => {
        const policy = readUserPolicy(db, ctx.user.id);
        if (policy.allFrozen || policy.financeFrozen || policy.entertainmentFrozen) {
          throw new TRPCError({ code: "FORBIDDEN", message: "账户的金融或娱乐操作权限已被冻结" });
        }
        if (readControlState(db).maintenance) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "系统正在维护，暂时无法投注" });
        }
        return placeSevenPickOrder(db.$client, ctx.user.id, input);
      }).immediate();
    } catch (error) {
      if (!(error instanceof SevenPickError)) throw error;
      const code = error.code === "BETTING_DISABLED" || error.code === "ROUND_CLOSED" ? "PRECONDITION_FAILED"
        : error.code === "ROUND_NOT_FOUND" ? "NOT_FOUND"
        : error.code === "IDEMPOTENCY_CONFLICT" || error.code === "DUPLICATE_COMBINATION" ? "CONFLICT"
        : "BAD_REQUEST";
      throw new TRPCError({ code, message: error.message });
    }
  }),
});

export const sevenPickAdminRouter = createRouter({
  overview: adminQuery.query(() => {
    const db = getDb().$client;
    const runtime = getSevenPickRuntime(db);
    return {
      launchReady: !runtime.paused,
      runtime,
      active: getSevenPickConfig(db),
      latest: getLatestSevenPickConfig(db),
      versions: listSevenPickConfigVersions(db, 10).map(({ id, effectiveAt, createdAt, enabled }) => ({ id, effectiveAt, createdAt, enabled })),
      rounds: db.prepare<[], number>(
        "SELECT id FROM seven_pick_rounds WHERE status IN ('review','refunding','ots_waiting','sealed') " +
        "UNION SELECT id FROM (SELECT id FROM seven_pick_rounds ORDER BY id DESC LIMIT 30) ORDER BY id DESC"
      ).pluck().all().map((id) => getSevenPickRound(db, id)).filter((round) => round !== null),
    };
  }),
  setRuntime: adminQuery.input(z.strictObject({
    key: z.enum(["paused", "rfc3161Enabled"]),
    value: z.boolean(),
  })).mutation(({ ctx, input }) => setSevenPickRuntime(getDb().$client, input.key, input.value, ctx.adminSessionId)),
  audit: adminQuery.input(roundIdInput).query(({ input }) => {
    const db = getDb().$client;
    const lifecycle = getSevenPickLifecycle(db, input.roundId);
    if (!lifecycle) throw new TRPCError({ code: "NOT_FOUND", message: "场次不存在" });
    return { lifecycle, entries: listSevenPickAudit(db, input.roundId) };
  }),
  reviewRefund: adminQuery.input(roundIdInput.extend({
    reason: z.literal("seal_missed"),
    notes: z.string().trim().min(1).max(1000),
  })).mutation(async ({ ctx, input }) => {
    try {
      return await approveSevenPickRefund(getDb().$client, { ...input, reviewer: "admin-session:" + ctx.adminSessionId });
    } catch (error) {
      if (error instanceof SevenPickLifecycleError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
      throw error;
    }
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
