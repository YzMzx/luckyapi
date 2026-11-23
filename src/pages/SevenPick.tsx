import { useEffect, useState } from "react";
import { Gem } from "lucide-react";
import { Link } from "react-router";
import { SiteNav } from "@/components/SiteNav";
import { useMe } from "@/hooks/useMe";
import { trpc } from "@/providers/trpc";
import { cn } from "@/lib/utils";
import { requestBalanceRefresh } from "@/lib/balance-sync";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";

const beijing = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const statusLabels: Record<string, string> = {
  scheduled: "待开盘", open: "已开盘", sealed: "已封盘", ots_waiting: "等待开奖", review: "异常待核查",
  risk_skipped: "风控跳过", settled: "已结算", refunding: "退款中", refunded: "已退款",
};
const money = (units: number) => (units / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 3 });
const hhmm = (minute: number) => [Math.floor(minute / 60), minute % 60].map((n) => String(n).padStart(2, "0")).join(":");

function TreasureImage({ url }: { url: string | null }) {
  const [broken, setBroken] = useState(false);
  return url && !broken
    ? <img src={url} alt="" width={48} height={48} className="h-12 w-12 rounded-lg object-cover" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
    : <Gem aria-hidden="true" className="h-6 w-6 text-[#FFB700]" />;
}

type Items = inferRouterOutputs<AppRouter>["sevenPick"]["overview"]["preview"]["items"];
type Overview = inferRouterOutputs<AppRouter>["sevenPick"]["overview"];
type OrderRules = Pick<Overview["preview"], "minStakeUnits" | "maxStakeUnits">;
type DraftBet = { itemIds: number[]; amount: string };
const betAmountPattern = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,3})?$/;

function stakeUnits(amount: string) {
  if (!betAmountPattern.test(amount)) return NaN;
  const [whole, fraction = ""] = amount.split(".");
  return Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
}

function RoundCountdown({ deadline, serverOffset, label }: { deadline: number; serverOffset: number; label: string }) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const remaining = Math.max(0, Math.ceil((deadline - clock - serverOffset) / 1000));
  const display = [Math.floor(remaining / 3600), Math.floor(remaining / 60) % 60, remaining % 60]
    .map((value) => String(value).padStart(2, "0")).join(":");
  return remaining > 0 ? <p className="font-num tabular-nums">{label} <span role="timer">{display}</span></p> : null;
}

function Selection({ items, rules, roundId, acceptingOrders, ordersInRound }: {
  items: Items; rules: OrderRules; roundId: number | undefined; acceptingOrders: boolean; ordersInRound: number;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [drafts, setDrafts] = useState<DraftBet[]>([]);
  const [amount, setAmount] = useState(String(rules.minStakeUnits / 1000));
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [formMessage, setFormMessage] = useState("");
  const utils = trpc.useUtils();
  const place = trpc.sevenPick.place.useMutation({
    onSuccess: (order) => {
      setDrafts([]);
      setSelected([]);
      setRequestKey(null);
      setFormMessage("已提交 " + order.bets.length + " 组，回执见我的订单。");
      requestBalanceRefresh();
      void utils.sevenPick.account.invalidate();
      void utils.sevenPick.overview.invalidate();
    },
  });
  const remaining = Math.max(0, 5 - ordersInRound);
  const units = stakeUnits(amount);
  const canAdd = selected.length === 7 && units >= rules.minStakeUnits && units <= rules.maxStakeUnits && drafts.length < remaining;
  const totalUnits = drafts.reduce((total, bet) => total + stakeUnits(bet.amount), 0);
  const busy = place.isPending;

  function addDraft() {
    if (!canAdd) return;
    const itemIds = [...selected].sort((a, b) => a - b);
    if (drafts.some((bet) => bet.itemIds.every((id, i) => id === itemIds[i]))) {
      setFormMessage("这组宝物已加入订单。");
      return;
    }
    setDrafts([...drafts, { itemIds, amount }]);
    setSelected([]);
    setRequestKey(null);
    setFormMessage("");
    place.reset();
  }
  return (
    <section aria-labelledby="seven-pick-selection" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="seven-pick-selection" className="text-xl font-bold">{acceptingOrders ? "选择宝物" : "宝物试选"}</h2>
        <div className="flex items-center gap-4">
          <span role="status" className="text-sm">已选 {selected.length} / 7 件</span>
          <button type="button" className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50" disabled={!selected.length} onClick={() => setSelected([])}>清空</button>
        </div>
      </div>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        {items.map((item) => {
          const checked = selected.includes(item.id);
          return (
            <li key={item.id}>
              <button type="button" aria-pressed={checked} disabled={!checked && selected.length === 7}
                onClick={() => setSelected((prev) => prev.includes(item.id) ? prev.filter((id) => id !== item.id) : prev.length < 7 ? [...prev, item.id] : prev)}
                className={cn("flex h-full min-h-28 w-full flex-col items-center justify-center gap-2 rounded-xl border px-2 py-3 text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FFB700] disabled:opacity-50", checked ? "border-[#FFB700] bg-[#FFB700]/10" : "border-border bg-card") }>
                <TreasureImage key={item.imageUrl} url={item.imageUrl} />
                <span className="break-all text-sm font-bold">{item.name}{checked ? <span aria-hidden="true"> ✓</span> : null}</span>
                {item.description && <span className="break-all text-xs text-muted-foreground">{item.description}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {acceptingOrders && roundId !== undefined && <form className="space-y-4 rounded-2xl border border-border bg-card p-5" onSubmit={(event) => {
        event.preventDefault();
        if (busy || !drafts.length || (drafts.length > remaining && !requestKey)) return;
        // Retrying the same batch after a network error reuses its idempotency key.
        const key = requestKey ?? crypto.randomUUID();
        setRequestKey(key);
        setFormMessage("");
        place.mutate({ roundId, bets: drafts, requestKey: key });
      }}>
        <fieldset className="flex flex-wrap items-end gap-3" disabled={busy}>
          <legend className="font-semibold">添加一组</legend>
          <label className="text-sm">金额（模拟 USDT）
            <input className="mt-1 block max-w-44 rounded-lg border border-border bg-background p-2" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} aria-describedby="seven-pick-amount-hint" />
          </label>
          <button type="button" className="rounded-lg border border-border px-4 py-2 disabled:opacity-50" disabled={!canAdd} onClick={addDraft}>加入投注单</button>
        </fieldset>
        <p id="seven-pick-amount-hint" className="text-sm text-muted-foreground">{money(rules.minStakeUnits)}–{money(rules.maxStakeUnits)}，最多三位小数。本场已提交 {ordersInRound} / 5 组。</p>
        {drafts.length > 0 && <ul className="space-y-2 text-sm">{drafts.map((bet) => {
          const id = bet.itemIds.join(",");
          return <li key={id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
            <span>{bet.itemIds.map((itemId) => items.find((item) => item.id === itemId)?.name ?? itemId).join("、")} · {bet.amount} 模拟 USDT</span>
            <button type="button" className="underline" disabled={busy} onClick={() => {
              setDrafts(drafts.filter((draft) => draft !== bet));
              setRequestKey(null);
              place.reset();
            }}>移除</button>
          </li>;
        })}</ul>}
        <p className="text-sm text-muted-foreground">封盘后匿名证明公开每组组合和精确金额，仍可能被外部信息关联。</p>
        <p role="status" className="text-sm">{formMessage}</p>
        {place.error && <p role="alert" className="text-sm text-destructive">{place.error.message}</p>}
        <button type="submit" className="rounded-lg bg-[#FFB700] px-4 py-2 font-bold text-[#101d2b] disabled:opacity-50" disabled={busy || !drafts.length || (drafts.length > remaining && !requestKey)}>
          {busy ? "提交中…" : "提交 " + drafts.length + " 组 · " + money(totalUnits) + " 模拟 USDT"}
        </button>
      </form>}
    </section>
  );
}

export default function SevenPick() {
  const { user } = useMe();
  const overview = trpc.sevenPick.overview.useQuery(undefined, { refetchInterval: (query) => query.state.data?.launchReady ? 5_000 : 30_000 });
  const [historyCursors, setHistoryCursors] = useState<number[]>([]);
  const beforeOpensAt = historyCursors.at(-1);
  const history = trpc.sevenPick.history.useQuery(beforeOpensAt ? { beforeOpensAt } : undefined, { refetchInterval: beforeOpensAt ? false : 30_000 });
  const account = trpc.sevenPick.account.useQuery(undefined, { enabled: !!user?.onboarded, refetchInterval: 15_000 });
  const [roundId, setRoundId] = useState<number | null>(null);
  const detail = trpc.sevenPick.round.useQuery({ roundId: roundId ?? 0 }, { enabled: roundId !== null, refetchInterval: 15_000 });
  const info = overview.data;
  const rules = info?.round ?? info?.preview;
  const liveRound = info?.round;
  const detailRound = detail.data;
  const ordersInRound = account.data?.orders.reduce((total, order) => order.roundId === liveRound?.id ? total + order.bets.length : total, 0) ?? 0;
  return (
    <div className="min-h-screen">
      <SiteNav user={user} />
      <main className="mx-auto max-w-6xl space-y-8 px-4 py-10">
        <header className="space-y-3">
          <Link to="/entertainment" className="text-sm text-[#FFB700] hover:underline">← 娱乐中心</Link>
          <p className="text-xs font-bold tracking-[.3em] text-[#af915f]">32 选 7</p>
          <h1 className="text-4xl font-black">七星寻宝</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">从 32 件宝物中任选 7 件，按命中数获得模拟 USDT 返还。</p>
        </header>
        {overview.isPending && <p role="status">正在加载玩法…</p>}
        {overview.error && <p role="alert">玩法加载失败。<button type="button" onClick={() => void overview.refetch()} className="ml-2 underline">重试</button></p>}
        {info && rules && <>
          <section aria-labelledby="seven-pick-rules" className="space-y-3 rounded-2xl border border-border bg-card p-5">
            <h2 id="seven-pick-rules" className="text-lg font-bold">场次与玩法</h2>
            {info.round ? <p>第 {info.round.id} 场 · {statusLabels[info.round.status] ?? info.round.status} · {beijing.format(info.round.closesAt)} 封盘 · {beijing.format(info.round.drawAt)} 目标开奖（北京时间）</p> : <p>暂无正式场次。</p>}
            {!info.launchReady && <p className="text-sm text-muted-foreground">游戏暂未启用，当前可试选。</p>}
            {liveRound && <p className="text-sm">固定 Quicknet 轮次：<code>{liveRound.quicknetRound}</code> · <code>{liveRound.algorithmVersion}</code></p>}
            <p className="text-sm text-muted-foreground">每场在开盘前公开绑定轮次，验签通过后开奖。RFC 3161 是可选的封盘时间凭证，不影响派奖。</p>
            {info.launchReady && !info.configured && <p className="text-sm text-muted-foreground">当前配置未启用。</p>}
            {liveRound && liveRound.status === "open" && <RoundCountdown deadline={liveRound.closesAt} serverOffset={info.now - overview.dataUpdatedAt} label="距离封盘" />}
            {liveRound && liveRound.status === "scheduled" && <RoundCountdown deadline={liveRound.opensAt} serverOffset={info.now - overview.dataUpdatedAt} label="距离开盘" />}
            {info.acceptingOrders && !user?.onboarded && <p className="text-sm">登录并完成注册后可投注。</p>}
            <p className="text-sm text-muted-foreground">计划开盘（北京时间）：{info.preview.openMinutes.map(hhmm).join("、")} · 开盘后 {info.preview.closeAfterMinutes} 分钟封盘、{info.preview.drawAfterMinutes} 分钟目标开奖。</p>
            <p className="text-sm text-muted-foreground">每场最多 5 组，每组 {money(rules.minStakeUnits)}–{money(rules.maxStakeUnits)} 模拟 USDT；返还倍率含本金。</p>
            <ul className="flex flex-wrap gap-2 text-sm">{rules.multipliers.map((n, hits) => <li className="rounded-lg border border-border px-2.5 py-1" key={hits}>{hits} 中 · {n.toLocaleString("zh-CN")} 倍</li>)}</ul>
          </section>
          <Selection key={liveRound?.id ?? "preview"} items={rules.items} rules={rules} roundId={liveRound?.id} acceptingOrders={info.acceptingOrders && !!user?.onboarded && !!account.data} ordersInRound={ordersInRound} />
        </>}
        <section aria-labelledby="seven-pick-account" className="space-y-2 rounded-2xl border border-border bg-card p-5">
          <h2 id="seven-pick-account" className="text-lg font-bold">共享钱包与我的订单</h2>
          {!user?.onboarded ? <p className="text-sm text-muted-foreground">登录并完成注册后可查看。</p> : account.error ? <p role="alert">订单与余额加载失败。</p> : account.data ? <>
            <p>可用余额：{money(account.data.cashUnits)} 模拟 USDT</p>
            {account.data.orders.length === 0 ? <p className="text-sm text-muted-foreground">暂无订单。</p> : <ul className="space-y-3 text-sm">{account.data.orders.map((order) => <li key={order.id} className="border-t border-border pt-3">
              <p>第 {order.roundId} 场 · {order.bets.length} 组 · 合计 {money(order.totalStakeUnits)} 模拟 USDT</p>
              <ul>{order.bets.map((bet) => <li className="break-words text-muted-foreground" key={bet.id}>物品 {bet.itemIds.join("、")} · 私有回执 <code>{bet.receiptId}</code>{bet.payoutUnits > 0 && <> · 返还 {money(bet.payoutUnits)} 模拟 USDT</>}{bet.refundUnits > 0 && <> · 退款 {money(bet.refundUnits)} 模拟 USDT</>}</li>)}</ul>
            </li>)}</ul>}
          </> : <p role="status">正在加载钱包与订单…</p>}
        </section>
        <section aria-labelledby="seven-pick-history" className="space-y-3 rounded-2xl border border-border bg-card p-5">
          <h2 id="seven-pick-history" className="text-lg font-bold">历史场次与验证</h2>
          <p className="text-sm text-muted-foreground">正式场次的匿名证明将公开每组物品 ID、精确金额和场次内随机标识，不公开账号与精确下注时间。组合与金额仍可能被外部信息关联。</p>
          <div className="flex gap-4 text-sm">
            {beforeOpensAt && <button type="button" className="underline" onClick={() => { setRoundId(null); setHistoryCursors((previous) => previous.slice(0, -1)); }}>较新场次</button>}
            {history.data?.length === 30 && <button type="button" className="underline" onClick={() => {
              const oldest = history.data?.at(-1);
              if (oldest) { setRoundId(null); setHistoryCursors((previous) => [...previous, oldest.opensAt]); }
            }}>更早场次</button>}
          </div>
          {history.error ? <p role="alert">历史场次加载失败。</p> : history.data?.length === 0 ? <p>暂无历史场次。</p> : history.data && <>
            <label className="flex flex-wrap items-center gap-2">查看场次
              <select className="max-w-full rounded-lg border border-border bg-background p-2" value={roundId ?? ""} onChange={(e) => setRoundId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">请选择</option>
                {history.data.map((round) => <option key={round.id} value={round.id}>第 {round.id} 场 · {beijing.format(round.opensAt)} · {statusLabels[round.status] ?? round.status}</option>)}
              </select>
            </label>
            {detail.error && <p role="alert">场次详情加载失败。</p>}
            {detailRound && <div className="space-y-2" aria-live="polite">
              <p>Quicknet 轮次：{detailRound.quicknetRound} · 抽样版本：{detailRound.algorithmVersion}</p>
              {detailRound.lifecycle?.commitmentHex && <p className="break-all text-sm">封盘承诺：<code>{detailRound.lifecycle.commitmentHex}</code></p>}
              {detailRound.lifecycle?.commitmentHex && <p className="text-sm">RFC 3161：{detailRound.timestampUpperBoundMs !== null ? <>封盘摘要在 {beijing.format(detailRound.timestampUpperBoundMs)}（北京时间）前已存在</> : "未附有效时间戳"}</p>}
              {detailRound.lifecycle?.result && <p className="text-sm">开奖号码：{detailRound.lifecycle.result.itemIds.map((id) => detailRound.items.find((item) => item.id === id)?.name ?? id).join("、")}</p>}
              {detailRound.status === "review" && <p className="text-sm">该场正在核查，资金暂未结算。随机数接口故障时只重试原定轮次。</p>}
              {detailRound.lifecycle?.refund && <p className="text-sm">{detailRound.lifecycle.refund.summary} · 已退 {detailRound.lifecycle.refund.refundedBets} / {detailRound.lifecycle.refund.totalBets} 组 · {beijing.format(detailRound.lifecycle.refund.refundedAt ?? detailRound.lifecycle.refund.reviewedAt)}（北京时间）</p>}
              {detailRound.lifecycle?.result && <div className="space-y-2 text-sm">
                <div className="flex flex-wrap gap-4 font-bold text-[#FFB700]">
                  <a className="hover:underline" href={"/api/seven-pick/rounds/" + detailRound.id + "/proof"} download>下载验证包</a>
                  <a className="hover:underline" href="/api/seven-pick/verify.mjs" download>下载 Node.js 验证工具</a>
                </div>
                <p>在 Node.js 20.19+ 中执行 <code>node seven-pick-verify.mjs seven-pick-{detailRound.id}.json</code>。可加 <code>--receipt 回执</code> 核对自己的返还。</p>
              </div>}
            </div>}
          </>}
        </section>
      </main>
    </div>
  );
}
