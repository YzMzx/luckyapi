export const SLOT_CONFIG_VERSION = "daily-slot-v3-3000";
export const SLOT_PROBABILITY_SCALE = 1_000_000;
export const SLOT_MULTIPLIER_SCALE = 10_000;
export const SLOT_MONEY_SCALE = 100;
export const SLOT_MIN_BET_UNITS = 10;
export const SLOT_MAX_BET_UNITS = 500;
export const SLOT_DEFAULT_BET_UNITS = 100;
export const SLOT_MIN_BET = SLOT_MIN_BET_UNITS / SLOT_MONEY_SCALE;
export const SLOT_MAX_BET = SLOT_MAX_BET_UNITS / SLOT_MONEY_SCALE;
export const SLOT_DEFAULT_BET = SLOT_DEFAULT_BET_UNITS / SLOT_MONEY_SCALE;

export const SLOT_SYMBOL_DEFINITIONS = [
  { id: "cherry", glyph: "🍒", name: "小奖", color: "#EF5459" },
  { id: "lemon", glyph: "🍋", name: "小奖", color: "#FFB700" },
  { id: "bell", glyph: "🔔", name: "中奖", color: "#af915f" },
  { id: "diamond", glyph: "💎", name: "大奖", color: "#176EFF" },
  { id: "seven", glyph: "7", name: "头奖", color: "#EF54EA" },
] as const;

export type SlotSymbol = (typeof SLOT_SYMBOL_DEFINITIONS)[number]["id"];
export type SlotSymbols = [SlotSymbol, SlotSymbol, SlotSymbol];

export type SlotPrizeTier = {
  id: string;
  symbol: SlotSymbol;
  name: string;
  probabilityPpm: number;
  multiplierBasisPoints: number;
};

export type SlotRulesDefinition = {
  version: string;
  name: string;
  minBetUnits: number;
  maxBetUnits: number;
  tiers: SlotPrizeTier[];
};

export const DEFAULT_SLOT_RULES: SlotRulesDefinition = {
  version: SLOT_CONFIG_VERSION,
  name: "日常 30% / RTP 92%",
  minBetUnits: SLOT_MIN_BET_UNITS,
  maxBetUnits: SLOT_MAX_BET_UNITS,
  tiers: [
    { id: "small-1", symbol: "cherry", name: "小奖", probabilityPpm: 220_000, multiplierBasisPoints: 20_000 },
    { id: "small-2", symbol: "lemon", name: "小奖", probabilityPpm: 50_000, multiplierBasisPoints: 30_000 },
    { id: "medium", symbol: "bell", name: "中奖", probabilityPpm: 25_000, multiplierBasisPoints: 60_000 },
    { id: "large", symbol: "diamond", name: "大奖", probabilityPpm: 4_000, multiplierBasisPoints: 200_000 },
    { id: "jackpot", symbol: "seven", name: "头奖", probabilityPpm: 1_000, multiplierBasisPoints: 1_000_000 },
  ],
};

/** Historical v2 rules; fractional payouts still round to the nearest cent per winning tier. */
export const V2_SLOT_RULES: SlotRulesDefinition = {
  version: "daily-slot-v2-2505",
  name: "日常 25.05% / RTP 92%",
  minBetUnits: SLOT_MIN_BET_UNITS,
  maxBetUnits: SLOT_MAX_BET_UNITS,
  tiers: [
    { id: "small-1", symbol: "cherry", name: "小奖", probabilityPpm: 150_000, multiplierBasisPoints: 12_000 },
    { id: "small-2", symbol: "lemon", name: "小奖", probabilityPpm: 70_000, multiplierBasisPoints: 20_000 },
    { id: "medium", symbol: "bell", name: "中奖", probabilityPpm: 25_000, multiplierBasisPoints: 80_000 },
    { id: "large", symbol: "diamond", name: "大奖", probabilityPpm: 4_500, multiplierBasisPoints: 400_000 },
    { id: "jackpot", symbol: "seven", name: "头奖", probabilityPpm: 1_000, multiplierBasisPoints: 2_200_000 },
  ],
};

/** 旧版独立滚轮的实际三连概率，用于迁移后的历史配置展示。 */
export const LEGACY_SLOT_RULES: SlotRulesDefinition = {
  version: "daily-slot-v1",
  name: "旧版独立滚轮",
  minBetUnits: SLOT_MIN_BET_UNITS,
  maxBetUnits: SLOT_MAX_BET_UNITS,
  tiers: [
    { id: "legacy-cherry", symbol: "cherry", name: "樱桃三连", probabilityPpm: 42_875, multiplierBasisPoints: 40_000 },
    { id: "legacy-lemon", symbol: "lemon", name: "柠檬三连", probabilityPpm: 15_625, multiplierBasisPoints: 100_000 },
    { id: "legacy-bell", symbol: "bell", name: "铃铛三连", probabilityPpm: 5_832, multiplierBasisPoints: 250_000 },
    { id: "legacy-diamond", symbol: "diamond", name: "钻石三连", probabilityPpm: 1_728, multiplierBasisPoints: 750_000 },
    { id: "legacy-seven", symbol: "seven", name: "幸运 7 三连", probabilityPpm: 1_000, multiplierBasisPoints: 3_000_000 },
  ],
};

const symbolIds = new Set<string>(SLOT_SYMBOL_DEFINITIONS.map((symbol) => symbol.id));
const isIntegerInRange = (value: unknown, min: number, max: number) =>
  Number.isInteger(value) && Number(value) >= min && Number(value) <= max;

export function multiplyMoneyUnits(amountUnits: number, multiplierBasisPoints: number) {
  if (!Number.isSafeInteger(amountUnits) || amountUnits < 0) throw new Error("金额单位无效");
  if (!Number.isSafeInteger(multiplierBasisPoints) || multiplierBasisPoints < 0) throw new Error("倍率无效");
  return Number((BigInt(amountUnits) * BigInt(multiplierBasisPoints) + BigInt(SLOT_MULTIPLIER_SCALE / 2)) / BigInt(SLOT_MULTIPLIER_SCALE));
}

function assertValidBet(rules: SlotRulesDefinition, betUnits: number) {
  if (!Number.isSafeInteger(betUnits) || betUnits < rules.minBetUnits || betUnits > rules.maxBetUnits) throw new Error("下注金额超出配置范围");
}

type TicketRow = {
  endExclusive: number;
  tier: SlotPrizeTier | null;
  grossPayoutUnits: number;
};

/** Build local, contiguous integer ticket ranges for this stake, including the losing range. */
function compileSlot(rules: SlotRulesDefinition, betUnits: number) {
  if (!rules.version.trim() || rules.version.length > 96) throw new Error("配置版本无效");
  if (!rules.name.trim() || rules.name.length > 96) throw new Error("配置名称无效");
  if (!isIntegerInRange(rules.minBetUnits, 1, 1_000_000)) throw new Error("最小下注无效");
  if (!isIntegerInRange(rules.maxBetUnits, rules.minBetUnits, 1_000_000)) throw new Error("最大下注无效");
  if (rules.tiers.length < 1 || rules.tiers.length > SLOT_SYMBOL_DEFINITIONS.length) throw new Error("奖项档位数量无效");
  const ids = new Set<string>();
  const symbols = new Set<string>();
  assertValidBet(rules, betUnits);
  const rows: TicketRow[] = [];
  let winRatePpm = 0;
  for (const tier of rules.tiers) {
    if (!tier.id.trim() || ids.has(tier.id)) throw new Error("奖项编号必须唯一");
    if (!symbolIds.has(tier.symbol) || symbols.has(tier.symbol)) throw new Error("奖项符号必须有效且唯一");
    if (!tier.name.trim() || tier.name.length > 32) throw new Error("奖项名称无效");
    if (!isIntegerInRange(tier.probabilityPpm, 1, SLOT_PROBABILITY_SCALE - 1)) throw new Error("奖项概率必须大于 0 且小于 100%");
    if (!isIntegerInRange(tier.multiplierBasisPoints, SLOT_MULTIPLIER_SCALE + 1, 10_000_000)) throw new Error("中奖倍率必须大于 1 倍");
    ids.add(tier.id);
    symbols.add(tier.symbol);
    winRatePpm += tier.probabilityPpm;
    rows.push({ endExclusive: winRatePpm, tier, grossPayoutUnits: multiplyMoneyUnits(betUnits, tier.multiplierBasisPoints) });
  }
  if (winRatePpm <= 0 || winRatePpm >= SLOT_PROBABILITY_SCALE) throw new Error("总中奖率必须大于 0 且小于 100%");
  rows.push({ endExclusive: SLOT_PROBABILITY_SCALE, tier: null, grossPayoutUnits: 0 });

  let start = 0;
  let nominal = 0n;
  let settled = 0n;
  let maxMultiplierBasisPoints = 0;
  for (const row of rows) {
    const tickets = BigInt(row.endExclusive - start);
    const multiplier = row.tier?.multiplierBasisPoints ?? 0;
    nominal += tickets * BigInt(multiplier);
    settled += tickets * BigInt(row.grossPayoutUnits);
    maxMultiplierBasisPoints = Math.max(maxMultiplierBasisPoints, multiplier);
    start = row.endExclusive;
  }
  const ratioRounded = (n: bigint, d: number) => Number((n + BigInt(Math.floor(d / 2))) / BigInt(d));
  const rtpPpm = ratioRounded(nominal, SLOT_MULTIPLIER_SCALE);
  if (rtpPpm <= 0 || rtpPpm >= SLOT_PROBABILITY_SCALE) throw new Error("RTP 必须大于 0 且小于 100%");
  const maxGrossPayoutUnits = multiplyMoneyUnits(rules.maxBetUnits, maxMultiplierBasisPoints);
  return {
    rows,
    metrics: {
      winRatePpm, lossRatePpm: SLOT_PROBABILITY_SCALE - winRatePpm, rtpPpm, houseEdgePpm: SLOT_PROBABILITY_SCALE - rtpPpm,
      maxMultiplierBasisPoints, maxGrossPayoutUnits, maxNetLiabilityUnits: Math.max(0, maxGrossPayoutUnits - rules.maxBetUnits),
    },
    // Both totals fit within safe integer range under the validated config bounds.
    settlement: { numerator: Number(settled), denominator: betUnits * SLOT_PROBABILITY_SCALE, rtpPpm: ratioRounded(settled, betUnits) },
  };
}

/** Exact RTP after per-win rounding is numerator / denominator; rtpPpm is rounded for display. */
export function settlementRtpForBet(rules: SlotRulesDefinition, betUnits: number) {
  return compileSlot(rules, betUnits).settlement;
}

export function slotMetrics(rules: SlotRulesDefinition) {
  return compileSlot(rules, rules.maxBetUnits).metrics;
}

export function validateSlotRules(rules: SlotRulesDefinition) {
  return slotMetrics(rules);
}

export function parseSlotRules(serialized: string): SlotRulesDefinition {
  const parsed = JSON.parse(serialized) as SlotRulesDefinition;
  validateSlotRules(parsed);
  return parsed;
}

export function serializeSlotRules(rules: SlotRulesDefinition) {
  validateSlotRules(rules);
  return JSON.stringify(rules);
}

export function moneyUnitsToDollars(units: number) {
  return units / SLOT_MONEY_SCALE;
}

export function dollarsToMoneyUnits(value: number) {
  const units = Math.round(value * SLOT_MONEY_SCALE);
  if (!Number.isFinite(value) || !Number.isSafeInteger(units) || Math.abs(value * SLOT_MONEY_SCALE - units) > 1e-8)
    throw new Error("金额最多保留两位小数");
  return units;
}

export function formatProbabilityPercent(ppm: number) {
  return (ppm / 10_000).toFixed(4).replace(/\.?0+$/, "");
}

export function formatMultiplier(basisPoints: number) {
  return (basisPoints / SLOT_MULTIPLIER_SCALE).toFixed(4).replace(/\.?0+$/, "");
}

const parseScaledDecimal = (input: string, scale: number, decimals: number) => {
  const value = input.trim();
  const match = value.match(new RegExp(`^(\\d+)(?:\\.(\\d{1,${decimals}}))?$`));
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(decimals, "0"));
  const result = whole * BigInt(scale) + fraction;
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
};

export const probabilityPercentToPpm = (input: string) => parseScaledDecimal(input, 10_000, 4);
export const multiplierToBasisPoints = (input: string) => parseScaledDecimal(input, SLOT_MULTIPLIER_SCALE, 4);
export const dollarsStringToMoneyUnits = (input: string) => parseScaledDecimal(input, SLOT_MONEY_SCALE, 2);

export function maxNetLiabilityForBet(rules: SlotRulesDefinition, betUnits: number) {
  return Math.max(...rules.tiers.map((tier) => multiplyMoneyUnits(betUnits, tier.multiplierBasisPoints) - betUnits), 0);
}

export function allowedMaxBetUnits(rules: SlotRulesDefinition, liabilityHeadroomUnits: number) {
  if (liabilityHeadroomUnits < 0 || maxNetLiabilityForBet(rules, rules.minBetUnits) > liabilityHeadroomUnits) return 0;
  let low = rules.minBetUnits;
  let high = rules.maxBetUnits;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (maxNetLiabilityForBet(rules, middle) <= liabilityHeadroomUnits) low = middle;
    else high = middle - 1;
  }
  return low;
}

const randomLosingSymbols = (randomInt: (maxExclusive: number) => number): SlotSymbols => {
  const ids = SLOT_SYMBOL_DEFINITIONS.map((symbol) => symbol.id);
  const symbols: SlotSymbols = [ids[randomInt(ids.length)], ids[randomInt(ids.length)], ids[randomInt(ids.length)]];
  if (symbols[0] === symbols[1] && symbols[1] === symbols[2]) {
    const index = ids.indexOf(symbols[2]);
    symbols[2] = ids[(index + 1 + randomInt(ids.length - 1)) % ids.length];
  }
  return symbols;
};

export function spinSlot(randomInt: (maxExclusive: number) => number, rules: SlotRulesDefinition, betUnits: number) {
  const { rows, settlement } = compileSlot(rules, betUnits);
  const roll = randomInt(SLOT_PROBABILITY_SCALE);
  if (!isIntegerInRange(roll, 0, SLOT_PROBABILITY_SCALE - 1)) throw new Error("无效的开奖抽值");
  const { tier, grossPayoutUnits } = rows.find((row) => roll < row.endExclusive)!;
  const multiplierBasisPoints = tier?.multiplierBasisPoints ?? 0;
  const symbols: SlotSymbols = tier
    ? [tier.symbol, tier.symbol, tier.symbol]
    : randomLosingSymbols(randomInt);
  return {
    settlementRtpPpm: settlement.rtpPpm,
    prizeTierId: tier?.id ?? "loss",
    prizeTierName: tier?.name ?? "未中奖",
    symbols,
    win: !!tier,
    multiplierBasisPoints,
    payoutMultiplier: multiplierBasisPoints / SLOT_MULTIPLIER_SCALE,
    grossPayoutUnits,
    grossPayout: moneyUnitsToDollars(grossPayoutUnits),
    netChangeUnits: grossPayoutUnits - betUnits,
    netChange: moneyUnitsToDollars(grossPayoutUnits - betUnits),
  };
}

export const SLOT_SYMBOLS = DEFAULT_SLOT_RULES.tiers.map((tier) => ({
  ...SLOT_SYMBOL_DEFINITIONS.find((symbol) => symbol.id === tier.symbol)!,
  probabilityPpm: tier.probabilityPpm,
  payoutMultiplier: tier.multiplierBasisPoints / SLOT_MULTIPLIER_SCALE,
  multiplierBasisPoints: tier.multiplierBasisPoints,
}));

const defaultMetrics = slotMetrics(DEFAULT_SLOT_RULES);
export const SLOT_THEORETICAL = {
  winRate: defaultMetrics.winRatePpm / SLOT_PROBABILITY_SCALE,
  rtp: defaultMetrics.rtpPpm / SLOT_PROBABILITY_SCALE,
  houseEdge: defaultMetrics.houseEdgePpm / SLOT_PROBABILITY_SCALE,
  combinations: DEFAULT_SLOT_RULES.tiers.map((tier) => ({ ...tier, probability: tier.probabilityPpm / SLOT_PROBABILITY_SCALE })),
};
