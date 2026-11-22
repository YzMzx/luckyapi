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
      minLeverage: 1,
      maxLeverage: 5,
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

it("starts with three calculate placeholders, a non-submit calculation and a native size slider", () => {
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

const leverageControl = (html: string) =>
  html.match(/<input[^>]*name="leverage"[^>]*>/)?.[0];

type Market = typeof props.market;
const tradeMarkup = (range: [number, number], market: Market = props.market) =>
  renderToStaticMarkup(
    createElement(TradeForm, {
      ...props,
      market,
      account: {
        ...props.account,
        config: {
          ...props.account.config,
          minLeverage: range[0],
          maxLeverage: range[1],
        },
      },
    })
  );

it.each([
  [3, 4, 4],
  [3, 12, 5],
  [5, 12, 5],
])(
  "starts at site minimum %i and caps site maximum %i at %i",
  (min, max, effectiveMax) => {
    const html = tradeMarkup([min, max]);
    const control = leverageControl(html);
    expect(control).toContain('type="number"');
    expect(control).toContain('step="1"');
    expect(control).toContain('min="' + min + '"');
    expect(control).toContain('max="' + effectiveMax + '"');
    expect(control).toContain('value="' + min + '"');
    expect(control).not.toContain("disabled");
    expect(html).toContain(
      "本品种允许 " + min + "×–" + effectiveMax + "× 的整数杠杆。"
    );
  }
);

it("does not substitute a lower leverage when the instrument cannot meet the site minimum", () => {
  const html = tradeMarkup([6, 10]);
  expect(leverageControl(html)).toContain("disabled");
  expect(leverageControl(html)).toContain('value=""');
  expect(html).toContain("Bybit 合约杠杆上限 5× 低于站内最低杠杆 6×");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>核对委托<\/button>/);
});

it("does not offer a leverage or order review while instrument specs are missing", () => {
  const html = tradeMarkup([3, 9], { ...props.market, instrument: null });
  expect(leverageControl(html)).toContain("disabled");
  expect(leverageControl(html)).toContain('value=""');
  expect(html).toContain("等待合约规格，暂不可选择杠杆。");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>核对委托<\/button>/);
});

it("explains a Finished market and disables order review", () => {
  const reason = "该合约盘前阶段已结束（Finished），本站暂不支持下单。";
  const market = { ...props.market, quote: null, readOnlyReason: reason };
  const html = renderToStaticMarkup(
    createElement(TradeForm, { ...props, market })
  );
  const review = html.split(">核对委托</button>")[0].split("<button").at(-1);
  expect(review).toContain("disabled");
  const id = review?.match(/aria-describedby="([^"]+)"/)?.[1];
  expect(id).toBeTruthy();
  expect(html).toContain('id="' + id + '"');
  expect(html).toContain(reason);
});

it("only offers long and short in the opening form even with a current position, and keeps sizing in the separate close form", () => {
  const account = {
    ...props.account,
    positions: [
      {
        userId: 1,
        symbol: "BTCUSDT",
        side: "short" as const,
        quantityAtoms: 100_000_000,
        entryNotionalUnits: 100_000,
        marginUnits: 50_000,
        leverage: 2,
        openedAt: 1,
        updatedAt: 1,
        nextFundingAt: 100_000,
        entryPriceUnits: 100_000,
        liquidationPriceUnits: 149_000,
      },
    ],
  };
  const open = renderToStaticMarkup(
    createElement(TradeForm, { ...props, account })
  );
  expect(open).toContain('value="openLong"');
  expect(open).toContain('value="openShort" selected=""');
  expect(open).not.toContain('value="close"');
  expect(open).toContain("成本（保证金 + 手续费）");
  expect(leverageControl(open)).toContain('value="2"');
  expect(leverageControl(open)).toContain("disabled");
  expect(open).not.toContain("不能加仓");
  const restrictedAccount = {
    ...account,
    config: { ...account.config, minLeverage: 3, maxLeverage: 5 },
  };
  const scaleIn = renderToStaticMarkup(
    createElement(TradeForm, { ...props, account: restrictedAccount })
  );
  expect(leverageControl(scaleIn)).toContain('value="2"');
  expect(leverageControl(scaleIn)).toContain("disabled");
  expect(scaleIn).toContain(
    "当前持仓杠杆 2× 不在允许范围 3×–5× 内，只能平仓，不能加仓。"
  );
  expect(scaleIn).toMatch(/<button[^>]*disabled=""[^>]*>100%<\/button>/);
  const close = renderToStaticMarkup(
    createElement(TradeForm, {
      ...props,
      account: restrictedAccount,
      variant: "close",
    })
  );
  expect(leverageControl(close)).toBeUndefined();
  expect(close).not.toContain("不能加仓");
  expect(close).toMatch(/<button(?![^>]*disabled=")[^>]*>100%<\/button>/);
  expect(close).not.toContain('value="openLong"');
  expect(close).not.toContain('value="openShort"');
  expect(close).toContain("可平数量");
  expect(close).toContain("平仓预估");
  expect(close).toContain("计算收益");
  for (const label of [
    "平仓数量",
    "参考平仓价",
    "释放保证金",
    "平仓手续费",
    "平仓净盈亏",
    "预计到账",
  ]) {
    expect(close).toContain("<dt>" + label + "</dt><dd>计算</dd>");
  }
  expect(close).not.toContain("预估强平价");
  expect(open).toContain("预估强平价");
  expect(close).toContain("条件限价单");
  expect(mutate).not.toHaveBeenCalled();
});
