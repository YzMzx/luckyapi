import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import PerpLiveBoard from "./PerpLiveBoard";
import type { PerpApi } from "./format";

const mocks = vi.hoisted(() => ({
  useMe: vi.fn(),
  usePresence: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock("@/hooks/useMe", () => ({ useMe: mocks.useMe }));
vi.mock("./usePerpPresence", () => ({ usePerpPresence: mocks.usePresence }));
vi.mock("@/components/SiteNav", () => ({ SiteNav: () => null }));
vi.mock("@/providers/trpc", () => ({
  trpc: { perps: { liveBoard: { useQuery: mocks.useQuery } } },
}));

const snapshot = {
  rows: [],
  mine: null,
  pendingPlayers: 0,
  updatedAt: Date.UTC(2026, 0, 1),
  page: 1,
  pageSize: 20,
  totalPages: 1,
  total: 0,
} satisfies PerpApi["liveBoard"];

const render = (data?: PerpApi["liveBoard"]) => {
  mocks.useQuery.mockReturnValue({ data });
  return renderToStaticMarkup(
    createElement(MemoryRouter, {
      initialEntries: ["/contracts/live"],
      children: createElement(PerpLiveBoard),
    })
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useMe.mockReturnValue({ user: { onboarded: true }, isLoading: false });
});

it("requires an onboarded session, uses presence and polls the profit board first", () => {
  render(snapshot);
  expect(mocks.useMe).toHaveBeenCalledWith({
    requireAuth: true,
    requireOnboarded: true,
  });
  expect(mocks.usePresence).toHaveBeenLastCalledWith(true);
  expect(mocks.useQuery).toHaveBeenLastCalledWith(
    { side: "profit", page: 1, pageSize: 20 },
    expect.objectContaining({ enabled: true, refetchInterval: 5000 })
  );

  mocks.useMe.mockReturnValue({ user: { onboarded: false }, isLoading: false });
  expect(render(snapshot)).not.toContain("我的实时盈亏");
  expect(mocks.usePresence).toHaveBeenLastCalledWith(false);
  expect(mocks.useQuery).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ enabled: false })
  );
});

it("names the board and table, marks the current player's row and shows its selected-side rank", () => {
  const html = render({
    ...snapshot,
    rows: [
      {
        nickname: "榜首玩家",
        rank: 1,
        pnlUnits: 1234,
        positionCount: 2,
        mine: true,
      },
    ],
    mine: { pnlUnits: 1234, rank: 1, positionCount: 2 },
    total: 21,
    totalPages: 2,
  });
  expect(html).toContain("合约实时盈亏榜</h1>");
  expect(html).toContain("实时盈利榜</h2>");
  expect(html).toContain("实时盈利榜排名</caption>");
  expect(html).toContain('scope="row"');
  expect(html).toContain("榜首玩家（我）");
  expect(html).toContain("+1.234 模拟金");
  expect(html).toContain("盈利榜第 1 名");
  expect(html).toContain('aria-label="下一页"');
  expect(html).toContain('href="/contracts"');
  expect(html).toContain('href="/contracts/square"');
});

it("shows a side-specific empty state without inventing a rank for a negative total on the profit board", () => {
  const html = render({
    ...snapshot,
    mine: { pnlUnits: -1500, rank: null, positionCount: 1 },
  });
  expect(html).toContain("当前盈利榜暂无排名。");
  expect(html).toContain("-1.5 模拟金");
  expect(html).not.toContain("榜第");
  expect(html).not.toContain("<table");
});

it("distinguishes incomplete valuations, flat positions and no open positions", () => {
  const pending = render({
    ...snapshot,
    pendingPlayers: 2,
    mine: { pnlUnits: null, rank: null, positionCount: 3 },
  });
  expect(pending).toContain("2 位玩家待估值，暂未列入榜单。");
  expect(pending).toContain("<strong>待估值</strong>");
  expect(pending).toContain("持仓 3 笔");
  expect(pending).not.toContain("0 模拟金");

  expect(
    render({ ...snapshot, mine: { pnlUnits: 0, rank: null, positionCount: 1 } })
  ).toContain("0 模拟金（持平）");
  expect(render(snapshot)).toContain("暂无未平仓合约。");
});
