import { useEffect, useState } from "react";
import { Banknote, HandCoins, Save } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/providers/trpc";

type Form = {
  transferFeePercent: number; transferMin: number; transferMax: number; transferDailyLimit: number;
  loanMinPrincipal: number; loanMaxPrincipal: number; loanMinRatePercent: number; loanMaxRatePercent: number;
  loanMinDurationDays: number; loanMaxDurationDays: number; loanOfferExpiryMinutes: number;
  loanInterestTaxPercent: number; lendingDailyLimit: number; outstandingBorrowLimit: number;
};

function NumberField({ label, value, onChange, suffix }: { label: string; value: number; onChange: (value: number) => void; suffix: string }) {
  return <div className="space-y-1.5"><Label>{label}</Label><div className="relative"><Input type="number" min="0" step="0.01" value={value} onChange={(event) => onChange(Number(event.target.value))} className="admin-input pr-16" /><span className="absolute right-3 top-2.5 text-xs text-muted-foreground">{suffix}</span></div></div>;
}

export default function FinanceSettings() {
  const query = trpc.admin.financeSettings.get.useQuery();
  const [form, setForm] = useState<Form | null>(null);
  useEffect(() => { if (query.data) setForm(query.data); }, [query.data]);
  const save = trpc.admin.financeSettings.update.useMutation({ onSuccess: () => { toast.success("金融规则已保存"); query.refetch(); }, onError: (error) => toast.error(error.message) });
  if (!form) return <div className="admin-panel p-8 text-muted-foreground">加载金融规则中…</div>;
  const set = (key: keyof Form, value: number) => setForm({ ...form, [key]: value });
  return <form className="w-full max-w-[90rem] space-y-5 sm:space-y-6" onSubmit={(event) => { event.preventDefault(); save.mutate(form); }}>
    <section className="admin-panel p-4 sm:p-6"><div className="flex items-center gap-3"><Banknote className="h-5 w-5 text-primary" /><div><h2 className="font-black text-foreground">转账规则</h2><p className="mt-1 text-xs text-muted-foreground">用户个人限制与全局限制并存时自动采用更严格值。</p></div></div><div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><NumberField label="手续费" value={form.transferFeePercent} onChange={(value) => set("transferFeePercent", value)} suffix="%" /><NumberField label="单笔最低" value={form.transferMin} onChange={(value) => set("transferMin", value)} suffix="USD" /><NumberField label="单笔最高" value={form.transferMax} onChange={(value) => set("transferMax", value)} suffix="USD" /><NumberField label="每日转出上限" value={form.transferDailyLimit} onChange={(value) => set("transferDailyLimit", value)} suffix="USD" /></div></section>
    <section className="admin-panel p-4 sm:p-6"><div className="flex items-center gap-3"><HandCoins className="h-5 w-5 text-primary" /><div><h2 className="font-black text-foreground">借贷规则</h2><p className="mt-1 text-xs text-muted-foreground">只作用于新合同；合同成立时保存完整快照，已有合同不会被修改。</p></div></div><div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><NumberField label="本金最低" value={form.loanMinPrincipal} onChange={(value) => set("loanMinPrincipal", value)} suffix="USD" /><NumberField label="本金最高" value={form.loanMaxPrincipal} onChange={(value) => set("loanMaxPrincipal", value)} suffix="USD" /><NumberField label="每日放贷上限" value={form.lendingDailyLimit} onChange={(value) => set("lendingDailyLimit", value)} suffix="USD" /><NumberField label="最低月利率" value={form.loanMinRatePercent} onChange={(value) => set("loanMinRatePercent", value)} suffix="%" /><NumberField label="最高月利率" value={form.loanMaxRatePercent} onChange={(value) => set("loanMaxRatePercent", value)} suffix="%" /><NumberField label="利息税" value={form.loanInterestTaxPercent} onChange={(value) => set("loanInterestTaxPercent", value)} suffix="%" /><NumberField label="最短期限" value={form.loanMinDurationDays} onChange={(value) => set("loanMinDurationDays", Math.round(value))} suffix="天" /><NumberField label="最长期限" value={form.loanMaxDurationDays} onChange={(value) => set("loanMaxDurationDays", Math.round(value))} suffix="天" /><NumberField label="要约有效期" value={form.loanOfferExpiryMinutes} onChange={(value) => set("loanOfferExpiryMinutes", Math.round(value))} suffix="分钟" /><NumberField label="未偿借款上限" value={form.outstandingBorrowLimit} onChange={(value) => set("outstandingBorrowLimit", value)} suffix="USD" /></div></section>
    <div className="sticky bottom-2 z-20 flex rounded-2xl border border-primary/30 bg-card/95 p-3 shadow-2xl backdrop-blur sm:bottom-4 sm:justify-end sm:p-4"><button disabled={save.isPending} className="admin-primary flex w-full items-center justify-center gap-2 px-7 py-2.5 sm:w-auto"><Save className="h-4 w-4" />保存金融规则</button></div>
  </form>;
}
