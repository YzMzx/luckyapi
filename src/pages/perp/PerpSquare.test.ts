import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import type { Pager } from "@/components/Pager";
import PerpSquare from "./PerpSquare";
import type { PerpApi } from "./format";

type Square = PerpApi["positionSquare"];
type Group = Square["groups"][number];
type Item = Group["items"][number];
type PageState = { pages: Record<string, number>; previousData?: Square };

const mocks = vi.hoisted(() => ({
  useMe: vi.fn(),
  usePresence: vi.fn(),
  useQuery: vi.fn(),
  useState: vi.fn(),
  pager: vi.fn<(props: ComponentProps<typeof Pager>) => void>(),
}));

vi.mock("react", async importOriginal => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: mocks.useState,
}));
vi.mock("@/hooks/useMe", () => ({ useMe: mocks.useMe }));
vi.mock("./usePerpPresence", () => ({ usePerpPresence: mocks.usePresence }));
vi.mock("@/components/SiteNav", () => ({ SiteNav: () => null }));
vi.mock("@/providers/trpc", () => ({
  trpc: { perps: { positionSquare: { useQuery: mocks.useQuery } } },
}));
vi.mock("@/components/Pager", async importOriginal => {
  const actual = await importOriginal<typeof import("@/components/Pager")>();
  return {
    Pager(props: ComponentProps<typeof Pager>) {
      mocks.pager(props);
      return createElement(actual.Pager, props);
    },
  };
});

const btc = {
  nickname: "比特币持仓人",
  symbol: "BTCUSDT",
  side: "long",
  quantityAtoms: 100_000_000,
  leverage: 3,
  entryPriceUnits: 50_000,
  markPriceUnits: 51_250,
  pnlUnits: 1250,
  online: true,
  mine: true,
} satisfies Item;
const eth = {
  ...btc,
  nickname: "以太坊持仓人",
  symbol: "ETHUSDT",
  side: "short",
  markPriceUnits: null,
  pnlUnits: null,
  online: false,
  mine: false,
} satisfies Item;

const group = (item: Item, page: number, total: number): Group => ({
  symbol: item.symbol,
  page,
  pageSize: 20,
  total,
  totalPages: Math.ceil(total / 20),
  items: [item],
});
const firstPages: Square = {
  onlineHolders: 1,
  groups: [group(btc, 1, 45), group(eth, 1, 21)],
};

let state: PageState | undefined;
const setState = (set: (previous: PageState) => PageState) => {
  state = set(state ?? { pages: {} });
};

const render = (
  query: {
    data?: Square;
    isPlaceholderData?: boolean;
    isLoading?: boolean;
    isFetching?: boolean;
    error?: Error;
  } = { data: firstPages }
) => {
  mocks.pager.mockClear();
  mocks.useQuery.mockReturnValue(query);
  return renderToStaticMarkup(
    createElement(MemoryRouter, {
      initialEntries: ["/contracts/square"],
      children: createElement(PerpSquare),
    })
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  state = undefined;
  mocks.useState.mockImplementation((initial: PageState) => [
    state ?? initial,
    setState,
  ]);
  mocks.useMe.mockReturnValue({ user: { onboarded: true }, isLoading: false });
});

it("queries all contracts with an empty page map, polls, and tracks member presence", () => {
  render();
  expect(mocks.useMe).toHaveBeenCalledWith({
    requireAuth: true,
    requireOnboarded: true,
  });
  expect(mocks.usePresence).toHaveBeenLastCalledWith(true);
  expect(mocks.useQuery).toHaveBeenLastCalledWith(
    { pages: {} },
    expect.objectContaining({ enabled: true, refetchInterval: 5000 })
  );
  expect(mocks.useQuery.mock.lastCall?.[1].placeholderData(firstPages)).toBe(
    firstPages
  );

  mocks.useMe.mockReturnValue({ user: { onboarded: false }, isLoading: false });
  expect(render()).not.toContain("持仓广场");
  expect(mocks.usePresence).toHaveBeenLastCalledWith(false);
  expect(mocks.useQuery).toHaveBeenLastCalledWith(
    { pages: {} },
    expect.objectContaining({ enabled: false })
  );
});

it("renders one named table per contract and keeps the holdership display without filters or ranking", () => {
  const html = render();
  const tables = html.match(/<table[\s\S]*?<\/table>/g) ?? [];
  expect(tables).toHaveLength(2);
  expect(tables[0]).toContain("BTCUSDT 会员公开持仓</caption>");
  expect(tables[0]).toContain('scope="row"');
  expect(tables[0]).toContain('scope="col"');
  expect(tables[0]).toContain("比特币持仓人（我）");
  expect(tables[0]).not.toContain(eth.nickname);
  expect(tables[0]).toContain(">在线</td>");
  expect(tables[0]).toContain('text-emerald-300">+1.25</span>');
  expect(tables[1]).toContain("ETHUSDT 会员公开持仓</caption>");
  expect(tables[1]).toContain(eth.nickname);
  expect(tables[1]).not.toContain(btc.nickname);
  expect(tables[1]).toContain(">离线</td>");
  expect(tables[1]).toContain('text-muted-foreground">待估值</span>');
  expect(html).toContain("在线持仓玩家：1 人");
  expect(html).toContain('href="/contracts"');
  expect(html).not.toMatch(
    /<select|<input|分类|只看在线|实时盈亏榜|\/contracts\/live/
  );
  expect(
    mocks.pager.mock.calls.map(([p]) => [p.page, p.pageSize, p.totalPages])
  ).toEqual([
    [1, 20, 3],
    [1, 20, 2],
  ]);
});

it("updates only the selected contract and never puts old rows under its requested page", () => {
  render();
  const btcPage = mocks.pager.mock.calls[0][0].onPage;
  btcPage(2);
  btcPage(3); // Simulate another activation before React's next render.
  expect(state?.pages).toEqual({ BTCUSDT: 2 });
  const placeholder = render({ data: firstPages, isPlaceholderData: true });
  expect(mocks.useQuery).toHaveBeenLastCalledWith(
    { pages: { BTCUSDT: 2 } },
    expect.anything()
  );
  expect(placeholder.match(/<table/g)).toHaveLength(2);
  expect(placeholder).toContain("正在加载第 2 页…");
  expect(placeholder).not.toContain(btc.nickname);
  expect(placeholder).toContain(eth.nickname);
  expect(placeholder).toContain("在线持仓玩家：1 人");
  expect(placeholder.match(/<fieldset disabled=""/g)).toHaveLength(1);
  mocks.pager.mock.calls[0][0].onPage(3);
  expect(state?.pages).toEqual({ BTCUSDT: 2 });

  mocks.pager.mock.calls[1][0].onPage(2);
  expect(state?.pages).toEqual({ BTCUSDT: 2, ETHUSDT: 2 });
  const loaded = render({
    data: {
      onlineHolders: 1,
      groups: [
        group({ ...btc, nickname: "BTC 次页持仓人" }, 2, 45),
        group({ ...eth, nickname: "ETH 次页持仓人" }, 2, 21),
      ],
    },
  });
  expect(loaded).toContain("BTC 次页持仓人");
  expect(loaded).toContain("ETH 次页持仓人");
  expect(loaded).not.toContain("正在加载第");
  mocks.pager.mock.calls[0][0].onPage(1);
  expect(state?.pages).toEqual({ ETHUSDT: 2 });
});

it("keeps other tables when a page fails and prunes inactive keys after clamping", () => {
  render();
  mocks.pager.mock.calls[0][0].onPage(3);
  const failed = render({ error: new Error("网络错误") });
  expect(failed).toContain('role="alert"');
  expect(failed).toContain("未能加载第 3 页。");
  expect(failed).not.toContain(btc.nickname);
  expect(failed).toContain(eth.nickname);

  const clamped = render({
    data: { onlineHolders: 1, groups: [group(btc, 2, 25)] },
    isFetching: true,
  });
  expect(clamped).toContain(btc.nickname);
  expect(clamped).toContain("第 2/2 页");
  expect(clamped).not.toContain("正在加载");

  render({ data: { onlineHolders: 0, groups: [group(eth, 1, 21)] } });
  mocks.pager.mock.calls[0][0].onPage(2);
  expect(state?.pages).toEqual({ ETHUSDT: 2 });
  expect(render({ data: { onlineHolders: 0, groups: [] } })).toContain(
    "当前暂无公开持仓。"
  );
});
