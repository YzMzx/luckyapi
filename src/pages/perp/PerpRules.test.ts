import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PerpRules } from "./PerpRules";

const config: NonNullable<ComponentProps<typeof PerpRules>["config"]> = {
  symbols: [],
  closeOnlySymbols: [],
  minLeverage: 3,
  maxLeverage: 18,
  userLimitUnits: 100_000_000,
  platformLimitUnits: 500_000_000,
  exchangeRate: 2500,
  redemptionFeeBps: 250,
  depositsEnabled: true,
  tradingEnabled: true,
  takerFeeBps: 6,
  maintenanceMarginBps: 50,
};
const render = (settings?: typeof config) =>
  renderToStaticMarkup(createElement(PerpRules, { config: settings }));

it("offers a named rules dialog with the loaded trading and exchange settings", () => {
  const html = render(config);
  expect(html).toContain("Bybit 公开行情 · 24 小时模拟交易 · 逐仓保证金");
  expect(html).toContain('aria-haspopup="dialog"');
  expect(html).toContain(">规则</button>");
  const id = html.match(/<dialog aria-labelledby="([^"]+)"/)?.[1];
  expect(id).toBeTruthy();
  expect(html).toContain('id="' + id + '"');
  for (const text of [
    "市价单",
    "条件单",
    "逐仓、手续费和强平",
    "站内杠杆范围：3×–18×，仅限整数倍",
    "开仓和加仓的杠杆上限取站内上限与 Bybit 合约上限中较低者",
    "超出范围的持仓仍可平仓，但不能加仓",
    "2,500 模拟金",
    "2.5% 手续费",
    "100,000",
    "500,000",
    "只对已兑回的净盈利发经验",
    "200 EXP",
    "周榜与持仓广场",
  ]) {
    expect(html).toContain(text);
  }
});

it("keeps the rules available before settings load and does not claim a fee when it is zero", () => {
  expect(render()).toContain(
    "当前兑换比例和兑回手续费请以「余额兑换」预览为准。"
  );
  expect(render()).toContain(
    "杠杆范围和开平仓手续费以交易表单的当前规则为准。"
  );
  expect(render()).not.toContain("站内杠杆范围：");
  const noFee = render({ ...config, redemptionFeeBps: 0 });
  expect(noFee).toContain("当前兑回免手续费。");
  expect(noFee).not.toContain("原额兑回也会收费");
});
