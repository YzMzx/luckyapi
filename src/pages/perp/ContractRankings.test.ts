import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import Rankings from "../Rankings";

const { ranking, weeks, weekBoard } = vi.hoisted(() => ({
  ranking: vi.fn(),
  weeks: vi.fn(),
  weekBoard: vi.fn(),
}));
const contracts = "contracts";
const profit = {
  category: contracts,
  key: "closed_profit",
  title: "平仓盈利榜",
  description: "主动平仓净盈利",
  unit: "sim",
  periods: ["week", "all"],
};
const loss = {
  ...profit,
  key: "liquidation_loss",
  title: "爆仓亏损榜",
  description: "爆仓实际亏损",
};
const weekStart = Date.parse("2026-11-16T00:00:00+08:00");
vi.mock("@/hooks/useMe", () => ({
  useMe: () => ({ user: { id: 1, onboarded: true } }),
}));
vi.mock("@/components/SiteNav", () => ({ SiteNav: () => null }));
vi.mock("./usePerpPresence", () => ({ usePerpPresence: () => {} }));
vi.mock("@/providers/trpc", () => ({
  trpc: {
    rankings: {
      catalog: {
        useQuery: () => ({
          data: {
            categories: [{ key: contracts, label: "合约" }],
            boards: [loss, profit],
          },
        }),
      },
      query: { useQuery: ranking },
    },
    perps: { weeks: { useQuery: weeks }, weekBoard: { useQuery: weekBoard } },
  },
}));
const render = (board: string) =>
  renderToStaticMarkup(
    createElement(MemoryRouter, {
      initialEntries: ["/leaderboard?category=contracts&board=" + board],
      children: createElement(Rankings),
    })
  );

it("shows the archived week directly inside the contract category, without a generic ranking request", () => {
  ranking.mockReturnValue({ isLoading: true });
  weeks.mockReturnValue({
    data: {
      weeks: [
        {
          weekStart,
          weekEnd: weekStart + 7 * 86_400_000,
          publishedAt: weekStart,
        },
      ],
      total: 1,
    },
  });
  weekBoard.mockReturnValue({
    data: {
      rows: [{ userId: 1, rank: 1, displayName: "周榜玩家", pnlUnits: 1400 }],
      total: 1,
      page: 1,
      pageSize: 20,
    },
  });
  const html = render("weekly");
  expect(html).toContain("合约周结算排行</h2>");
  expect(html).toContain("周榜玩家");
  expect(html).toContain("+1.4");
  expect(html).toContain("爆仓亏损榜");
  expect(html).toContain("平仓盈利榜");
  expect(ranking).toHaveBeenLastCalledWith(
    expect.objectContaining({ category: contracts }),
    expect.objectContaining({ enabled: false })
  );
  expect(weekBoard).toHaveBeenLastCalledWith(
    expect.objectContaining({ weekStart, side: "profit" }),
    expect.objectContaining({ enabled: true })
  );
});

it.each([profit, loss])(
  "renders the $title using simulated currency, not the weekly panel",
  board => {
    const row = {
      userId: 1,
      displayName: "合约玩家",
      metric: 12.345,
      detail: 2,
      rank: 1,
      badge: { level: 1, rank: null },
      avatarUrl: "",
    };
    ranking.mockReturnValue({
      data: {
        board,
        rows: [row],
        podium: [row],
        myRank: row,
        updatedAt: weekStart,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        total: 1,
      },
    });
    weeks.mockClear();
    const html = render(board.key);
    expect(html).toContain(board.title + "</h2>");
    const isLoss = board.key === loss.key;
    const metrics = [
      ...html.matchAll(/<span class="([^"]*)">([+-]12\.345 模拟金)<\/span>/g),
    ];
    expect(metrics).toHaveLength(3); // Podium, my rank and list row.
    for (const [, className, value] of metrics) {
      expect(value).toBe(isLoss ? "-12.345 模拟金" : "+12.345 模拟金");
      expect(className).toContain(
        isLoss ? "text-rose-300" : "text-emerald-300"
      );
    }
    expect(ranking).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: contracts, board: board.key }),
      expect.objectContaining({ enabled: true })
    );
    expect(weeks).not.toHaveBeenCalled();
  }
);
