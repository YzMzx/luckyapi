import { credit, sim } from "./format";

type Amounts = {
  direction: "in" | "out";
  amountUnits: number;
  feeUnits: number;
  netUnits: number;
};
export type ExchangeQuote = Amounts & {
  estimatedExp: number;
  exchangeRate: number;
  redemptionFeeBps: number;
};
export function formatExchange(q: Amounts) {
  return {
    debit:
      q.direction === "in"
        ? credit(q.amountUnits) + " 余额"
        : sim(q.amountUnits) + " 模拟金",
    fee: credit(q.feeUnits) + " 余额",
    received:
      q.direction === "in"
        ? sim(q.netUnits) + " 模拟金"
        : credit(q.netUnits) + " 余额",
  };
}
export type ExchangeReview = {
  key: string;
  quote: ExchangeQuote | null;
} | null;
export type ReviewAction =
  | { type: "clear" }
  | { type: "start"; key: string }
  | { type: "finish"; key: string; quote: ExchangeQuote };
export function reviewReducer(
  state: ExchangeReview,
  event: ReviewAction
): ExchangeReview {
  if (event.type === "clear") return null;
  if (event.type === "start") return { key: event.key, quote: null };
  return state?.key === event.key && !state.quote
    ? { key: state.key, quote: { ...event.quote } }
    : state;
}
export function confirmQuote(review: NonNullable<ExchangeReview>) {
  const q = review.quote;
  if (!q) throw new Error("请先预览兑换");
  return {
    requestKey: review.key,
    direction: q.direction,
    amountUnits: q.amountUnits,
    expectedExchangeRate: q.exchangeRate,
    expectedRedemptionFeeBps: q.redemptionFeeBps,
  };
}
