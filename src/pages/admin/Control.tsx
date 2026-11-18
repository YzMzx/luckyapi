import { useEffect, useState } from "react";
import { AlertTriangle, Power, Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { trpc } from "@/providers/trpc";

const labels = { login: "用户登录", registration: "新用户注册", api: "API 调用", transfer: "用户转账", lending: "民间借贷", draw: "一次性抽奖", signin: "每日签到", videoReward: "视频红包", slot: "老虎机", duel: "决斗场" } as const;
type State = { maintenance: boolean; modules: Record<keyof typeof labels, boolean> };

export default function Control() {
  const utils = trpc.useUtils();
  const query = trpc.admin.control.get.useQuery();
  const [draft, setDraft] = useState<State | null>(null);
  const [reason, setReason] = useState("");
  useEffect(() => { if (query.data) setDraft(query.data); }, [query.data]);
  const mutation = trpc.admin.control.update.useMutation({ onSuccess: (data) => { setDraft(data); setReason(""); toast.success("运营控制已更新"); utils.admin.invalidate(); }, onError: (e) => toast.error(e.message) });
  if (!draft) return <div className="admin-panel p-8 text-sm text-muted-foreground">{query.error ? `加载失败：${query.error.message}` : "加载控制状态中…"}</div>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(query.data);
  return <div className="w-full max-w-[90rem] space-y-6">
    <section className="admin-panel border-[#EF5459]/35 p-6"><div className="flex flex-wrap items-center justify-between gap-4"><div className="flex items-start gap-3"><span className="rounded-xl bg-[#EF5459]/12 p-2.5 text-[#EF5459]"><AlertTriangle className="h-5 w-5" /></span><div><h2 className="font-black text-foreground">全站维护模式</h2><p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">阻止所有新业务操作；历史查询以及存量借贷、房间、投注的结算和退款仍继续执行。</p></div></div><Switch checked={draft.maintenance} onCheckedChange={(maintenance) => setDraft({ ...draft, maintenance })} /></div></section>
    <section className="admin-panel p-6"><div className="flex items-center gap-3"><Power className="h-5 w-5 text-primary" /><div><h2 className="font-black text-foreground">模块总开关</h2><p className="mt-1 text-xs text-muted-foreground">关闭后只禁止发起新的参与，不破坏正在处理的资金。</p></div></div><div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(labels).map(([key, label]) => <label key={key} className="flex cursor-pointer items-center justify-between rounded-xl border border-border bg-background/40 px-4 py-4"><span><b className="block text-sm text-foreground">{label}</b><small className={draft.modules[key as keyof typeof labels] ? "text-[#00B77D]" : "text-[#EF5459]"}>{draft.modules[key as keyof typeof labels] ? "允许新操作" : "已停止新操作"}</small></span><Switch checked={draft.modules[key as keyof typeof labels]} onCheckedChange={(value) => setDraft({ ...draft, modules: { ...draft.modules, [key]: value } })} /></label>)}</div></section>
    <section className="admin-panel p-6"><div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /><h2 className="font-black text-foreground">变更确认</h2></div><p className="mt-2 text-xs text-muted-foreground">每次保存必须填写原因；旧值、新值和原因都会写入操作日志。</p><div className="mt-4 flex flex-col gap-3 sm:flex-row"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="填写本次调整原因（至少 2 个字符）" className="admin-input flex-1" /><button disabled={!dirty || reason.trim().length < 2 || mutation.isPending} onClick={() => mutation.mutate({ ...draft, reason })} className="admin-primary flex items-center justify-center gap-2 px-6 py-2.5 disabled:opacity-40"><Save className="h-4 w-4" />{mutation.isPending ? "保存中…" : "确认并保存"}</button><button disabled={!dirty} onClick={() => setDraft(query.data ?? null)} className="admin-secondary px-5 py-2.5 disabled:opacity-40">恢复已保存值</button></div></section>
  </div>;
}
