import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../api/router";
import AdminSevenPick from "./SevenPick";

const hooks = vi.hoisted(() => ({ overview: vi.fn(), start: vi.fn(), activate: vi.fn(), ruleVersions: vi.fn(), save: vi.fn() }));
const adminOverview = vi.fn();
const publicOverview = vi.fn();
const rules = vi.fn();
const history = vi.fn();
vi.mock("@/providers/trpc", () => ({
  trpc: {
    useUtils: () => ({
      admin: { sevenPick: { overview: { invalidate: adminOverview }, ruleVersions: { invalidate: rules } } },
      sevenPick: { overview: { invalidate: publicOverview }, history: { invalidate: history } },
    }),
    admin: { sevenPick: {
      overview: { useQuery: hooks.overview },
      startManualRound: { useMutation: hooks.start },
      activateRule: { useMutation: hooks.activate },
      ruleVersions: { useQuery: hooks.ruleVersions },
      setRuntime: { useMutation: () => ({}) },
      save: { useMutation: hooks.save },
      audit: { useQuery: () => ({}) },
      reviewRefund: { useMutation: () => ({}) },
    } },
  },
}));

type Overview = inferRouterOutputs<AppRouter>["admin"]["sevenPick"]["overview"];
const beijingMidnight = Date.parse("2026-11-23T16:00:00.000Z");
const active = {
  id: 41, enabled: true, effectiveAt: beijingMidnight, createdAt: beijingMidnight - 60_000, canceledAt: null,
  openMinutes: [90, 809], closeAfterMinutes: 7, drawAfterMinutes: 18,
  minStakeUnits: 1_250, maxStakeUnits: 84_500, multipliers: [0, 0, 0, 4, 15, 125, 1_500, 55_000],
  items: Array.from({ length: 32 }, (_, i) => ({ id: i + 1, position: i + 1,
    name: "生效宝物" + (i + 1), description: "生效描述" + (i + 1), imageUrl: "https://example.invalid/active.png" })),
} satisfies Overview["active"];
const draft = {
  ...active, id: 42, enabled: false, effectiveAt: beijingMidnight + 86_400_000,
  openMinutes: [600], items: active.items.map((item) => ({ ...item, name: "待生效宝物" + item.id })),
} satisfies Overview["latest"];
const newest = { ...active, id: 44, items: active.items.map((item) => ({ ...item, name: "最新保存宝物" + item.id })) };
const older = { ...active, id: 40, enabled: false, effectiveAt: beijingMidnight - 86_400_000, canceledAt: beijingMidnight - 172_800_000, openMinutes: [630] };
const data: Overview = {
  active, latest: newest, upcoming: draft, runtime: { paused: false, rfc3161Enabled: false }, launchReady: true,
  rounds: [], versions: [draft, active, older], manualStartBlock: null, activationBlocked: null,
};
const render = () => renderToStaticMarkup(createElement(AdminSevenPick));

beforeEach(() => {
  vi.resetAllMocks();
  hooks.overview.mockReturnValue({ data });
  hooks.start.mockReturnValue({});
  hooks.activate.mockReturnValue({});
  hooks.save.mockReturnValue({});
  hooks.ruleVersions.mockReturnValue({ data: { items: data.versions, nextBeforeId: null } });
});

it("shows the read-only active rules independently of the pending draft", () => {
  const html = render();
  const readonly = html.split("当前已启用规则（只读）")[1]?.split("</section>")[0];
  expect(readonly).toContain("#41");
  expect(readonly).toContain('dateTime="2026-11-23T16:00:00.000Z">2026年11月24日 00:00');
  expect(readonly).toContain("01:30、13:29");
  expect(readonly).toContain("最低 1.25 · 最高 84.5");
  expect(readonly).toContain("55,000×");
  expect(readonly).toContain("查看生效宝物（32 件）");
  expect(readonly).toContain("生效宝物32");
  expect(readonly).toContain("生效描述32");
  expect(readonly).toContain("https://example.invalid/active.png");
  expect(readonly).not.toContain("<input");
  expect(readonly).not.toContain("待生效宝物");
  expect(html).toContain("下次排期：版本 #42 · 停用");
  expect(html).not.toContain("下次排期：版本 #44");
  expect(html).not.toContain('value="最新保存宝物32"');
  expect(html).toContain('value="待生效宝物32"');
});

it("offers any other saved rule, including canceled and disabled rules, but not the current enabled one", () => {
  const html = render();
  expect(html).toContain("其他规则");
  expect(html).not.toContain('aria-label="立即启用版本 #41"');
  expect(html).toContain('aria-label="立即启用版本 #42"');
  expect(html).toContain("版本 #40 · 排期已取消");
  expect(html).toContain('aria-label="立即启用版本 #40"');
  expect(html).toContain("10:30");
  expect(html).toContain("1.25–84.5");

  hooks.overview.mockReturnValue({ data: { ...data, active: { ...active, enabled: false } } });
  const disabled = render();
  expect(disabled).toContain("当前没有已启用的规则。");
  expect(disabled).toContain("版本 #41 · 当前停用");
  expect(disabled).toContain('aria-label="立即启用版本 #41"');
});

it("uses a native confirmation to disclose cloning, canceled scheduling, and unchanged rounds and pause", () => {
  hooks.overview.mockReturnValue({ data: { ...data, runtime: { ...data.runtime, paused: true } } });
  const html = render();
  const confirmation = html.split("确认立即启用规则？")[1]?.split("</dialog>")[0];
  expect(confirmation).toContain("复制所选规则，创建一个立即生效的已启用版本，即使原版本为停用状态");
  expect(confirmation).toContain("不会修改已保存版本的规则内容，也不会影响已创建的场次");
  expect(confirmation).toContain("此操作会取消已安排的规则变更，包括版本 #42");
  expect(confirmation).toContain("已取消的版本仍会保留，可再次选择启用");
  expect(confirmation).toContain("明日起仍沿用本次启用的规则");
  expect(confirmation).toContain("当前已暂停接单，启用规则后仍会保持暂停");
  expect(confirmation).toMatch(/<form[^>]*method="dialog"[^>]*><button[^>]*autofocus=""[^>]*>取消<\/button>/i);
  expect(html.match(/<button[^>]*aria-label="立即启用版本 #40"[^>]*>/)?.[0]).not.toContain('aria-disabled="true"');
});

it("offers explicit scheduled choices and handles no upcoming version independently of the latest ID", () => {
  hooks.overview.mockReturnValue({ data: { ...data, upcoming: null } });
  const html = render();
  expect(html).toContain("没有待生效的排期；若不另行安排，明日起仍沿用当前规则。");
  expect(html).toContain("保存并安排明日 00:00 生效");
  expect(html).toContain("这条规则的启用状态");
  expect(html).toMatch(/type="radio"[^>]*checked=""[^>]*value="true"/);
  expect(html).toMatch(/type="radio"[^>]*value="false"/);
  expect(html).not.toContain("为次日配置开启玩法");
  expect(html).not.toContain("下次排期：版本 #44");
  expect(html).toContain('value="生效宝物32"');
});

it("shows version pagination from the history query", () => {
  hooks.ruleVersions.mockReturnValue({ data: { items: [older], nextBeforeId: older.id } });
  const html = render();
  expect(hooks.ruleVersions).toHaveBeenCalledWith(undefined, expect.any(Object));
  expect(html).toContain('aria-label="规则版本分页"');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>较新一页<\/button>/);
  expect(html).toContain("较旧一页");
  expect(html).toContain('aria-label="立即启用版本 #40"');
});

it("blocks immediate activation during maintenance or a refresh error", () => {
  hooks.overview.mockReturnValue({ data: { ...data, activationBlocked: "系统正在维护，暂时无法启用规则" } });
  let html = render();
  expect(html).toContain("暂不可立即启用：系统正在维护，暂时无法启用规则");
  expect(html).toMatch(/aria-label="立即启用版本 #40"[^>]*aria-disabled="true"/);
  hooks.overview.mockReturnValue({ data, error: new Error("网络连接失败") });
  html = render();
  expect(html).toContain("暂不可立即启用：请先刷新，确认当前规则与排期。");
});

it("announces the new active version or a failure and repairs stale caches without retrying activation", async () => {
  hooks.activate.mockReturnValue({ data: { ...older, id: 45, enabled: true } });
  expect(render()).toContain("已创建并启用新版本 #45。之前的规则排期已清除；若不重新安排，明日起仍沿用此版本。");
  hooks.activate.mockReturnValue({ error: { data: { code: "CONFLICT" }, message: "规则已变更，请刷新后重新确认" } });
  expect(render()).toContain("立即启用失败：规则已变更，请刷新后重新确认");
  const options = hooks.activate.mock.lastCall?.[0];
  expect(options?.retry).toBe(false);
  await options?.onSettled(undefined, new Error("conflict"));
  expect(adminOverview).toHaveBeenCalledOnce();
  expect(rules).toHaveBeenCalledOnce();
  expect(publicOverview).toHaveBeenCalledOnce();
});

it("shows the server's reason for disabling manual start", () => {
  hooks.overview.mockReturnValue({ data: { ...data, manualStartBlock: "已有场次正在开放投注" } });
  const html = render();
  expect(html).toContain("暂不可开启：已有场次正在开放投注");
  expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>开启场次<\/button>/);
});

it("keeps the loaded rules visible but blocks start if a refresh fails", () => {
  hooks.overview.mockReturnValue({ data, error: new Error("网络连接失败") });
  const html = render();
  expect(html).toContain("刷新失败，当前显示上次加载的配置：网络连接失败");
  expect(html).toContain("查看生效宝物（32 件）");
  expect(html).toContain("暂不可开启：请先刷新，确认当前生效配置与场次状态。");
});

it("distinguishes an open round, a risk-skipped round and a mutation failure", () => {
  hooks.start.mockReturnValue({ data: { id: 89, status: "open", closesAt: beijingMidnight } });
  expect(render()).toContain("第 89 场已开盘");
  hooks.start.mockReturnValue({ data: { id: 90, status: "risk_skipped" } });
  const skipped = render();
  expect(skipped).toContain("第 90 场因风控跳过，未开放投注");
  expect(skipped).not.toContain("第 90 场已开盘");
  hooks.start.mockReturnValue({ error: { data: { code: "CONFLICT" }, message: "当前生效配置已变更，请刷新后再开启" } });
  expect(render()).toContain("开启场次失败：当前生效配置已变更，请刷新后再开启");
  hooks.start.mockReturnValue({ error: new Error("网络连接失败") });
  expect(render()).toContain("未能确认开场结果，请先查看场次记录再重试。错误详情：网络连接失败");
});

it("revalidates the admin and public views even when start fails", async () => {
  render();
  const options = hooks.start.mock.lastCall?.[0];
  expect(options?.retry).toBe(false);
  await options?.onSettled(undefined, new Error("conflict"));
  expect(adminOverview).toHaveBeenCalledOnce();
  expect(publicOverview).toHaveBeenCalledOnce();
  expect(history).toHaveBeenCalledOnce();
});
