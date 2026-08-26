import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pager } from "@/components/Pager";
import {
  DEFAULT_SLOT_RULES,
  formatMultiplier,
  formatProbabilityPercent,
  moneyUnitsToDollars,
  multiplierToBasisPoints,
  probabilityPercentToPpm,
  SLOT_MULTIPLIER_SCALE,
  SLOT_PROBABILITY_SCALE,
  SLOT_SYMBOL_DEFINITIONS,
} from "@contracts/slot-machine";

type SlotDraft = {
  name: string;
  mode: "base" | "promotion";
  minBet: string;
  maxBet: string;
  tiers: Array<{
    id: string;
    symbol: "cherry" | "lemon" | "bell" | "diamond" | "seven";
    name: string;
    probabilityPercent: string;
    multiplier: string;
  }>;
};

const initialSlotDraft: SlotDraft = {
  name: DEFAULT_SLOT_RULES.name,
  mode: "base",
  minBet: moneyUnitsToDollars(DEFAULT_SLOT_RULES.minBetUnits).toFixed(2),
  maxBet: moneyUnitsToDollars(DEFAULT_SLOT_RULES.maxBetUnits).toFixed(2),
  tiers: DEFAULT_SLOT_RULES.tiers.map((tier) => ({
    id: tier.id,
    symbol: tier.symbol,
    name: tier.name,
    probabilityPercent: formatProbabilityPercent(tier.probabilityPpm),
    multiplier: formatMultiplier(tier.multiplierBasisPoints),
  })),
};

const symbolMap = new Map(SLOT_SYMBOL_DEFINITIONS.map((symbol) => [symbol.id, symbol]));

function inspectSlotDraft(draft: SlotDraft) {
  const parsed = draft.tiers.map((tier) => ({
    name: tier.name,
    probabilityPpm: probabilityPercentToPpm(tier.probabilityPercent),
    multiplierBasisPoints: multiplierToBasisPoints(tier.multiplier),
  }));
  const malformed = parsed.find((tier) => tier.probabilityPpm === null || tier.multiplierBasisPoints === null);
  if (malformed) return { winRatePpm: null, rtpPpm: null, error: `奖项「${malformed.name || "未命名"}」的概率或倍率格式无效` };
  const tiers = parsed as Array<{ name: string; probabilityPpm: number; multiplierBasisPoints: number }>;
  const invalidProbability = tiers.find((tier) => tier.probabilityPpm <= 0 || tier.probabilityPpm >= SLOT_PROBABILITY_SCALE);
  if (invalidProbability) return { winRatePpm: null, rtpPpm: null, error: `奖项「${invalidProbability.name || "未命名"}」的概率必须在 0～100% 之间` };
  const invalidMultiplier = tiers.find((tier) => tier.multiplierBasisPoints <= SLOT_MULTIPLIER_SCALE);
  if (invalidMultiplier) return { winRatePpm: null, rtpPpm: null, error: `奖项「${invalidMultiplier.name || "未命名"}」的返还倍率必须大于 1` };
  const winRatePpm = tiers.reduce((sum, tier) => sum + tier.probabilityPpm, 0);
  const weighted = tiers.reduce((sum, tier) => sum + BigInt(tier.probabilityPpm) * BigInt(tier.multiplierBasisPoints), 0n);
  const rtpPpm = Number((weighted + BigInt(SLOT_MULTIPLIER_SCALE / 2)) / BigInt(SLOT_MULTIPLIER_SCALE));
  const error = winRatePpm >= SLOT_PROBABILITY_SCALE
    ? "总中奖率必须小于 100%"
    : rtpPpm >= SLOT_PROBABILITY_SCALE
      ? "理论 RTP 必须小于 100%，请降低某些奖项的概率或返还倍率"
      : null;
  return { winRatePpm, rtpPpm, error };
}

export default function Settings() {
  const utils = trpc.useUtils();
  const [configPage, setConfigPage] = useState(1);
  const [configPageSize, setConfigPageSize] = useState(20);
  const [promotionPage, setPromotionPage] = useState(1);
  const [promotionPageSize, setPromotionPageSize] = useState(20);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [ledgerPageSize, setLedgerPageSize] = useState(50);
  const slotControl = trpc.admin.getSlotControl.useQuery({
    configs: { page: configPage, pageSize: configPageSize },
    promotions: { page: promotionPage, pageSize: promotionPageSize },
    ledger: { page: ledgerPage, pageSize: ledgerPageSize },
  });
  const [slotDraft, setSlotDraft] = useState<SlotDraft>(initialSlotDraft);
  const slotDraftEstimate = inspectSlotDraft(slotDraft);
  const [slotPreview, setSlotPreview] = useState<{
    winRatePercent: string; lossRatePercent: string; rtpPercent: string; houseEdgePercent: string;
    maxMultiplier: string; maxGrossPayout: number; maxNetLiability: number;
  } | null>(null);
  const [riskDraft, setRiskDraft] = useState<{ reserve: string; dailyLossLimit: string } | null>(null);
  const [fundForm, setFundForm] = useState({ amount: "", reason: "" });
  const [promotionForm, setPromotionForm] = useState({ configId: "", name: "", startsAt: "", endsAt: "", budget: "" });
  const riskForm = riskDraft ?? {
    reserve: slotControl.data?.fund.reserve.toFixed(2) ?? "",
    dailyLossLimit: slotControl.data?.fund.dailyLossLimit.toFixed(2) ?? "",
  };
  const refreshSlot = () => { utils.admin.getSlotControl.invalidate(); utils.member.checkinStatus.invalidate(); };
  const fail = (e: { message: string }) => toast.error(e.message);
  const previewSlot = trpc.admin.previewSlotConfig.useMutation({ onSuccess: setSlotPreview, onError: fail });
  const createDraft = trpc.admin.createSlotDraft.useMutation({
    onSuccess: (result) => { toast.success(`草稿 ${result.version} 已创建`); refreshSlot(); }, onError: fail,
  });
  const activateConfig = trpc.admin.activateSlotConfig.useMutation({
    onSuccess: (result) => { toast.success(`已启用 ${result.version}`); refreshSlot(); }, onError: fail,
  });
  const updateRisk = trpc.admin.updateSlotRisk.useMutation({
    onSuccess: () => { toast.success("风险控制已更新"); refreshSlot(); }, onError: fail,
  });
  const adjustFund = trpc.admin.adjustSlotFund.useMutation({
    onSuccess: (result) => { toast.success(`奖金池余额 $${result.balance.toFixed(2)}`); setFundForm({ amount: "", reason: "" }); refreshSlot(); }, onError: fail,
  });
  const createPromotion = trpc.admin.createSlotPromotion.useMutation({
    onSuccess: () => { toast.success("活动已创建"); setPromotionForm({ configId: "", name: "", startsAt: "", endsAt: "", budget: "" }); refreshSlot(); }, onError: fail,
  });
  const stopPromotion = trpc.admin.stopSlotPromotion.useMutation({
    onSuccess: () => { toast.success("活动已停止并切回基础规则"); refreshSlot(); }, onError: fail,
  });

  const useActiveAsTemplate = () => {
    const active = slotControl.data?.active;
    if (!active) return;
    setSlotDraft({
      name: `${active.configName} 副本`,
      mode: "base",
      minBet: active.minBet.toFixed(2),
      maxBet: active.maxBet.toFixed(2),
      tiers: active.tiers.map((tier) => ({
        id: tier.id,
        symbol: tier.symbol,
        name: tier.name,
        probabilityPercent: tier.probabilityPercent,
        multiplier: tier.multiplier,
      })),
    });
    setSlotPreview(null);
  };

  return (
    <div className="w-full max-w-[90rem] space-y-6">
      <section className="rounded-xl border border-border bg-card p-5 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h3 className="t-section">老虎机实时状态</h3><p className="mt-2 text-xs leading-5 text-muted-foreground">全局同一规则，不跟踪个人输赢改概率；配置切换后旧局保留完整快照。</p></div>
          <button type="button" onClick={useActiveAsTemplate} className="rounded-lg border border-border px-4 py-2 text-xs font-bold text-foreground">以当前规则为模板</button>
        </div>
        {slotControl.isLoading && <p className="mt-4 py-5 text-center text-xs text-muted-foreground">加载老虎机状态…</p>}
        {slotControl.error && <p className="mt-4 rounded border border-[#EF5459]/30 bg-[#EF5459]/5 px-3 py-2 text-xs text-[#EF5459]">{slotControl.error.message}</p>}
        {slotControl.data && <>
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            {[
              ["当前规则", slotControl.data.active.configVersion],
              ["中奖率 / RTP", `${(slotControl.data.active.theoretical.winRate * 100).toFixed(2)}% / ${(slotControl.data.active.theoretical.rtp * 100).toFixed(2)}%`],
              ["允许下注", slotControl.data.active.paused ? "已暂停" : `$${slotControl.data.active.minBet.toFixed(2)}–$${slotControl.data.active.allowedMaxBet.toFixed(2)}`],
              ["最大净负债", `$${slotControl.data.active.theoretical.maxNetLiability.toFixed(2)}`],
            ].map(([label, value]) => <div key={label} className="rounded-lg border border-border bg-[hsl(var(--admin-control))] p-3"><p className="text-[11px] text-muted-foreground">{label}</p><p className="font-num mt-1 break-all text-sm font-bold text-foreground">{value}</p></div>)}
          </div>
          {slotControl.data.active.pausedReason && <p className="mt-3 rounded-lg border border-[#EF5459]/50 bg-[#2b151a] px-4 py-3 text-xs text-[#ff9a9d]">{slotControl.data.active.pausedReason}</p>}
        </>}
      </section>

      <section className="rounded-xl border border-border bg-card p-5 sm:p-8">
        <h3 className="t-section">奖金池与风险控制</h3>
        {slotControl.data && <div className="mt-4 grid gap-3 sm:grid-cols-5">
          {[
            ["奖金池", `$${slotControl.data.fund.balance.toFixed(2)}`], ["准备金", `$${slotControl.data.fund.reserve.toFixed(2)}`],
            ["可用风险额度", `$${slotControl.data.fund.availableAboveReserve.toFixed(2)}`], ["今日净收益", `${slotControl.data.fund.dayNet >= 0 ? "+" : ""}$${slotControl.data.fund.dayNet.toFixed(2)}`],
            ["今日亏损 / 上限", `$${slotControl.data.fund.dailyLossUsed.toFixed(2)} / $${slotControl.data.fund.dailyLossLimit.toFixed(2)}`],
          ].map(([label, value]) => <div key={label} className="rounded-lg border border-border bg-[hsl(var(--admin-control))] p-3"><p className="text-[11px] text-muted-foreground">{label}</p><p className="font-num mt-1 text-sm font-bold text-foreground">{value}</p></div>)}
        </div>}
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <form className="rounded-lg border border-border p-4" onSubmit={(e) => { e.preventDefault(); updateRisk.mutate(riskForm); }}>
            <p className="text-xs font-bold text-primary">风险阈值</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div><Label className="text-xs">准备金（$）</Label><Input value={riskForm.reserve} onChange={(e) => setRiskDraft({ ...riskForm, reserve: e.target.value })} className="mt-1 bg-[hsl(var(--admin-control))]" /></div>
              <div><Label className="text-xs">每日实际亏损上限（$）</Label><Input value={riskForm.dailyLossLimit} onChange={(e) => setRiskDraft({ ...riskForm, dailyLossLimit: e.target.value })} className="mt-1 bg-[hsl(var(--admin-control))]" /></div>
            </div>
            <button className="btn-3d mt-3 rounded-lg bg-accent px-4 py-2 text-xs font-black text-accent-foreground">保存风险设置</button>
          </form>
          <form className="rounded-lg border border-border p-4" onSubmit={(e) => { e.preventDefault(); adjustFund.mutate(fundForm); }}>
            <p className="text-xs font-bold text-primary">人工调整奖金池</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-[8rem_1fr]"><Input placeholder="如 500 / -100" value={fundForm.amount} onChange={(e) => setFundForm({ ...fundForm, amount: e.target.value })} className="bg-[hsl(var(--admin-control))]" /><Input placeholder="必填原因（只代表额度划拨，不宣称真实净利润）" value={fundForm.reason} onChange={(e) => setFundForm({ ...fundForm, reason: e.target.value })} className="bg-[hsl(var(--admin-control))]" /></div>
            <button className="btn-3d mt-3 rounded-lg bg-[#00B77D] px-4 py-2 text-xs font-black text-white">提交调整并记账</button>
          </form>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5 sm:p-8">
        <h3 className="t-section">配置草稿与精确预览</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2"><Label className="text-xs">配置名称</Label><Input value={slotDraft.name} onChange={(e) => setSlotDraft({ ...slotDraft, name: e.target.value })} className="mt-1 bg-[hsl(var(--admin-control))]" /></div>
          <div><Label className="text-xs">用途</Label><select value={slotDraft.mode} onChange={(e) => setSlotDraft({ ...slotDraft, mode: e.target.value as SlotDraft["mode"] })} className="mt-1 h-9 w-full rounded-md border border-border bg-[hsl(var(--admin-control))] px-3 text-sm"><option value="base">基础规则</option><option value="promotion">放水活动</option></select></div>
          <div className="grid grid-cols-2 gap-2"><div><Label className="text-xs">最低下注</Label><Input value={slotDraft.minBet} onChange={(e) => setSlotDraft({ ...slotDraft, minBet: e.target.value })} className="mt-1 bg-[hsl(var(--admin-control))]" /></div><div><Label className="text-xs">最高下注</Label><Input value={slotDraft.maxBet} onChange={(e) => setSlotDraft({ ...slotDraft, maxBet: e.target.value })} className="mt-1 bg-[hsl(var(--admin-control))]" /></div></div>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[700px] text-left text-xs"><thead className="text-muted-foreground"><tr><th className="p-2">奖项</th><th className="p-2">名称</th><th className="p-2">概率（%）</th><th className="p-2">返还倍率</th><th className="p-2">说明</th></tr></thead>
            <tbody>{slotDraft.tiers.map((tier, index) => {
              const symbol = symbolMap.get(tier.symbol);
              return <tr key={tier.id} className="border-t border-border"><td className="p-2 text-lg">{symbol?.glyph}</td><td className="p-2"><Input value={tier.name} onChange={(e) => setSlotDraft({ ...slotDraft, tiers: slotDraft.tiers.map((item, i) => i === index ? { ...item, name: e.target.value } : item) })} className="bg-[hsl(var(--admin-control))]" /></td><td className="p-2"><Input value={tier.probabilityPercent} onChange={(e) => setSlotDraft({ ...slotDraft, tiers: slotDraft.tiers.map((item, i) => i === index ? { ...item, probabilityPercent: e.target.value } : item) })} className="font-num bg-[hsl(var(--admin-control))]" /></td><td className="p-2"><Input value={tier.multiplier} onChange={(e) => setSlotDraft({ ...slotDraft, tiers: slotDraft.tiers.map((item, i) => i === index ? { ...item, multiplier: e.target.value } : item) })} className="font-num bg-[hsl(var(--admin-control))]" /></td><td className="p-2 text-muted-foreground">{tier.symbol} 三连</td></tr>;
            })}</tbody>
          </table>
        </div>
        <div className={`mt-4 rounded-lg border p-4 text-xs ${slotDraftEstimate.error ? "border-[#EF5459]/50 bg-[#EF5459]/5" : "border-[#00B77D]/40 bg-[#00B77D]/5"}`}>
          <p className="font-bold text-foreground">
            实时计算：中奖率 {slotDraftEstimate.winRatePpm === null ? "—" : `${formatProbabilityPercent(slotDraftEstimate.winRatePpm)}%`}
            <span className="mx-2 text-muted-foreground">·</span>
            RTP {slotDraftEstimate.rtpPpm === null ? "—" : `${formatProbabilityPercent(slotDraftEstimate.rtpPpm)}%`}
          </p>
          <p className={`mt-1 leading-5 ${slotDraftEstimate.error ? "text-[#EF5459]" : "text-muted-foreground"}`}>
            {slotDraftEstimate.error ?? "参数满足 RTP 风险边界，可继续请求服务端精确预览。"} RTP = 各奖项“概率 × 返还倍率”之和，配置名称中的数字不会改变实际 RTP。
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" onClick={() => previewSlot.mutate(slotDraft)} disabled={!!slotDraftEstimate.error || previewSlot.isPending} className="rounded-lg border border-accent px-5 py-2 text-xs font-bold text-accent disabled:cursor-not-allowed disabled:opacity-40">服务端精确预览</button>
          <button type="button" onClick={() => createDraft.mutate(slotDraft)} disabled={!!slotDraftEstimate.error || createDraft.isPending} className="btn-3d rounded-lg bg-accent px-5 py-2 text-xs font-black text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40">保存不可变草稿</button>
          <button type="button" onClick={() => { setSlotDraft(initialSlotDraft); setSlotPreview(null); }} className="rounded-lg border border-border px-5 py-2 text-xs font-bold text-muted-foreground hover:text-foreground">恢复默认 25.05% / RTP 92%</button>
        </div>
        {slotPreview && <div className="mt-4 grid gap-2 rounded-lg border border-[#00B77D]/50 bg-[#102820] p-4 text-xs sm:grid-cols-4"><span>中奖率 <b>{slotPreview.winRatePercent}%</b></span><span>RTP <b>{slotPreview.rtpPercent}%</b></span><span>平台优势 <b>{slotPreview.houseEdgePercent}%</b></span><span>最大净负债 <b>${slotPreview.maxNetLiability.toFixed(2)}</b></span></div>}
      </section>

      <section className="rounded-xl border border-border bg-card p-5 sm:p-8">
        <h3 className="t-section">放水活动</h3>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">活动只使用全局活动配置和独立预算；预算不能覆盖下一次最坏赔付时自动结束并切回基础规则。</p>
        <form className="mt-4 grid gap-3 md:grid-cols-5" onSubmit={(e) => { e.preventDefault(); createPromotion.mutate({ configId: Number(promotionForm.configId), name: promotionForm.name, startsAt: new Date(promotionForm.startsAt).getTime(), endsAt: new Date(promotionForm.endsAt).getTime(), budget: promotionForm.budget }); }}>
          <select required value={promotionForm.configId} onChange={(e) => setPromotionForm({ ...promotionForm, configId: e.target.value })} className="h-9 rounded-md border border-border bg-[hsl(var(--admin-control))] px-3 text-xs"><option value="">选择活动配置</option>{slotControl.data?.configs.filter((config) => config.mode === "promotion").map((config) => <option key={config.id} value={config.id}>{config.version} · RTP {config.rtpPercent}%</option>)}</select>
          <Input required placeholder="活动名称" value={promotionForm.name} onChange={(e) => setPromotionForm({ ...promotionForm, name: e.target.value })} className="bg-[hsl(var(--admin-control))]" />
          <Input required type="datetime-local" value={promotionForm.startsAt} onChange={(e) => setPromotionForm({ ...promotionForm, startsAt: e.target.value })} className="bg-[hsl(var(--admin-control))]" />
          <Input required type="datetime-local" value={promotionForm.endsAt} onChange={(e) => setPromotionForm({ ...promotionForm, endsAt: e.target.value })} className="bg-[hsl(var(--admin-control))]" />
          <div className="flex gap-2"><Input required placeholder="预算 $" value={promotionForm.budget} onChange={(e) => setPromotionForm({ ...promotionForm, budget: e.target.value })} className="bg-[hsl(var(--admin-control))]" /><button className="btn-3d rounded-lg bg-accent px-4 text-xs font-black text-accent-foreground">创建</button></div>
        </form>
        <div className="mt-5 space-y-2">{slotControl.data?.promotions.map((promotion) => <div key={promotion.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-[hsl(var(--admin-control))] p-3 text-xs"><div><p className="font-bold text-foreground">{promotion.name} · {promotion.status}</p><p className="mt-1 text-muted-foreground">{promotion.configVersion} · {new Date(promotion.startsAt).toLocaleString("zh-CN")}–{new Date(promotion.endsAt).toLocaleString("zh-CN")}</p></div><div className="font-num">预算 ${promotion.budget.toFixed(2)} · 已用 ${promotion.spent.toFixed(2)} · 剩余 ${promotion.remaining.toFixed(2)}</div>{["scheduled", "active"].includes(promotion.status) && <button type="button" onClick={() => stopPromotion.mutate({ promotionId: promotion.id })} className="rounded border border-[#EF5459]/60 px-3 py-1.5 font-bold text-[#EF5459]">停止</button>}</div>)}</div>
        {slotControl.data && !slotControl.data.promotions.length && <p className="mt-5 py-5 text-center text-xs text-muted-foreground">暂无活动记录</p>}
        {slotControl.data && <Pager className="mt-4" {...slotControl.data.pages.promotions} pageSize={promotionPageSize}
          onPage={setPromotionPage} onPageSize={(size) => { setPromotionPageSize(size); setPromotionPage(1); }} />}
      </section>

      <section className="rounded-xl border border-border bg-card p-5 sm:p-8">
        <h3 className="t-section">配置历史</h3>
        <div className="mt-4 space-y-2">{slotControl.data?.configs.map((config) => <div key={config.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-[hsl(var(--admin-control))] p-3 text-xs"><div className="min-w-0"><p className="font-num break-all font-bold text-foreground">{config.version}</p><p className="mt-1 text-muted-foreground">{config.name} · {config.mode} / {config.status} · 中奖率 {config.winRatePercent}% · RTP {config.rtpPercent}% · 最大净负债 ${config.maxNetLiability.toFixed(2)}</p></div>{config.mode === "base" && config.status !== "active" && <button type="button" onClick={() => activateConfig.mutate({ configId: config.id })} className="rounded border border-[#00B77D]/60 px-3 py-1.5 font-bold text-[#00B77D]">启用此版本</button>}</div>)}</div>
        {slotControl.data && !slotControl.data.configs.length && <p className="mt-4 py-5 text-center text-xs text-muted-foreground">暂无配置版本</p>}
        {slotControl.data && <Pager className="mt-4" {...slotControl.data.pages.configs} pageSize={configPageSize}
          onPage={setConfigPage} onPageSize={(size) => { setConfigPageSize(size); setConfigPage(1); }} />}
      </section>

      <section className="rounded-xl border border-border bg-card p-5 sm:p-8">
        <h3 className="t-section">奖金池追加式流水</h3>
        <div className="mt-4 space-y-1">{slotControl.data?.ledger.map((entry) => <div key={entry.id} className="grid grid-cols-[8rem_5rem_1fr] gap-3 border-b border-border py-2 text-xs"><span className="text-muted-foreground">{new Date(entry.createdAt).toLocaleString("zh-CN")}</span><span className={entry.amount >= 0 ? "text-[#00B77D]" : "text-[#EF5459]"}>{entry.amount >= 0 ? "+" : ""}${entry.amount.toFixed(2)}</span><span className="text-muted-foreground">余额 ${entry.balanceAfter.toFixed(2)} · {entry.note}</span></div>)}</div>
        {slotControl.data && !slotControl.data.ledger.length && <p className="mt-4 py-5 text-center text-xs text-muted-foreground">暂无奖金池流水</p>}
        {slotControl.data && <Pager className="mt-4" {...slotControl.data.pages.ledger} pageSize={ledgerPageSize}
          onPage={setLedgerPage} onPageSize={(size) => { setLedgerPageSize(size); setLedgerPage(1); }} unit="笔" />}
      </section>
    </div>
  );
}
