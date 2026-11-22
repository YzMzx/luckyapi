import { describe, expect, it } from "vitest";
import { confirmQuote, formatExchange, reviewReducer } from "./exchangeReview";
const initial = {
  direction: "in" as const,
  amountUnits: 2_000_000,
  netUnits: 4_000_000,
  feeUnits: 0,
  exchangeRate: 2000,
  redemptionFeeBps: 125,
};
describe("user-confirmed exchange previews", () => {
  it("freezes reviewed rules independently of configuration refresh and keeps the same retry key", () => {
    const source = { ...initial };
    const pending = reviewReducer(null, { type: "start", key: "request-a" });
    const reviewed = reviewReducer(pending, {
      type: "finish",
      key: "request-a",
      quote: source,
    })!;
    source.exchangeRate = 1000;
    expect(
      reviewReducer(reviewed, {
        type: "finish",
        key: "request-a",
        quote: source,
      })
    ).toBe(reviewed);
    expect(confirmQuote(reviewed)).toEqual({
      direction: "in",
      amountUnits: 2_000_000,
      expectedExchangeRate: 2000,
      expectedRedemptionFeeBps: 125,
      requestKey: "request-a",
    });
    expect(confirmQuote(reviewed)).toEqual(confirmQuote(reviewed));
  });
  it("ignores a cancelled, late preview even after a new amount and direction have been entered", () => {
    const first = reviewReducer(null, { type: "start", key: "old" });
    const cancelled = reviewReducer(first, { type: "clear" });
    expect(
      reviewReducer(cancelled, { type: "finish", key: "old", quote: initial })
    ).toBeNull();
    const next = reviewReducer(cancelled, { type: "start", key: "new" });
    expect(
      reviewReducer(next, { type: "finish", key: "old", quote: initial })
    ).toBe(next);
    const second = {
      ...initial,
      direction: "out" as const,
      amountUnits: 4_000_000,
      exchangeRate: 4000,
      feeUnits: 12_500,
      netUnits: 987_500,
    };
    const reviewed = reviewReducer(next, {
      type: "finish",
      key: "new",
      quote: second,
    })!;
    expect(confirmQuote(reviewed)).toMatchObject({
      requestKey: "new",
      direction: "out",
      amountUnits: 4_000_000,
      expectedExchangeRate: 4000,
    });
    expect(formatExchange(reviewed.quote!)).toEqual({
      debit: "4,000 模拟金",
      fee: "0.0125 余额",
      received: "0.9875 余额",
    });
  });
  it("formats deposits with credit input and simulated-cash output", () => {
    expect(formatExchange(initial)).toEqual({
      debit: "2 余额",
      fee: "0 余额",
      received: "4,000 模拟金",
    });
  });
});
