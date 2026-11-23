import { useId, useState } from "react";
import { trpc } from "@/providers/trpc";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../api/router";

type Overview = inferRouterOutputs<AppRouter>["admin"]["sevenPick"]["overview"];
type Config = inferRouterInputs<AppRouter>["admin"]["sevenPick"]["save"]["config"];
const beijing = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short",
});
const fieldClass = "block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";
const timeText = (n: number) => [Math.floor(n / 60), n % 60].map((x) => String(x).padStart(2, "0")).join(":");
const timePattern = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const unitsText = (n: number) => (n / 1000).toString();
function fromUnitsInput(value: string) {
  if (!/^\d{1,3}(?:\.\d{1,3})?$/.test(value)) return NaN;
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
}
function NumberField({ label, value, min, onChange }: { label: string; value: number; min: number; onChange: (n: number) => void }) {
  return <label className="space-y-1 text-sm"><span>{label}</span><input className={fieldClass} type="number" min={min} step={1} required value={Number.isNaN(value) ? "" : value} onChange={(e) => onChange(e.target.valueAsNumber)} /></label>;
}

function ConfigForm({ latest }: { latest: Overview["latest"] }) {
  const { id, enabled, closeAfterMinutes, drawAfterMinutes, multipliers, items } = latest;
  const utils = trpc.useUtils();
  const openId = useId();
  const errorId = useId();
  const [form, setForm] = useState({ enabled, closeAfterMinutes, drawAfterMinutes, multipliers, items });
  const [openTimes, setOpenTimes] = useState(latest.openMinutes.map(timeText).join("、"));
  const [minimum, setMinimum] = useState(unitsText(latest.minStakeUnits));
  const [maximum, setMaximum] = useState(unitsText(latest.maxStakeUnits));
  const [openError, setOpenError] = useState(false);
  const save = trpc.admin.sevenPick.save.useMutation({ onSuccess: () => {
    void utils.admin.sevenPick.overview.invalidate();
    void utils.sevenPick.overview.invalidate();
  } });

  function changeItem(itemId: number, patch: Partial<Config["items"][number]>) {
    setForm((prev) => ({ ...prev, items: prev.items.map((item) => item.id === itemId ? { ...item, ...patch } : item) }));
  }

  return <form className="space-y-5" onSubmit={(event) => {
    event.preventDefault();
    const slots = openTimes.split(/[、,，]/).map((value) => value.trim());
    if (!slots.every((value) => timePattern.test(value))) { setOpenError(true); return; }
    const openMinutes = slots.map((value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3)));
    save.mutate({ expectedVersionId: id, config: { ...form, openMinutes, minStakeUnits: fromUnitsInput(minimum), maxStakeUnits: fromUnitsInput(maximum) } });
  }}>
    <fieldset className="space-y-4 rounded-xl border border-border bg-card p-4">
      <legend className="px-2 font-bold">开关与时间</legend>
      <label className="flex items-start gap-2 text-sm"><input className="mt-1 accent-primary" type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />为次日配置开启玩法（不会解除存证上线限制）</label>
      <div className="space-y-1">
        <label htmlFor={openId} className="text-sm">开盘时间（北京时间，多个时刻用顿号或逗号分隔）</label>
        <input id={openId} className={fieldClass} required value={openTimes} aria-invalid={openError || undefined} aria-describedby={openError ? errorId : undefined} onChange={(e) => { setOpenTimes(e.target.value); setOpenError(false); }} />
        <p id={errorId} role="status" className="text-sm text-destructive">{openError ? "请用 24 小时制 HH:MM，例如 13:00、14:00。" : ""}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <NumberField label="开盘到封盘（分钟）" min={1} value={form.closeAfterMinutes} onChange={(closeAfterMinutes) => setForm({ ...form, closeAfterMinutes })} />
        <NumberField label="开盘到目标开奖（分钟）" min={2} value={form.drawAfterMinutes} onChange={(drawAfterMinutes) => setForm({ ...form, drawAfterMinutes })} />
      </div>
    </fieldset>
    <fieldset className="space-y-4 rounded-xl border border-border bg-card p-4">
      <legend className="px-2 font-bold">限额与赔率</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">每组最低（模拟 USDT）<input className={fieldClass} inputMode="decimal" pattern="[0-9]{1,3}([.][0-9]{1,3})?" required value={minimum} onChange={(e) => setMinimum(e.target.value)} /></label>
        <label className="space-y-1 text-sm">每组最高（模拟 USDT）<input className={fieldClass} inputMode="decimal" pattern="[0-9]{1,3}([.][0-9]{1,3})?" required value={maximum} onChange={(e) => setMaximum(e.target.value)} /></label>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        {form.multipliers.map((n, hits) => <NumberField key={hits} label={hits + " 中倍率"} min={0} value={n} onChange={(multiplier) => setForm((prev) => ({ ...prev, multipliers: prev.multipliers.map((m, i) => i === hits ? multiplier : m) }))} />)}
      </div>
    </fieldset>
    <fieldset className="space-y-4 rounded-xl border border-border bg-card p-4">
      <legend className="px-2 font-bold">32 件宝物</legend>
      <p className="text-sm text-muted-foreground">图片外链仅支持 HTTPS；玩家浏览器直接加载，服务器不会抓取外链。尚不支持上传。</p>
      {form.items.map((item) => <fieldset key={item.id} className="grid gap-3 rounded-lg border border-border px-3 pb-3 md:grid-cols-2 xl:grid-cols-4">
        <legend className="px-1 text-sm font-semibold">物品 #{item.id}</legend>
        <label className="space-y-1 text-sm">名称<input className={fieldClass} value={item.name} required onChange={(e) => changeItem(item.id, { name: e.target.value })} /></label>
        <label className="space-y-1 text-sm">描述<input className={fieldClass} value={item.description} onChange={(e) => changeItem(item.id, { description: e.target.value })} /></label>
        <NumberField label="排序" value={item.position} min={1} onChange={(position) => changeItem(item.id, { position })} />
        <label className="space-y-1 text-sm">HTTPS 图片地址<input inputMode="url" className={fieldClass} value={item.imageUrl ?? ""} onChange={(e) => changeItem(item.id, { imageUrl: e.target.value || null })} /></label>
      </fieldset>)}
    </fieldset>
    {save.error && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">保存失败：{save.error.message}</p>}
    <button type="submit" disabled={save.isPending} className="admin-primary px-5 py-2 disabled:opacity-50">{save.isPending ? "保存中…" : "保存为次日版本"}</button>
  </form>;
}

export default function AdminSevenPick() {
  const overview = trpc.admin.sevenPick.overview.useQuery();
  if (overview.isPending) return <p role="status">加载七星寻宝配置…</p>;
  if (overview.error) return <p role="alert">加载失败：{overview.error.message} <button type="button" className="underline" onClick={() => void overview.refetch()}>重试</button></p>;
  const { active, latest, rounds, versions } = overview.data;
  return <div className="max-w-[90rem] space-y-5">
    <section className="space-y-2 rounded-xl border border-border bg-card p-4">
      <h2 className="font-bold">上线状态：仅预览</h2>
      <p className="text-sm text-muted-foreground">尚未取得符合要求的独立封盘存证，不会接收投注。配置按北京时间次日生效，已创建场次不受影响。</p>
      <p className="text-sm">当前生效：{active.id === null ? "默认规则" : "版本 #" + active.id} · 最新版本：{latest.id === null ? "默认规则" : "#" + latest.id + "，" + beijing.format(latest.effectiveAt)}</p>
    </section>
    <ConfigForm key={latest.id ?? "default"} latest={latest} />
    <section className="space-y-2 rounded-xl border border-border bg-card p-4">
      <h2 className="font-bold">近期配置版本</h2>
      {versions.length ? <ul className="space-y-2 text-sm">{versions.map((version) => <li key={version.id}>#{version.id} · {version.enabled ? "启用" : "停用"} · {beijing.format(version.effectiveAt)} 生效（北京时间）</li>)}</ul> : <p className="text-sm text-muted-foreground">暂无自定义版本。</p>}
    </section>
    <section className="space-y-2 rounded-xl border border-border bg-card p-4">
      <h2 className="font-bold">场次风控</h2>
      {rounds.length ? <ul className="space-y-2 text-sm">{rounds.map((round) => <li key={round.id}>第 {round.id} 场 · {round.status} · 最大潜在返还 / 风控上限：{round.maxExposureUnits ?? "—"} / {round.riskLimitUnits ?? "—"} milli-USDT</li>)}</ul> : <p className="text-sm text-muted-foreground">暂无正式场次。</p>}
    </section>
  </div>;
}
