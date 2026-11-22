import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { PendingOrderRows } from "./PendingOrders";
import type { PerpApi } from "./format";

type Pending = PerpApi["pendingOrders"][number];
const fixture = (overrides: Partial<Pending> = {}): Pending => ({
  id: 41,
  symbol: "BTCUSDT",
  action: "openLong",
  side: "long",
  orderType: "conditional",
  quantityAtoms: 100_000,
  leverage: 5,
  triggerDirection: "above",
  limitPriceUnits: 10_200_000,
  triggerPriceUnits: 10_000_000,
  status: "pending",
  createdAt: 1,
  updatedAt: 1,
  triggeredAt: null,
  fillOrderId: null,
  reason: null,
  ...overrides,
});
const render = (rows: Pending[], cancel?: (o: Pending) => void) =>
  renderToStaticMarkup(
    createElement(PendingOrderRows, {
      orders: rows,
      title: "个人委托",
      onCancel: cancel,
    })
  );
it("labels conditional limit price, trigger basis, units and active order cancellation", () => {
  const html = render([fixture()], vi.fn());
  for (const text of [
    "条件限价",
    "≥ 10,000 USDT",
    "10,200",
    "触发条件（标记价）",
    "0.001 BTC",
    "等待触发",
    'aria-label="撤销 BTCUSDT 委托 #41"',
    'role="region"',
    'scope="col"',
    'scope="row"',
  ])
    expect(html).toContain(text);
});
it("does not offer cancellation for rejected or filled orders and preserves rejection reason", () => {
  const html = render(
    [
      fixture({ status: "filled", limitPriceUnits: null }),
      fixture({
        id: 42,
        status: "rejected",
        orderType: "limit",
        triggerDirection: null,
        triggerPriceUnits: null,
        reason: "余额不足",
      }),
    ],
    vi.fn()
  );
  for (const text of ["条件市价", "已成交", "已拒绝", "余额不足"])
    expect(html).toContain(text);
  expect(html).not.toContain("<button");
});
