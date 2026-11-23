import { useId, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { trpc } from "@/providers/trpc";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../api/router";

type Overview = inferRouterOutputs<AppRouter>["admin"]["sevenPick"]["overview"];
type Config = inferRouterInputs<AppRouter>["admin"]["sevenPick"]["save"]["config"];
type ActiveConfig = Overview["active"];
type ActivateRuleInput = inferRouterInputs<AppRouter>["admin"]["sevenPick"]["activateRule"];
const roundStatus: Record<Overview["rounds"][number]["status"], string> = {
  scheduled: "待开盘", open: "已开盘", sealed: "已封盘", ots_waiting: "等待开奖",
  review: "异常待核查", risk_skipped: "风控跳过", settled: "已结算", refunding: "退款中", refunded: "已退款",
};
const beijing = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short", hourCycle: "h23",
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

function BeijingTime({ timestamp }: { timestamp: number }) {
  return <time dateTime={new Date(timestamp).toISOString()}>{beijing.format(timestamp)}</time>;
}

function Setting({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="whitespace-pre-wrap break-words font-medium">{children}</dd>
  </div>;
}

function ActiveRules({ active }: { active: ActiveConfig }) {
  const headingId = useId();
  return <section aria-labelledby={headingId} className="space-y-4 rounded-xl border border-border bg-card p-4">
    <h2 id={headingId} className="font-bold">当前已启用规则（只读）</h2>
    {!active.enabled ? <p className="text-sm text-muted-foreground">当前没有已启用的规则。{active.id !== null && <>生效版本 #{active.id} 的规则为停用状态，可在「其他规则」中选择启用。</>}</p> : <>
    <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <Setting label="当前版本">{active.id === null ? "系统默认规则" : "#" + active.id}</Setting>
      <Setting label="配置启用状态">{active.enabled ? "已启用" : "未启用"}</Setting>
      <Setting label="生效时间（北京时间）">{active.id === null ? "无自定义生效时间" : <BeijingTime timestamp={active.effectiveAt} />}</Setting>
      <Setting label="创建时间（北京时间）">{active.id === null ? "无自定义创建时间" : <BeijingTime timestamp={active.createdAt} />}</Setting>
    </dl>
    <h3 className="text-sm font-semibold">排期与投注限额</h3>
    <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <Setting label="每日自动开盘（北京时间）">{active.openMinutes.map(timeText).join("、")}</Setting>
      <Setting label="开盘到封盘">{active.closeAfterMinutes} 分钟</Setting>
      <Setting label="开盘到目标开奖">{active.drawAfterMinutes} 分钟</Setting>
      <Setting label="每组限额（模拟 USDT）">最低 {unitsText(active.minStakeUnits)} · 最高 {unitsText(active.maxStakeUnits)}</Setting>
    </dl>
    <h3 className="text-sm font-semibold">命中返还倍率（含本金）</h3>
    <dl className="grid grid-cols-4 gap-3 text-sm sm:grid-cols-8">
      {active.multipliers.map((multiplier, hits) => <Setting key={hits} label={hits + " 中"}>{multiplier.toLocaleString("zh-CN")}×</Setting>)}
    </dl>
    <details className="rounded-lg border border-border px-3 py-2">
      <summary className="cursor-pointer py-1 text-sm font-semibold">查看生效宝物（{active.items.length} 件）</summary>
      <ul role="list" className="mt-2 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
        {active.items.map((item) => <li key={item.id} className="min-w-0 rounded-lg border border-border p-3">
          <p className="mb-2 break-words font-semibold">#{item.id} · {item.name}</p>
          <dl className="space-y-2">
            <Setting label="排序">{item.position}</Setting>
            <Setting label="描述">{item.description || "—"}</Setting>
            <Setting label="图片地址">{item.imageUrl || "—"}</Setting>
          </dl>
        </li>)}
      </ul>
    </details>
    </>}
  </section>;
}

function RuleVersions({ active, latest, upcoming, versions, paused, block }: Pick<Overview, "active" | "latest" | "upcoming" | "versions"> & { paused: boolean; block: string | null }) {
  const utils = trpc.useUtils();
  const headingId = useId();
  const blockId = useId();
  const dialogTitleId = useId();
  const summaryId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [cursors, setCursors] = useState<number[]>([]);
  const [review, setReview] = useState<ActivateRuleInput | null>(null);
  const beforeId = cursors.at(-1);
  const page = trpc.admin.sevenPick.ruleVersions.useQuery(beforeId === undefined ? undefined : { beforeId }, { refetchInterval: 15_000 });
  const activate = trpc.admin.sevenPick.activateRule.useMutation({
    retry: false,
    onSettled: async () => {
      await Promise.all([
        utils.admin.sevenPick.overview.invalidate(),
        utils.admin.sevenPick.ruleVersions.invalidate(),
        utils.sevenPick.overview.invalidate(),
      ]);
    },
  });
  const currentEnabledId = active.enabled ? active.id : null;
  const otherRules = (page.data?.items ?? (beforeId === undefined ? versions : [])).filter((rule) => rule.id !== currentEnabledId);
  const nextBeforeId = page.data?.nextBeforeId ?? null;
  const activationBlock = block ?? (page.error ? "请先刷新规则列表再启用。" : null);
  const confirmBlock = review && (review.expectedActiveVersionId !== active.id || review.expectedVersionId !== latest.id)
    ? "生效规则或最新保存版本已变更，请取消后重新确认。"
    : activationBlock;
  return <section aria-labelledby={headingId} className="space-y-3 rounded-xl border border-border bg-card p-4">
    <h2 id={headingId} className="font-bold">其他规则</h2>
    <p className="text-sm text-muted-foreground">可选择任意已保存的其他版本立即启用，包括原本停用的版本。</p>
    {activationBlock && <p id={blockId} className="text-sm text-destructive">暂不可立即启用：{activationBlock}</p>}
    {page.error && <p role="alert" className="text-sm text-destructive">加载规则列表失败：{page.error.message}{" "}
      <button type="button" className="underline" onClick={() => void page.refetch()}>重试加载规则</button>
    </p>}
    {otherRules.length ? <ul role="list" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {otherRules.map((rule) => <li key={rule.id} className="min-w-0 space-y-2 rounded-lg border border-border p-3 text-sm">
        <h3 className="font-semibold">版本 #{rule.id}{rule.canceledAt !== null ? " · 排期已取消" : rule.id === upcoming?.id ? " · 下次排期" : rule.id === active.id ? " · 当前停用" : ""}</h3>
        <dl className="grid gap-2 sm:grid-cols-2">
          <Setting label="保存时的状态">{rule.enabled ? "启用" : "停用"}</Setting>
          <Setting label={rule.canceledAt === null ? "生效时间（北京时间）" : "原定生效时间（北京时间）"}><BeijingTime timestamp={rule.effectiveAt} /></Setting>
          <Setting label="自动开盘（北京时间）">{rule.openMinutes.map(timeText).join("、")}</Setting>
          <Setting label="开盘后封盘 / 目标开奖">{rule.closeAfterMinutes} / {rule.drawAfterMinutes} 分钟</Setting>
          <Setting label="每组限额（模拟 USDT）">{unitsText(rule.minStakeUnits)}–{unitsText(rule.maxStakeUnits)}</Setting>
        </dl>
        <button type="button" aria-label={"立即启用版本 #" + rule.id} aria-haspopup="dialog"
          aria-disabled={Boolean(activationBlock) || activate.isPending} aria-describedby={activationBlock ? blockId : undefined}
          className="admin-secondary px-4 py-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          onClick={() => {
            const modal = dialog.current;
            if (activationBlock || activate.isPending || !modal || modal.open) return;
            // Render the selected snapshot and lock IDs before native focus announces the dialog.
            flushSync(() => setReview({ versionId: rule.id, expectedActiveVersionId: active.id, expectedVersionId: latest.id }));
            // React only calls focus at mount for autoFocus on client-rendered buttons.
            if (cancelButton.current) cancelButton.current.autofocus = true;
            modal.showModal();
          }}>立即启用</button>
      </li>)}
    </ul> : page.isPending ? <p role="status" className="text-sm text-muted-foreground">加载规则列表…</p>
      : !page.error && <p className="text-sm text-muted-foreground">本页没有其他已保存的规则。</p>}
    {(beforeId !== undefined || nextBeforeId !== null) && <nav aria-label="规则版本分页" className="flex flex-wrap items-center gap-3 text-sm">
      <button type="button" className="admin-secondary px-3 py-2 disabled:opacity-50" disabled={beforeId === undefined}
        onClick={() => setCursors((prev) => prev.slice(0, -1))}>较新一页</button>
      <span role="status">第 {cursors.length + 1} 页</span>
      <button type="button" className="admin-secondary px-3 py-2 disabled:opacity-50" disabled={nextBeforeId === null}
        onClick={() => { if (nextBeforeId !== null) setCursors((prev) => [...prev, nextBeforeId]); }}>较旧一页</button>
    </nav>}
    <dialog ref={dialog} aria-labelledby={dialogTitleId} aria-describedby={summaryId}
      className="m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-xl border border-border bg-card p-5 text-card-foreground [&:modal]:overscroll-contain backdrop:bg-black/60 backdrop:overflow-hidden backdrop:overscroll-contain">
      <h3 id={dialogTitleId} className="mb-2 text-lg font-bold">确认立即启用{review ? "版本 #" + review.versionId : "规则"}？</h3>
      <div id={summaryId} className="space-y-2 text-sm">
        <p>系统将复制所选规则，创建一个立即生效的已启用版本，即使原版本为停用状态。不会修改已保存版本的规则内容，也不会影响已创建的场次。</p>
        <p className="font-semibold">{upcoming ? <>此操作会取消已安排的规则变更，包括版本 #{upcoming.id} 原定于 <BeijingTime timestamp={upcoming.effectiveAt} />（北京时间）的排期。已取消的版本仍会保留，可再次选择启用。</>
          : "当前没有待生效的规则排期。"} 若不重新安排，明日起仍沿用本次启用的规则。</p>
        <p>此操作不会自动开场、解除暂停接单或绕过维护限制。{paused && "当前已暂停接单，启用规则后仍会保持暂停。"}</p>
      </div>
      <p role="status" className="mt-2 text-sm text-destructive">{review && confirmBlock}</p>
      <form method="dialog" className="mt-4 flex flex-wrap justify-end gap-2">
        <button ref={cancelButton} type="submit" autoFocus className="admin-secondary px-4 py-2 text-sm">取消</button>
        <button type="button" disabled={!review || Boolean(confirmBlock) || activate.isPending} className="admin-primary px-4 py-2 disabled:opacity-50"
          onClick={() => {
            if (!dialog.current?.open || !review || confirmBlock || activate.isPending) return;
            dialog.current.close();
            activate.mutate(review);
          }}>确认立即启用</button>
      </form>
    </dialog>
    <p role="status" className="text-sm">
      {activate.isPending ? "正在启用并刷新规则…" : activate.data ? "已创建并启用新版本 #" + activate.data.id + "。之前的规则排期已清除；若不重新安排，明日起仍沿用此版本。" : ""}
    </p>
    <p role="alert" className="break-words text-sm text-destructive">{activate.error && (activate.error.data
      ? "立即启用失败：" + activate.error.message
      : "未能确认启用结果，请查看当前规则后再试。错误详情：" + activate.error.message)}</p>
  </section>;
}

function ManualRound({ active, block }: { active: ActiveConfig; block: string | null }) {
  const utils = trpc.useUtils();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const summaryId = useId();
  const availabilityId = useId();
  const [confirmedConfig, setConfirmedConfig] = useState<ActiveConfig | null>(null);
  const start = trpc.admin.sevenPick.startManualRound.useMutation({
    retry: false,
    onSettled: async () => {
      await Promise.all([
        utils.admin.sevenPick.overview.invalidate(),
        utils.sevenPick.overview.invalidate(),
        utils.sevenPick.history.invalidate(),
      ]);
    },
  });
  const confirmBlock = confirmedConfig?.id !== active.id
    ? "当前生效配置已变更，请取消后重新确认。"
    : block;
  const result = start.data;
  const errorText = start.error && (start.error.data
    ? "开启场次失败：" + start.error.message
    : "未能确认开场结果，请先查看场次记录再重试。错误详情：" + start.error.message);
  return <section className="space-y-2 rounded-xl border border-border bg-card p-4">
    <h2 className="font-bold">手动开场</h2>
    <p className="text-sm text-muted-foreground">用当前生效配置立即尝试开启一场，不修改自动排期，也不会提前启用次日版本。</p>
    <p id={availabilityId} className="text-sm">{start.isPending ? "正在提交并刷新场次状态。" : block ? "暂不可开启：" + block : "当前可手动开场，开盘仍需通过风控检查。"}</p>
    <button type="button" aria-haspopup="dialog" aria-describedby={availabilityId} aria-disabled={Boolean(block) || start.isPending}
      className="admin-primary px-5 py-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
      onClick={() => {
        const modal = dialog.current;
        if (block || active.id === null || start.isPending || !modal || modal.open) return;
        // Put the reviewed version in the DOM before native modal focus announces it.
        flushSync(() => setConfirmedConfig(active));
        modal.showModal();
      }}>{start.isPending ? "正在开启场次…" : "开启场次"}</button>
    <dialog ref={dialog} aria-labelledby={titleId} aria-describedby={summaryId}
      className="m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-xl border border-border bg-card p-5 text-card-foreground [&:modal]:overscroll-contain backdrop:bg-black/60 backdrop:overflow-hidden backdrop:overscroll-contain">
      <h3 id={titleId} className="mb-2 text-lg font-bold">确认立即开启场次？</h3>
      <p id={summaryId} className="text-sm">将使用当前生效的版本 #{confirmedConfig?.id}，通过风控后立即对用户开放投注。待生效版本不会用于本场。</p>
      {confirmedConfig && <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <Setting label="版本生效（北京时间）"><BeijingTime timestamp={confirmedConfig.effectiveAt} /></Setting>
        <Setting label="每组限额（模拟 USDT）">{unitsText(confirmedConfig.minStakeUnits)}–{unitsText(confirmedConfig.maxStakeUnits)}</Setting>
        <Setting label="开盘到封盘">{confirmedConfig.closeAfterMinutes} 分钟</Setting>
        <Setting label="开盘到目标开奖">{confirmedConfig.drawAfterMinutes} 分钟</Setting>
      </dl>}
      <p role="status" className="mt-2 text-sm text-destructive">{confirmedConfig && confirmBlock}</p>
      <form method="dialog" className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="submit" autoFocus className="admin-secondary px-4 py-2 text-sm">取消</button>
        <button type="button" disabled={Boolean(confirmBlock) || start.isPending} className="admin-primary px-4 py-2 disabled:opacity-50"
          onClick={() => {
            if (!dialog.current?.open || !confirmedConfig || confirmedConfig.id === null || confirmBlock || start.isPending) return;
            dialog.current.close();
            start.mutate({ expectedVersionId: confirmedConfig.id });
          }}>确认开启</button>
      </form>
    </dialog>
    <div className="break-words text-sm">
      <div role="status">
        {result?.status === "risk_skipped" ? <p className="font-semibold text-destructive">第 {result.id} 场因风控跳过，未开放投注。</p>
          : result?.status === "open" ? <p className="font-semibold">第 {result.id} 场已开盘，<BeijingTime timestamp={result.closesAt} /> 封盘（北京时间）。</p>
          : result ? <p>已创建第 {result.id} 场，当前状态：{roundStatus[result.status]}。</p> : null}
      </div>
      <p role="alert" className="text-destructive">{errorText}</p>
    </div>
  </section>;
}

function ConfigForm({ template, expectedVersionId, headingId }: { template: ActiveConfig; expectedVersionId: number | null; headingId: string }) {
  const { enabled, closeAfterMinutes, drawAfterMinutes, multipliers, items } = template;
  const utils = trpc.useUtils();
  const choiceId = useId();
  const openId = useId();
  const errorId = useId();
  const [form, setForm] = useState({ enabled, closeAfterMinutes, drawAfterMinutes, multipliers, items });
  const [openTimes, setOpenTimes] = useState(template.openMinutes.map(timeText).join("、"));
  const [minimum, setMinimum] = useState(unitsText(template.minStakeUnits));
  const [maximum, setMaximum] = useState(unitsText(template.maxStakeUnits));
  const [openError, setOpenError] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const [imageStatus, setImageStatus] = useState<{itemId: number; message: string; error: boolean} | null>(null);
  const save = trpc.admin.sevenPick.save.useMutation({ onSuccess: async () => {
    await Promise.all([
      utils.admin.sevenPick.overview.invalidate(),
      utils.admin.sevenPick.ruleVersions.invalidate(),
      utils.sevenPick.overview.invalidate(),
    ]);
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

  return <form aria-labelledby={headingId} className="space-y-5" onSubmit={(event) => {
    event.preventDefault();
    if (uploading !== null || save.isPending) return;
    const slots = openTimes.split(/[、,，]/).map((value) => value.trim());
    if (!slots.every((value) => timePattern.test(value))) { setOpenError(true); return; }
    const openMinutes = slots.map((value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3)));
    save.mutate({ expectedVersionId, config: { ...form, openMinutes, minStakeUnits: fromUnitsInput(minimum), maxStakeUnits: fromUnitsInput(maximum) } });
  }}>
    <fieldset className="space-y-2 rounded-xl border border-border bg-card p-4" aria-describedby={choiceId + "-hint"}>
      <legend className="px-2 font-bold">这条规则的启用状态</legend>
      <p id={choiceId + "-hint"} className="text-sm text-muted-foreground">选择这条规则在排期生效时的状态，不会立即更改当前规则或运行开关。</p>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {([true, false] as const).map((enabled) => {
          const id = choiceId + (enabled ? "-enabled" : "-disabled");
          return <div key={id} className="flex items-center gap-2">
            <input type="radio" id={id} name={choiceId} value={String(enabled)} checked={form.enabled === enabled}
              onChange={() => setForm((prev) => ({ ...prev, enabled }))} />
            <label htmlFor={id} className="cursor-pointer py-1">{enabled ? "启用" : "停用"}</label>
          </div>;
        })}
      </div>
    </fieldset>
    <fieldset className="space-y-4 rounded-xl border border-border bg-card p-4">
      <legend className="px-2 font-bold">开盘与开奖时间</legend>
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
    <button type="submit" disabled={save.isPending || uploading !== null} className="admin-primary px-5 py-2 disabled:opacity-50">{save.isPending ? "保存中…" : "保存并安排明日 00:00 生效"}</button>
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
  const scheduleHeadingId = useId();
  const overview = trpc.admin.sevenPick.overview.useQuery(undefined, { refetchInterval: 15_000 });
  if (overview.isPending) return <p role="status">加载七星寻宝配置…</p>;
  const refreshError = overview.error && <p role="alert" className="text-sm text-destructive">
    {overview.data ? "刷新失败，当前显示上次加载的配置：" : "加载失败："}{overview.error.message}{" "}
    <button type="button" className="underline" onClick={() => void overview.refetch()}>重试</button>
  </p>;
  if (!overview.data) return refreshError;
  const { active, latest, upcoming, rounds, versions, runtime, manualStartBlock, activationBlocked } = overview.data;
  const template = upcoming ?? active;
  const block = overview.error ? "请先刷新，确认当前生效配置与场次状态。"
    : manualStartBlock ?? (runtime.paused ? "已暂停接单" : active.id === null || !active.enabled ? "当前没有已启用的生效版本" : null);
  return <div className="max-w-[90rem] space-y-5">
    <section className="space-y-2 rounded-xl border border-border bg-card p-4">
      <h2 className="font-bold">运行状态：{runtime.paused ? "已暂停接单" : active.enabled ? "已启用，按场次开放" : "当前生效配置未启用"}</h2>
      {refreshError}
    </section>
    <ActiveRules active={active} />
    <RuleVersions active={active} latest={latest} upcoming={upcoming} versions={versions} paused={runtime.paused}
      block={overview.error ? "请先刷新，确认当前规则与排期。" : activationBlocked} />
    <ManualRound active={active} block={block} />
    <RuntimeControls runtime={runtime} />
    <section className="space-y-3">
      <div className="space-y-2 rounded-xl border border-border bg-card p-4">
        <h2 id={scheduleHeadingId} className="font-bold">编辑并安排次日规则</h2>
        <p className="text-sm text-muted-foreground">保存后于北京时间明日 00:00 生效，不会改变当前规则或已创建场次。</p>
        <p className="text-sm">{upcoming
          ? <>下次排期：版本 #{upcoming.id} · {upcoming.enabled ? "启用" : "停用"} · <BeijingTime timestamp={upcoming.effectiveAt} /> 生效（北京时间）。表单以该规则为编辑起点。</>
          : "没有待生效的排期；若不另行安排，明日起仍沿用当前规则。表单以当前生效规则为编辑起点。"}</p>
      </div>
      <ConfigForm key={(template.id ?? "default") + ":" + (latest.id ?? "default")} template={template} expectedVersionId={latest.id} headingId={scheduleHeadingId} />
    </section>
    <section className="space-y-2 rounded-xl border border-border bg-card p-4">
      <h2 className="font-bold">场次风控</h2>
      {rounds.length ? <ul className="space-y-2 text-sm">{rounds.map((round) => <li key={round.id}>第 {round.id} 场 · {roundStatus[round.status]} · 最大潜在返还 / 风控上限：{round.maxExposureUnits ?? "—"} / {round.riskLimitUnits ?? "—"} milli-USDT</li>)}</ul> : <p className="text-sm text-muted-foreground">暂无正式场次。</p>}
    </section>
    <RoundAudit rounds={rounds} />
  </div>;
}
