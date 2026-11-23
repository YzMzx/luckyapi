import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PositionMarginAction } from "./PositionMarginAction";
import {
  createMarginAttempt,
  isDefiniteMarginRejection,
  marginAmount,
  matchingMarginReview,
  type MarginReview,
} from "./positionMarginReview";

vi.mock("@/providers/trpc", () => ({
  trpc: {
    useUtils: () => ({}),
    perps: { addMargin: { useMutation: () => ({ isPending: false }) } },
  },
}));

const position = {
  symbol: "BTCUSDT",
  side: "long" as const,
  openedAt: 1000,
  quantityAtoms: 1000,
  marginUnits: 1501,
  liquidationPriceUnits: 0,
};
const render = (liquidationTriggeredAt?: number) =>
  renderToStaticMarkup(
    createElement(PositionMarginAction, {
      position: { ...position, liquidationTriggeredAt },
      availableCashUnits: 4500,
    })
  );

const review: MarginReview = {
  input: { symbol: "BTCUSDT", openedAt: 1000, amountUnits: 1250 },
  basis: "position-and-cash-snapshot",
  quote: {
    previousMarginUnits: 1501,
    marginUnits: 2751,
    previousLiquidationPriceUnits: 32000,
    liquidationPriceUnits: 0,
    availableCashUnits: 3250,
  },
};

describe("PositionMarginAction accessible starting state", () => {
  it("uses a named native dialog, explains the risk and offers preview only", () => {
    const html = render();
    expect(html).toContain("<dialog aria-labelledby=");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('inputMode="decimal"');
    expect(html).toContain('aria-invalid="false"');
    expect(html).toContain("当前可用：4.5 模拟金");
    expect(html).toContain("<dd>1.501 模拟金</dd>");
    expect(html).toContain("当前预估强平价</dt><dd>—</dd>");
    expect(html).toContain("不下单、不收手续费，也不会自动追加");
    expect(html).toContain("投入的模拟金可能全部损失");
    expect(html).toContain("预览追加保证金");
    expect(html).not.toContain("确认追加保证金");
  });

  it("explains and blocks new previews for an already triggered liquidation", () => {
    const html = render(1001);
    expect(html).toContain("此仓位已触发强平");
    expect(html).toContain('readOnly=""');
    expect(html).toMatch(/<button [^>]*disabled=""[^>]*>预览追加保证金/);
  });
});

describe("position margin review", () => {
  it.each([
    ["1.250", 1250],
    ["1", 1000],
    [".001", 1],
    [" 4.500 ", 4500],
  ])("converts %s to exactly %s integer units", (value, units) =>
    expect(marginAmount(value, 4500)).toEqual({ amountUnits: units })
  );

  it.each(["", "0", "-1", "1e-3", "1.0001", "1,001", "9007199254741"])(
    "rejects invalid input %s",
    value =>
      expect(marginAmount(value, Number.MAX_SAFE_INTEGER).error).toBeTruthy()
  );

  it("rejects valid decimal amounts above available simulated cash", () => {
    expect(marginAmount("4.501", 4500).error).toContain("不能超过");
  });

  it("matches only the precise amount, position instance and account snapshot", () => {
    const { input, basis } = review;
    expect(matchingMarginReview(review, input, basis)).toBe(review);
    expect(
      matchingMarginReview(review, { ...input, amountUnits: 1251 }, basis)
    ).toBeNull();
    expect(
      matchingMarginReview(review, { ...input, openedAt: 1001 }, basis)
    ).toBeNull();
    expect(
      matchingMarginReview(review, { ...input, symbol: "ETHUSDT" }, basis)
    ).toBeNull();
    expect(matchingMarginReview(review, input, "changed-account")).toBeNull();
  });

  it("issues no key without a reviewed intent, and retries send the identical payload", () => {
    const key = vi.fn(() => "unique-request");
    expect(createMarginAttempt(null, null, key)).toBeNull();
    expect(key).not.toHaveBeenCalled();
    const attempt = createMarginAttempt(null, review, key);
    expect(attempt?.request).toEqual({
      symbol: "BTCUSDT",
      openedAt: 1000,
      amountUnits: 1250,
      requestKey: "unique-request",
    });
    expect(createMarginAttempt(attempt, null, key)).toBe(attempt);
    expect(key).toHaveBeenCalledTimes(1);
  });

  it("only releases a rejected intent for known server-side business errors", () => {
    expect(isDefiniteMarginRejection({ data: { code: "BAD_REQUEST" } })).toBe(
      true
    );
    expect(isDefiniteMarginRejection({ data: { code: "CONFLICT" } })).toBe(
      true
    );
    expect(
      isDefiniteMarginRejection({ data: { code: "INTERNAL_SERVER_ERROR" } })
    ).toBe(false);
    expect(isDefiniteMarginRejection(new TypeError("Failed to fetch"))).toBe(
      false
    );
  });
});
