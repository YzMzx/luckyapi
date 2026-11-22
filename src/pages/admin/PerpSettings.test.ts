import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../api/router";
import PerpSettings from "./PerpSettings";

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock("@/providers/trpc", () => ({
  trpc: {
    useUtils: () => ({}),
    admin: {
      perpSettings: {
        get: { useQuery },
        update: { useMutation: () => ({ isPending: false }) },
      },
    },
  },
}));

const saved: inferRouterOutputs<AppRouter>["admin"]["perpSettings"]["get"] = {
  symbols: [{ symbol: "BTCUSDT", name: "BTC/USDT 永续", openEnabled: true }],
  closeOnlySymbols: [],
  depositsEnabled: true,
  tradingEnabled: true,
  minLeverage: 3,
  maxLeverage: 17,
  exchangeRate: 1000,
  redemptionFeeBps: 500,
  userLimitUnits: 100_000_000,
  platformLimitUnits: 1_000_000_000,
  takerFeeBps: 6,
  maintenanceMarginBps: 50,
};
const render = () => renderToStaticMarkup(createElement(PerpSettings));

beforeEach(() => useQuery.mockReset());

it("does not render writable bounds while the admin settings are loading", () => {
  useQuery.mockReturnValue({ isLoading: true });
  const html = render();
  expect(html).toContain("加载配置中…");
  expect(html).not.toContain('name="minLeverage"');
  expect(html).not.toContain("保存合约配置");
});

it("uses the loaded leverage bounds in labeled integer inputs", () => {
  useQuery.mockReturnValue({ data: saved });
  const html = render();
  for (const [key, id, value] of [
    ["minLeverage", "min-leverage", 3],
    ["maxLeverage", "max-leverage", 17],
  ]) {
    const control = html.match(
      new RegExp('<input[^>]*id="' + id + '"[^>]*>')
    )?.[0];
    expect(control).toContain('name="' + key + '"');
    expect(control).toContain('value="' + value + '"');
    expect(control).toContain('type="number"');
    expect(control).toContain('min="1"');
    expect(control).toContain('max="100"');
    expect(control).toContain('step="1"');
    expect(control).toContain('required=""');
    expect(control).toContain('aria-describedby="leverage-policy-help"');
    expect(html).toContain('for="' + id + '"');
  }
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>保存合约配置<\/button>/);
});
