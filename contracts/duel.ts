export const DUEL_MONEY_SCALE = 1_000_000;
export const DUEL_DEFAULT_BET_UNITS = [100_000, 500_000, 1_000_000, 5_000_000] as const;

export type DuelGame = "dice" | "blackjack";
export type DuelLeaderboardPeriod = "today" | "week" | "month" | "all";
export type DiceHand = readonly [number, number, number];

export function duelDollarsToUnits(amount: number): number {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("invalid duel amount");
  const units = Math.round(amount * DUEL_MONEY_SCALE);
  if (!Number.isSafeInteger(units)) throw new Error("duel amount is too large");
  return units;
}

export function duelAmountHasPrecision(amount: number, precision: number): boolean {
  if (!Number.isFinite(amount) || !Number.isInteger(precision) || precision < 0 || precision > 6) return false;
  const scale = 10 ** precision;
  return Math.abs(amount * scale - Math.round(amount * scale)) < 1e-7;
}

export function duelUnitsToDollars(units: number): number {
  if (!Number.isSafeInteger(units)) throw new Error("invalid duel units");
  return units / DUEL_MONEY_SCALE;
}

export type DiceEvaluation = {
  category: "triple" | "straight" | "pair" | "high";
  categoryRank: number;
  tieBreak: number[];
  label: string;
};

export function evaluateDice(hand: DiceHand): DiceEvaluation {
  if (hand.some((value) => !Number.isInteger(value) || value < 1 || value > 6)) throw new Error("invalid dice hand");
  const sorted = [...hand].sort((a, b) => a - b);
  if (sorted[0] === sorted[2]) {
    return { category: "triple", categoryRank: 4, tieBreak: [sorted[2]], label: `豹子 ${sorted[2]}` };
  }
  if (sorted[1] === sorted[0] + 1 && sorted[2] === sorted[1] + 1) {
    return { category: "straight", categoryRank: 3, tieBreak: [sorted[2]], label: `顺子 ${sorted.join("-")}` };
  }
  if (sorted[0] === sorted[1] || sorted[1] === sorted[2]) {
    const pair = sorted[0] === sorted[1] ? sorted[0] : sorted[1];
    const kicker = sorted[0] === sorted[1] ? sorted[2] : sorted[0];
    return { category: "pair", categoryRank: 2, tieBreak: [pair, kicker], label: `对子 ${pair}` };
  }
  return { category: "high", categoryRank: 1, tieBreak: [...sorted].sort((a, b) => b - a), label: `散点 ${sorted.join("-")}` };
}

export function compareDice(left: DiceEvaluation, right: DiceEvaluation): number {
  if (left.categoryRank !== right.categoryRank) return left.categoryRank - right.categoryRank;
  const length = Math.max(left.tieBreak.length, right.tieBreak.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left.tieBreak[index] ?? 0) - (right.tieBreak[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export const CARD_SUITS = ["S", "H", "D", "C"] as const;
export const CARD_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
export type DuelCard = `${typeof CARD_RANKS[number]}${typeof CARD_SUITS[number]}`;

/**
 * PVP 二十一点特殊牌型规则。截图没有约定庄家赔率，因此特殊牌型仅参与胜负排序；
 * 最高等级的玩家平分现有税后奖池，任何牌型都不会额外增发额度。
 */
export const BLACKJACK_RULE_VERSION = "pvp-special-v1" as const;
export const BLACKJACK_CATEGORY_PRIORITY = [
  "double_aces",
  "five_card_charlie",
  "natural_blackjack",
  "points",
  "bust",
] as const;
export type BlackjackCategory = typeof BLACKJACK_CATEGORY_PRIORITY[number];

export type BlackjackHandEvaluation = {
  ruleVersion: typeof BLACKJACK_RULE_VERSION;
  category: BlackjackCategory;
  categoryRank: number;
  score: number;
  soft: boolean;
  busted: boolean;
  cardCount: number;
  isSpecial: boolean;
  automaticStand: boolean;
  label: string;
};

export function createDeck(): DuelCard[] {
  return CARD_SUITS.flatMap((suit) => CARD_RANKS.map((rank) => `${rank}${suit}` as DuelCard));
}

export function blackjackScore(cards: readonly DuelCard[]): { score: number; soft: boolean; busted: boolean } {
  let score = 0;
  let aces = 0;
  for (const card of cards) {
    const rank = card.slice(0, -1);
    if (rank === "A") {
      score += 11;
      aces += 1;
    } else if (rank === "J" || rank === "Q" || rank === "K") score += 10;
    else score += Number(rank);
  }
  while (score > 21 && aces > 0) {
    score -= 10;
    aces -= 1;
  }
  return { score, soft: aces > 0, busted: score > 21 };
}

export function evaluateBlackjackHand(cards: readonly DuelCard[]): BlackjackHandEvaluation {
  const score = blackjackScore(cards);
  const ranks = cards.map((card) => card.slice(0, -1));
  let category: BlackjackCategory;
  let categoryRank: number;
  let label: string;
  if (score.busted) {
    category = "bust";
    categoryRank = 0;
    label = `爆牌 ${score.score} 点`;
  } else if (cards.length === 2 && ranks.every((rank) => rank === "A")) {
    category = "double_aces";
    categoryRank = 4;
    label = "双 A";
  } else if (cards.length === 5) {
    category = "five_card_charlie";
    categoryRank = 3;
    label = `五小 ${score.score} 点`;
  } else if (cards.length === 2 && score.score === 21 && ranks.includes("A")) {
    category = "natural_blackjack";
    categoryRank = 2;
    label = "天然黑杰克";
  } else {
    category = "points";
    categoryRank = 1;
    label = `${score.score} 点${score.soft ? "（软）" : ""}`;
  }
  const isSpecial = categoryRank > 1;
  return {
    ruleVersion: BLACKJACK_RULE_VERSION,
    category,
    categoryRank,
    score: score.score,
    soft: score.soft,
    busted: score.busted,
    cardCount: cards.length,
    isSpecial,
    automaticStand: score.busted || score.score === 21 || isSpecial,
    label,
  };
}

/** 正数表示 left 胜；特殊牌型同类不再按点数细分，保持同级平分奖池。 */
export function compareBlackjackHands(left: BlackjackHandEvaluation, right: BlackjackHandEvaluation): number {
  if (left.categoryRank !== right.categoryRank) return left.categoryRank - right.categoryRank;
  if (left.category === "points" && right.category === "points") return left.score - right.score;
  return 0;
}

export const BLACKJACK_PVP_RULES = {
  version: BLACKJACK_RULE_VERSION,
  payoutMode: "shared_pot_top_rank_equal_split" as const,
  fixedOdds: null,
  priority: BLACKJACK_CATEGORY_PRIORITY,
  description: "双 A > 五小（恰好五张且不超过 21 点）> 天然黑杰克（起手 A+10/J/Q/K）> 普通不爆点数 > 爆牌；最高同级平分税后共享奖池，全员爆牌原额退款。",
} as const;

export function splitDuelPot(potUnits: number, feeBasisPoints: number, winnerSeats: readonly number[]) {
  if (!Number.isSafeInteger(potUnits) || potUnits < 0) throw new Error("invalid duel pot");
  if (!Number.isInteger(feeBasisPoints) || feeBasisPoints < 0 || feeBasisPoints > 10_000) throw new Error("invalid duel fee");
  if (!winnerSeats.length) return { feeUnits: 0, distributableUnits: potUnits, payouts: new Map<number, number>() };
  const feeUnits = Number((BigInt(potUnits) * BigInt(feeBasisPoints)) / 10_000n);
  const distributableUnits = potUnits - feeUnits;
  const seats = [...winnerSeats].sort((a, b) => a - b);
  const base = Math.floor(distributableUnits / seats.length);
  let remainder = distributableUnits % seats.length;
  const payouts = new Map<number, number>();
  for (const seat of seats) {
    const extra = remainder > 0 ? 1 : 0;
    payouts.set(seat, base + extra);
    remainder -= extra;
  }
  return { feeUnits, distributableUnits, payouts };
}

/** 决斗榜统一使用 Asia/Shanghai（UTC+8）自然日，返回 [start, end) 半开区间。 */
export function duelLeaderboardPeriodBounds(period: DuelLeaderboardPeriod, nowMs = Date.now()) {
  const offsetMs = 8 * 60 * 60 * 1000;
  if (period === "all") return { startMs: null, endMs: null, timezone: "Asia/Shanghai" as const };
  const local = new Date(nowMs + offsetMs);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  let localStartMs: number;
  let localEndMs: number;
  if (period === "today") {
    localStartMs = Date.UTC(year, month, day);
    localEndMs = Date.UTC(year, month, day + 1);
  } else if (period === "week") {
    const mondayOffset = (local.getUTCDay() + 6) % 7;
    localStartMs = Date.UTC(year, month, day - mondayOffset);
    localEndMs = Date.UTC(year, month, day - mondayOffset + 7);
  } else {
    localStartMs = Date.UTC(year, month, 1);
    localEndMs = Date.UTC(year, month + 1, 1);
  }
  return { startMs: localStartMs - offsetMs, endMs: localEndMs - offsetMs, timezone: "Asia/Shanghai" as const };
}
