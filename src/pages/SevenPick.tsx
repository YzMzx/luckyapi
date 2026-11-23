import { useState } from "react";
import { Gem } from "lucide-react";
import { Link } from "react-router";
import { SiteNav } from "@/components/SiteNav";
import { useMe } from "@/hooks/useMe";
import { trpc } from "@/providers/trpc";
import { cn } from "@/lib/utils";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";

const beijing = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const statusLabels: Record<string, string> = {
  scheduled: "待开盘", open: "已开盘", sealed: "已封盘", ots_waiting: "等待时间证明", review: "异常待核查",
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
function Selection({ items }: { items: Items }) {
  const [selected, setSelected] = useState<number[]>([]);
  return (
    <section aria-labelledby="seven-pick-selection" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="seven-pick-selection" className="text-xl font-bold">宝物试选</h2>
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
    </section>
  );
}

export default function SevenPick() {
  const { user } = useMe();
  const overview = trpc.sevenPick.overview.useQuery(undefined, { refetchInterval: 30_000 });
  const history = trpc.sevenPick.history.useQuery();
  const account = trpc.sevenPick.account.useQuery(undefined, { enabled: !!user?.onboarded });
  const [roundId, setRoundId] = useState<number | null>(null);
  const detail = trpc.sevenPick.round.useQuery({ roundId: roundId ?? 0 }, { enabled: roundId !== null });
  const info = overview.data;
  const rules = info?.round ?? info?.preview;
  return (
    <div className="min-h-screen">
      <SiteNav user={user} />
      <main className="mx-auto max-w-6xl space-y-8 px-4 py-10">
        <header className="space-y-3">
          <Link to="/entertainment" className="text-sm text-[#FFB700] hover:underline">← 娱乐中心</Link>
          <p className="text-xs font-bold tracking-[.3em] text-[#af915f]">32 选 7</p>
          <h1 className="text-4xl font-black">七星寻宝</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">从 32 件宝物中任选 7 件，按命中数获得模拟 USDT 返还。当前仅预览和试选，不提交投注或扣款；开启前必须通过独立存证验收。</p>
        </header>
        {overview.isPending && <p role="status">正在加载玩法…</p>}
        {overview.error && <p role="alert">玩法加载失败。<button type="button" onClick={() => void overview.refetch()} className="ml-2 underline">重试</button></p>}
        {info && rules && <>
          <section aria-labelledby="seven-pick-rules" className="space-y-3 rounded-2xl border border-border bg-card p-5">
            <h2 id="seven-pick-rules" className="text-lg font-bold">场次与玩法</h2>
            {info.round ? <p>第 {info.round.id} 场 · {statusLabels[info.round.status] ?? info.round.status} · {beijing.format(info.round.closesAt)} 封盘 · {beijing.format(info.round.drawAt)} 目标开奖（北京时间）</p> : <p>暂无正式场次。</p>}
            <p className="text-sm text-muted-foreground">计划开盘（北京时间）：{info.preview.openMinutes.map(hhmm).join("、")} · 开盘后 {info.preview.closeAfterMinutes} 分钟封盘、{info.preview.drawAfterMinutes} 分钟目标开奖。</p>
            <p className="text-sm text-muted-foreground">每场最多 5 组，每组 {money(rules.minStakeUnits)}–{money(rules.maxStakeUnits)} 模拟 USDT；返还倍率含本金。</p>
            <ul className="flex flex-wrap gap-2 text-sm">{rules.multipliers.map((n, hits) => <li className="rounded-lg border border-border px-2.5 py-1" key={hits}>{hits} 中 · {n.toLocaleString("zh-CN")} 倍</li>)}</ul>
          </section>
          <Selection key={info.round?.id ?? "preview"} items={rules.items} />
        </>}
        <section aria-labelledby="seven-pick-account" className="space-y-2 rounded-2xl border border-border bg-card p-5">
          <h2 id="seven-pick-account" className="text-lg font-bold">共享钱包与我的订单</h2>
          {!user?.onboarded ? <p className="text-sm text-muted-foreground">登录并完成注册后可查看。</p> : account.error ? <p role="alert">订单与余额加载失败。</p> : account.data ? <>
            <p>可用余额：{money(account.data.cashUnits)} 模拟 USDT</p>
            {account.data.orders.length === 0 ? <p className="text-sm text-muted-foreground">暂无订单。</p> : <ul className="space-y-3 text-sm">{account.data.orders.map((order) => <li key={order.id} className="border-t border-border pt-3">
              <p>第 {order.roundId} 场 · {order.bets.length} 组 · 合计 {money(order.totalStakeUnits)} 模拟 USDT</p>
              <ul>{order.bets.map((bet) => <li className="break-words text-muted-foreground" key={bet.id}>物品 {bet.itemIds.join("、")} · 私有回执 <code>{bet.receiptId}</code></li>)}</ul>
            </li>)}</ul>}
          </> : <p role="status">正在加载钱包与订单…</p>}
        </section>
        <section aria-labelledby="seven-pick-history" className="space-y-3 rounded-2xl border border-border bg-card p-5">
          <h2 id="seven-pick-history" className="text-lg font-bold">历史场次与验证</h2>
          <p className="text-sm text-muted-foreground">正式场次的匿名证明将公开每组物品 ID、精确金额和场次内随机标识，不公开账号与精确下注时间。组合与金额仍可能被外部信息关联。当前未发布已验证场次或证明下载。</p>
          {history.error ? <p role="alert">历史场次加载失败。</p> : history.data?.length === 0 ? <p>暂无历史场次。</p> : history.data && <>
            <label className="flex flex-wrap items-center gap-2">查看场次
              <select className="max-w-full rounded-lg border border-border bg-background p-2" value={roundId ?? ""} onChange={(e) => setRoundId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">请选择</option>
                {history.data.map((round) => <option key={round.id} value={round.id}>第 {round.id} 场 · {beijing.format(round.opensAt)} · {statusLabels[round.status] ?? round.status}</option>)}
              </select>
            </label>
            {detail.error && <p role="alert">场次详情加载失败。</p>}
            {detail.data && <p>Quicknet 轮次：{detail.data.quicknetRound} · 抽样版本：{detail.data.algorithmVersion}</p>}
          </>}
        </section>
      </main>
    </div>
  );
}
