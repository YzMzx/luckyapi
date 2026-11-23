import { decimalUnits } from "./format";

export type MarginInput = {
  symbol: string;
  openedAt: number;
  amountUnits: number;
};
export type MarginQuote = {
  previousMarginUnits: number;
  marginUnits: number;
  previousLiquidationPriceUnits: number;
  liquidationPriceUnits: number;
  availableCashUnits: number;
};
export type MarginReview = {
  input: MarginInput;
  basis: string;
  quote: MarginQuote;
};
type MarginRequest = MarginInput & { requestKey: string };
export type MarginAttempt = { request: MarginRequest; quote: MarginQuote };

export function marginAmount(raw: string, availableCashUnits: number) {
  // Treat a leading dot as zero; never interpret a grouping separator as a decimal.
  const value = raw.trim().replace(/^[.]/, "0.");
  const amountUnits = decimalUnits(value, 3);
  if (!amountUnits)
    return { error: "请输入大于 0 且最多三位小数的金额。" } as const;
  if (amountUnits > availableCashUnits)
    return { error: "追加金额不能超过当前可用模拟金。" } as const;
  return { amountUnits } as const;
}

export function matchingMarginReview(
  review: MarginReview | null,
  input: MarginInput,
  basis: string
) {
  if (
    review?.input.symbol === input.symbol &&
    review.input.openedAt === input.openedAt &&
    review.input.amountUnits === input.amountUnits &&
    review.basis === basis
  )
    return review;
  return null;
}

export function createMarginAttempt(
  attempt: MarginAttempt | null,
  freshReview: MarginReview | null,
  newRequestKey: () => string
): MarginAttempt | null {
  if (attempt || !freshReview) return attempt;
  return {
    request: { ...freshReview.input, requestKey: newRequestKey() },
    quote: freshReview.quote,
  };
}

export function isDefiniteMarginRejection(error: unknown) {
  if (!error || typeof error !== "object" || !("data" in error)) return false;
  const data = error.data;
  if (!data || typeof data !== "object" || !("code" in data)) return false;
  // A transport/server error can hide a committed request; only business rejections
  // can release the frozen intent and let the user start a different top-up.
  return [
    "BAD_REQUEST",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "PRECONDITION_FAILED",
    "UNPROCESSABLE_CONTENT",
  ].some(code => code === data.code);
}
