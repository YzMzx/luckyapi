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
  const [uploading, setUploading] = useState<number | null>(null);
  const [imageStatus, setImageStatus] = useState<{itemId: number; message: string; error: boolean} | null>(null);
  const save = trpc.admin.sevenPick.save.useMutation({ onSuccess: () => {
    void utils.admin.sevenPick.overview.invalidate();
    void utils.sevenPick.overview.invalidate();
  } });

  function changeItem(itemId: number, patch: Partial<Config["items"][number]>) {
    setForm((prev) => ({ ...prev, items: prev.items.map((item) => item.id === itemId ? { ...item, ...patch } : item) }));
  }

  async function uploadImage(itemId: number, file: File) {
    if (uploading !== null) return;
    setUploading(itemId);
    setImageStatus(null);
    try {
      const body = new FormData();
      body.set("file", file);
      const response = await fetch("/seven-pick-images/upload", { method: "POST", body, credentials: "same-origin" });
      const payload = await response.json().catch(() => null) as {imageUrl?: string; error?: string} | null;
      if (!response.ok || typeof payload?.imageUrl !== "string") throw new Error(payload?.error || "图片上传失败");
      changeItem(itemId, { imageUrl: payload.imageUrl });
      setImageStatus({ itemId, message: "图片已上传，保存版本后使用。", error: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : "图片上传失败";
      setImageStatus({ itemId, message, error: true });
    } finally {
      setUploading(null);
    }
  }

  return <form className="space-y-5" onSubmit={(event) => {
    event.preventDefault();
    if (uploading !== null || save.isPending) return;
    const slots = openTimes.split(/[、,，]/).map((value) => value.trim());
    if (!slots.every((value) => timePattern.test(value))) { setOpenError(true); return; }
    const openMinutes = slots.map((value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3)));
    save.mutate({ expectedVersionId: id, config: { ...form, openMinutes, minStakeUnits: fromUnitsInput(minimum), maxStakeUnits: fromUnitsInput(maximum) } });
  }}>
    <fieldset className="space-y-4 rounded-xl border border-border bg-card p-4">
      <legend className="px-2 font-bold">次日玩法配置与时间</legend>
      <label className="flex items-start gap-2 text-sm"><input className="mt-1 accent-primary" type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />为次日配置开启玩法</label>
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
      <p className="text-sm text-muted-foreground">可上传 JPEG、PNG 或 WebP，单张不超过 2 MiB；也可填写 HTTPS 外链。</p>
      {form.items.map((item) => <fieldset key={item.id} className="grid gap-3 rounded-lg border border-border px-3 pb-3 md:grid-cols-2 xl:grid-cols-4">
        <legend className="px-1 text-sm font-semibold">物品 #{item.id}</legend>
        <label className="space-y-1 text-sm">名称<input className={fieldClass} value={item.name} required onChange={(e) => changeItem(item.id, { name: e.target.value })} /></label>
        <label className="space-y-1 text-sm">描述<input className={fieldClass} value={item.description} onChange={(e) => changeItem(item.id, { description: e.target.value })} /></label>
        <NumberField label="排序" value={item.position} min={1} onChange={(position) => changeItem(item.id, { position })} />
        <div className="space-y-2">
          <label className="block space-y-1 text-sm">图片地址<input inputMode="url" className={fieldClass} disabled={uploading === item.id} value={item.imageUrl ?? ""} onChange={(e) => changeItem(item.id, { imageUrl: e.target.value || null })} /></label>
          <label className="block text-sm">本地图片
            <input type="file" accept="image/jpeg,image/png,image/webp" className="block w-full text-xs" disabled={uploading !== null || save.isPending} onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void uploadImage(item.id, file);
            }} />
          </label>
          {uploading === item.id && <p className="text-xs">上传中…</p>}
          {imageStatus?.itemId === item.id && <p className={imageStatus.error ? "text-xs text-destructive" : "text-xs"} role={imageStatus.error ? "alert" : "status"}>{imageStatus.message}</p>}
        </div>
      </fieldset>)}
    </fieldset>
    {save.error && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">保存失败：{save.error.message}</p>}
    <button type="submit" disabled={save.isPending || uploading !== null} className="admin-primary px-5 py-2 disabled:opacity-50">{save.isPending ? "保存中…" : "保存为次日版本"}</button>
  </form>;
}

function RoundAudit({ rounds }: { rounds: Overview["rounds"] }) {
  const [roundId, setRoundId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const audit = trpc.admin.sevenPick.audit.useQuery({ roundId: roundId ?? 0 }, { enabled: roundId !== null, refetchInterval: 10_000 });
  const utils = trpc.useUtils();
  const approval = trpc.admin.sevenPick.reviewRefund.useMutation({ onSuccess: () => {
    setNotes("");
    void utils.admin.sevenPick.audit.invalidate();
    void utils.admin.sevenPick.overview.invalidate();
  } });
  const lifecycle = audit.data?.lifecycle;
  return <section className="space-y-3 rounded-xl border border-border bg-card p-4">
    <h2 className="font-bold">异常核查与审计</h2>
    {!rounds.length ? <p className="text-sm text-muted-foreground">暂无场次证据。</p> : <label className="block space-y-1 text-sm">查看场次
      <select className={fieldClass} value={roundId ?? ""} onChange={(event) => {
        setRoundId(event.target.value ? Number(event.target.value) : null);
        setNotes("");
        approval.reset();
      }}>
        <option value="">请选择</option>
        {rounds.map((round) => <option key={round.id} value={round.id}>第 {round.id} 场 · {beijing.format(round.opensAt)}</option>)}
      </select>
    </label>}
    {audit.error && <p role="alert" className="text-sm text-destructive">{audit.error.message}</p>}
    {lifecycle && <div className="space-y-3">
      <p className="text-sm">状态 {lifecycle.status}{lifecycle.reviewReasons.length > 0 && <> · {lifecycle.reviewReasons.join("、")}</>}</p>
      {lifecycle.refund && <p className="text-sm">已退 {lifecycle.refund.refundedBets} / {lifecycle.refund.totalBets} 组 · {lifecycle.refund.summary}</p>}
      {lifecycle.status === "review" && lifecycle.reviewReasons.includes("sealed_after_beacon") && roundId !== null && <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault();
        if (notes.trim() && !approval.isPending) approval.mutate({ roundId, reason: "seal_missed", notes });
      }}>
        <fieldset className="space-y-3" disabled={approval.isPending}>
          <legend className="text-sm font-semibold">退款核查</legend>
          <p className="text-sm">系统检测到封盘晚于或等于固定 Quicknet 轮次，符合取消并原额退款的条件。</p>
          <label className="block text-sm">核查理由（管理员可见）<textarea className={fieldClass} value={notes} maxLength={1000} required onChange={(event) => setNotes(event.target.value)} /></label>
          <button type="submit" className="admin-primary px-4 py-2" disabled={!notes.trim()}>提交退款核查</button>
        </fieldset>
        {approval.error && <p role="alert" className="text-sm text-destructive">{approval.error.message}</p>}
      </form>}
      {audit.data?.entries.length ? <ul className="space-y-2 text-sm">{audit.data.entries.map((entry) => <li key={entry.id}>
        <details className="rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer">{beijing.format(entry.createdAt)} · {entry.kind}</summary>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(entry.details, null, 2)}</pre>
        </details>
      </li>)}</ul> : <p className="text-sm text-muted-foreground">暂无审计条目。</p>}
    </div>}
  </section>;
}

function RuntimeControls({ runtime }: { runtime: Overview["runtime"] }) {
  const utils = trpc.useUtils();
  const pauseHint = useId();
  const tsaHint = useId();
  const update = trpc.admin.sevenPick.setRuntime.useMutation({
    onSuccess: (next) => {
      utils.admin.sevenPick.overview.setData(undefined, (current) => current && { ...current, runtime: next });
      void utils.admin.sevenPick.overview.invalidate();
      void utils.sevenPick.overview.invalidate();
    },
  });
  // In browsers without native switch rendering this is still a labelled checkbox.
  const switchAttribute = { switch: "" };
  const control = "size-5 shrink-0 cursor-pointer accent-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary disabled:cursor-wait";
  return <fieldset className="space-y-3 rounded-xl border border-border bg-card p-4" disabled={update.isPending}>
    <legend className="px-2 font-bold">运行开关（即时生效）</legend>
    <div className="space-y-1 rounded-lg border border-border p-3">
      <label className="flex cursor-pointer items-center justify-between gap-3 text-sm font-semibold">
        <span>暂停接收新投注</span>
        <input type="checkbox" {...switchAttribute} className={control} checked={runtime.paused} aria-describedby={pauseHint}
          onChange={(event) => update.mutate({ key: "paused", value: event.currentTarget.checked })} />
      </label>
      <p id={pauseHint} className="text-xs text-muted-foreground">开启后不再开新场或接收新投注；已接受的投注照常开奖和结算。</p>
    </div>
    <div className="space-y-1 rounded-lg border border-border p-3">
      <label className="flex cursor-pointer items-center justify-between gap-3 text-sm font-semibold">
        <span>启用 RFC 3161 封盘时间凭证</span>
        <input type="checkbox" {...switchAttribute} className={control} checked={runtime.rfc3161Enabled} aria-describedby={tsaHint}
          onChange={(event) => update.mutate({ key: "rfc3161Enabled", value: event.currentTarget.checked })} />
      </label>
      <p id={tsaHint} className="text-xs text-muted-foreground">仅向公开时间戳服务提交摘要。关闭或未取得凭证不影响开奖和派奖。</p>
    </div>
    {update.error && <p role="alert" className="text-sm text-destructive">保存失败：{update.error.message}</p>}
    <p role="status" className="text-xs text-muted-foreground">{update.isSuccess ? "运行开关已保存。" : ""}</p>
  </fieldset>;
}

export default function AdminSevenPick() {
  const overview = trpc.admin.sevenPick.overview.useQuery();
  if (overview.isPending) return <p role="status">加载七星寻宝配置…</p>;
  if (overview.error) return <p role="alert">加载失败：{overview.error.message} <button type="button" className="underline" onClick={() => void overview.refetch()}>重试</button></p>;
  const { active, latest, rounds, versions, runtime } = overview.data;
  return <div className="max-w-[90rem] space-y-5">
    <section className="space-y-2 rounded-xl border border-border bg-card p-4">
      <h2 className="font-bold">运行状态：{runtime.paused ? "已暂停接单" : active.enabled ? "已启用，按场次开放" : "当前生效配置未启用"}</h2>
      <p className="text-sm text-muted-foreground">下方规则配置按北京时间次日生效，已创建场次不受影响。</p>
      <p className="text-sm">当前生效：{active.id === null ? "默认规则" : "版本 #" + active.id} · 最新版本：{latest.id === null ? "默认规则" : "#" + latest.id + "，" + beijing.format(latest.effectiveAt)}</p>
    </section>
    <RuntimeControls runtime={runtime} />
    <ConfigForm key={latest.id ?? "default"} latest={latest} />
    <section className="space-y-2 rounded-xl border border-border bg-card p-4">
      <h2 className="font-bold">近期配置版本</h2>
      {versions.length ? <ul className="space-y-2 text-sm">{versions.map((version) => <li key={version.id}>#{version.id} · {version.enabled ? "启用" : "停用"} · {beijing.format(version.effectiveAt)} 生效（北京时间）</li>)}</ul> : <p className="text-sm text-muted-foreground">暂无自定义版本。</p>}
    </section>
    <section className="space-y-2 rounded-xl border border-border bg-card p-4">
      <h2 className="font-bold">场次风控</h2>
      {rounds.length ? <ul className="space-y-2 text-sm">{rounds.map((round) => <li key={round.id}>第 {round.id} 场 · {round.status} · 最大潜在返还 / 风控上限：{round.maxExposureUnits ?? "—"} / {round.riskLimitUnits ?? "—"} milli-USDT</li>)}</ul> : <p className="text-sm text-muted-foreground">暂无正式场次。</p>}
    </section>
    <RoundAudit rounds={rounds} />
  </div>;
}
