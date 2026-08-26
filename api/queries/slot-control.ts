import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { getDb } from "./connection";
import { slotConfigs, slotFund, slotPromotions } from "@db/schema";
import {
  allowedMaxBetUnits,
  formatMultiplier,
  formatProbabilityPercent,
  moneyUnitsToDollars,
  parseSlotRules,
  SLOT_DEFAULT_BET_UNITS,
  SLOT_MULTIPLIER_SCALE,
  SLOT_PROBABILITY_SCALE,
  SLOT_SYMBOL_DEFINITIONS,
  slotMetrics,
  type SlotRulesDefinition,
} from "@contracts/slot-machine";

type SlotQueryDb = Pick<ReturnType<typeof getDb>, "select" | "update">;

export type ResolvedSlotState = {
  config: typeof slotConfigs.$inferSelect;
  rules: SlotRulesDefinition;
  metrics: ReturnType<typeof slotMetrics>;
  fund: typeof slotFund.$inferSelect;
  promotion: typeof slotPromotions.$inferSelect | null;
  promotionRemainingUnits: number | null;
  allowedMaxBetUnits: number;
  pausedReason: string | null;
};

const utcDay = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 10);

const activeBase = (db: SlotQueryDb) => db.select().from(slotConfigs)
  .where(and(eq(slotConfigs.mode, "base"), eq(slotConfigs.status, "active")))
  .orderBy(desc(slotConfigs.id)).limit(1).get();

export function resolveSlotState(db: SlotQueryDb, nowMs = Date.now(), allowPromotion = true): ResolvedSlotState {
  let fund = db.select().from(slotFund).where(eq(slotFund.id, 1)).limit(1).get();
  if (!fund) throw new Error("老虎机奖金池尚未初始化");
  const day = utcDay(nowMs);
  if (fund.day !== day) {
    fund = db.update(slotFund).set({ day, dayNetUnits: 0, updatedAt: new Date(nowMs) })
      .where(eq(slotFund.id, 1)).returning().get();
  }

  const now = new Date(nowMs);
  db.update(slotPromotions).set({ status: "ended", stoppedAt: now })
    .where(and(
      inArray(slotPromotions.status, ["scheduled", "active"]),
      lte(slotPromotions.endsAt, now),
    )).run();

  let promotion = allowPromotion
    ? db.select().from(slotPromotions).where(and(
      inArray(slotPromotions.status, ["scheduled", "active"]),
      lte(slotPromotions.startsAt, now),
      gt(slotPromotions.endsAt, now),
    )).orderBy(desc(slotPromotions.id)).limit(1).get() ?? null
    : null;
  if (promotion?.status === "scheduled") {
    promotion = db.update(slotPromotions).set({ status: "active" })
      .where(eq(slotPromotions.id, promotion.id)).returning().get();
  }
  if (promotion && promotion.spentUnits >= promotion.budgetUnits) {
    db.update(slotPromotions).set({ status: "exhausted", stoppedAt: now })
      .where(eq(slotPromotions.id, promotion.id)).run();
    promotion = null;
  }

  let config = promotion
    ? db.select().from(slotConfigs).where(eq(slotConfigs.id, promotion.configId)).limit(1).get()
    : activeBase(db);
  if (!config && promotion) {
    db.update(slotPromotions).set({ status: "stopped", stoppedAt: now })
      .where(eq(slotPromotions.id, promotion.id)).run();
    promotion = null;
    config = activeBase(db);
  }
  if (!config) throw new Error("没有已启用的老虎机基础配置");

  const rules = parseSlotRules(config.rulesJson);
  const metrics = slotMetrics(rules);
  const fundHeadroom = Math.max(0, fund.balanceUnits - fund.reserveUnits);
  const dailyHeadroom = Math.max(0, fund.dailyLossLimitUnits + fund.dayNetUnits);
  const promotionRemainingUnits = promotion ? Math.max(0, promotion.budgetUnits - promotion.spentUnits) : null;
  const fundMax = allowedMaxBetUnits(rules, fundHeadroom);
  const dailyMax = allowedMaxBetUnits(rules, dailyHeadroom);
  const promotionMax = promotionRemainingUnits === null ? rules.maxBetUnits : allowedMaxBetUnits(rules, promotionRemainingUnits);

  if (promotion && promotionMax === 0) {
    db.update(slotPromotions).set({ status: "exhausted", stoppedAt: now })
      .where(eq(slotPromotions.id, promotion.id)).run();
    return resolveSlotState(db, nowMs, false);
  }

  const allowed = Math.min(rules.maxBetUnits, fundMax, dailyMax, promotionMax);
  const pausedReason = fundMax === 0
    ? "奖金池可用余额不足，管理员补充资金后恢复"
    : dailyMax === 0
      ? "今日风险额度已用完，明日自动恢复"
      : allowed < rules.minBetUnits
        ? "当前风险额度不足以接受最小下注"
        : null;
  return {
    config,
    rules,
    metrics,
    fund,
    promotion,
    promotionRemainingUnits,
    allowedMaxBetUnits: pausedReason ? 0 : allowed,
    pausedReason,
  };
}

export function publicSlotState(state: ResolvedSlotState) {
  const symbolMap = new Map(SLOT_SYMBOL_DEFINITIONS.map((symbol) => [symbol.id, symbol]));
  return {
    configId: state.config.id,
    configVersion: state.config.version,
    configName: state.config.name,
    minBet: moneyUnitsToDollars(state.rules.minBetUnits),
    maxBet: moneyUnitsToDollars(state.rules.maxBetUnits),
    allowedMaxBet: moneyUnitsToDollars(state.allowedMaxBetUnits),
    defaultBet: moneyUnitsToDollars(Math.min(SLOT_DEFAULT_BET_UNITS, state.allowedMaxBetUnits || SLOT_DEFAULT_BET_UNITS)),
    paused: !!state.pausedReason,
    pausedReason: state.pausedReason,
    mode: state.promotion ? "promotion" as const : "base" as const,
    promotion: state.promotion ? {
      id: state.promotion.id,
      name: state.promotion.name,
      endsAt: state.promotion.endsAt,
    } : null,
    tiers: state.rules.tiers.map((tier) => {
      const symbol = symbolMap.get(tier.symbol);
      return {
        ...tier,
        glyph: symbol?.glyph ?? tier.symbol,
        color: symbol?.color ?? "#af915f",
        probabilityPercent: formatProbabilityPercent(tier.probabilityPpm),
        payoutMultiplier: tier.multiplierBasisPoints / SLOT_MULTIPLIER_SCALE,
        multiplier: formatMultiplier(tier.multiplierBasisPoints),
      };
    }),
    theoretical: {
      winRatePpm: state.metrics.winRatePpm,
      rtpPpm: state.metrics.rtpPpm,
      houseEdgePpm: state.metrics.houseEdgePpm,
      winRate: state.metrics.winRatePpm / SLOT_PROBABILITY_SCALE,
      rtp: state.metrics.rtpPpm / SLOT_PROBABILITY_SCALE,
      houseEdge: state.metrics.houseEdgePpm / SLOT_PROBABILITY_SCALE,
      maxGrossPayout: moneyUnitsToDollars(state.metrics.maxGrossPayoutUnits),
      maxNetLiability: moneyUnitsToDollars(state.metrics.maxNetLiabilityUnits),
    },
  };
}
