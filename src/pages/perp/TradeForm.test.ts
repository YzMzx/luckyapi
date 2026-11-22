import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { TradeForm } from "./TradeForm";
const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("@/providers/trpc", () => ({
  trpc: {
    useUtils: () => ({}),
    perps: {
      placeOrder: {
        useMutation: () => ({ isPending: false, mutateAsync: mutate }),
      },
      createPending: {
        useMutation: () => ({ isPending: false, mutateAsync: mutate }),
      },
    },
  },
}));
it("starts with three calculate placeholders, a non-submit calculation and a native size slider", () => {
  const props: ComponentProps<typeof TradeForm> = {
    market: {
      interval: 1,
      symbol: "BTCUSDT",
      name: "BTC/USDT 永续",
      openEnabled: true,
      tradingEnabled: true,
      bars: [],
      source: "mock",
      readOnlyReason: null,
      quote: {
        symbol: "BTCUSDT",
        asOf: 1,
        bidUnits: 100000,
        askUnits: 100010,
        markUnits: 100000,
        lastUnits: 100000,
        fundingRateE8: 1000,
        nextFundingAt: 100000,
      },
      instrument: {
        symbol: "BTCUSDT",
        qtyStepUnits: 100000,
        minQtyUnits: 100000,
        maxQtyUnits: 100000000,
        tickSizeUnits: 10,
        minNotionalUnits: 5000,
        maxLeverage: 5,
        fundingIntervalMs: 28800000,
      },
    },
    account: {
      cashUnits: 1000000,
      availableCashUnits: 1000000,
      permanentCreditUnits: 1,
      frozenCashUnits: 0,
      positions: [],
      orders: [],
      exchanges: [],
      funding: [],
      depositsEnabled: true,
      tradingEnabled: true,
      config: {
        symbols: [
          { symbol: "BTCUSDT", name: "BTC/USDT 永续", openEnabled: true },
        ],
        closeOnlySymbols: [],
        allowedLeverage: [1, 2, 5],
        userLimitUnits: 100000000,
        platformLimitUnits: 1000000000,
        exchangeRate: 1000,
        redemptionFeeBps: 500,
        depositsEnabled: true,
        tradingEnabled: true,
        takerFeeBps: 6,
        maintenanceMarginBps: 50,
      },
    },
  };
  const html = renderToStaticMarkup(createElement(TradeForm, props));
  expect(html.split("<dd>计算</dd>").length - 1).toBe(3);
  expect(html).toMatch(new RegExp('<button type="button"[^>]*>计算</button>'));
  expect(html).toMatch(/type="range" min="0" max="100" step="1"/);
  for (const label of [
    "市价单",
    "限价单",
    "条件市价单",
    "条件限价单",
    "核对委托",
  ])
    expect(html).toContain(">" + label + "<");
  expect(mutate).not.toHaveBeenCalled();
});
