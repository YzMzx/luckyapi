import { createHash, randomBytes } from "node:crypto";
import {
  BLACKJACK_RULE_VERSION,
  compareDice,
  createDeck,
  evaluateBlackjackHand,
  evaluateDice,
  type BlackjackHandEvaluation,
  type DiceHand,
  type DuelCard,
  type DuelGame,
} from "@contracts/duel";

export type DiceRoundResult = {
  round: number;
  rolls: Array<{ seat: number; dice: DiceHand; evaluation: ReturnType<typeof evaluateDice> }>;
  contenderSeats: number[];
};

export type DiceRoomState = {
  kind: "dice";
  contenderSeats: number[];
  rounds: DiceRoundResult[];
};

export type BlackjackRoomState = {
  kind: "blackjack";
  ruleVersion?: typeof BLACKJACK_RULE_VERSION;
  deck: DuelCard[];
  cursor: number;
  hands: Record<string, DuelCard[]>;
  evaluations?: Record<string, BlackjackHandEvaluation>;
  actions: Array<{ seat: number; action: "hit" | "stand" | "auto_stand"; card?: DuelCard; score: number; at: number }>;
};

export type DuelRoomState = DiceRoomState | BlackjackRoomState;

export function newDuelSeed(): string {
  return randomBytes(32).toString("hex");
}

export function duelSeedCommitment(seed: string, roomId: string, game: DuelGame, roundNo: number): string {
  return createHash("sha256").update(`${seed}|${roomId}|${game}|${roundNo}`).digest("hex");
}

class DeterministicRandom {
  private counter = 0;
  private pool = Buffer.alloc(0);
  private offset = 0;
  private readonly seed: string;
  private readonly context: string;

  constructor(seed: string, context: string) {
    this.seed = seed;
    this.context = context;
  }

  private nextUint32(): number {
    if (this.offset + 4 > this.pool.length) {
      this.pool = createHash("sha256").update(`${this.seed}|${this.context}|${this.counter}`).digest();
      this.counter += 1;
      this.offset = 0;
    }
    const value = this.pool.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  below(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x1_0000_0000) throw new Error("invalid random range");
    const range = 0x1_0000_0000;
    const limit = range - (range % maxExclusive);
    let value: number;
    do value = this.nextUint32(); while (value >= limit);
    return value % maxExclusive;
  }
}

export function deterministicDiceRound(seed: string, roomId: string, roundNo: number, contenderSeats: readonly number[]): DiceRoundResult {
  const rng = new DeterministicRandom(seed, `${roomId}|dice|${roundNo}`);
  const rolls = contenderSeats.map((seat) => {
    const dice = [rng.below(6) + 1, rng.below(6) + 1, rng.below(6) + 1] as DiceHand;
    return { seat, dice, evaluation: evaluateDice(dice) };
  });
  const best = rolls.reduce((current, row) => compareDice(row.evaluation, current.evaluation) > 0 ? row : current);
  const nextContenders = rolls.filter((row) => compareDice(row.evaluation, best.evaluation) === 0).map((row) => row.seat);
  return { round: roundNo, rolls, contenderSeats: nextContenders };
}

export function deterministicShuffle(seed: string, roomId: string, roundNo: number): DuelCard[] {
  const deck = createDeck();
  const rng = new DeterministicRandom(seed, `${roomId}|blackjack|${roundNo}`);
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = rng.below(index + 1);
    [deck[index], deck[swap]] = [deck[swap], deck[index]];
  }
  return deck;
}

export function initialBlackjackState(seed: string, roomId: string, roundNo: number, seats: readonly number[]): BlackjackRoomState {
  const deck = deterministicShuffle(seed, roomId, roundNo);
  const hands: Record<string, DuelCard[]> = Object.fromEntries(seats.map((seat) => [String(seat), []]));
  let cursor = 0;
  for (let cardNo = 0; cardNo < 2; cardNo += 1) {
    for (const seat of seats) hands[String(seat)].push(deck[cursor++]);
  }
  return {
    kind: "blackjack",
    ruleVersion: BLACKJACK_RULE_VERSION,
    deck,
    cursor,
    hands,
    evaluations: Object.fromEntries(seats.map((seat) => [String(seat), evaluateBlackjackHand(hands[String(seat)])])),
    actions: [],
  };
}

export function drawBlackjackCard(state: BlackjackRoomState, seat: number): DuelCard {
  const card = state.deck[state.cursor];
  if (!card) throw new Error("blackjack deck exhausted");
  state.cursor += 1;
  state.hands[String(seat)].push(card);
  state.ruleVersion = BLACKJACK_RULE_VERSION;
  state.evaluations ??= {};
  state.evaluations[String(seat)] = evaluateBlackjackHand(state.hands[String(seat)]);
  return card;
}

export function blackjackSeatScore(state: BlackjackRoomState, seat: number) {
  const evaluation = evaluateBlackjackHand(state.hands[String(seat)] ?? []);
  state.evaluations ??= {};
  state.evaluations[String(seat)] = evaluation;
  return evaluation;
}
