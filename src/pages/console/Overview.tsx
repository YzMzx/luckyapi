import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useMe } from "@/hooks/useMe";
import { ConsoleLayout } from "@/components/ConsoleLayout";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { groupNameSchema } from "@contracts/group-name";

export default function Overview() {
  const { user, isLoading } = useMe({ requireAuth: true, requireOnboarded: true });
  const utils = trpc.useUtils();
  const usage = trpc.member.myUsage.useQuery(undefined, { enabled: !!user?.onboarded });
  const [redeemInput, setRedeemInput] = useState("");
  const [nameEditing, setNameEditing] = useState(false);
  const [groupNameInput, setGroupNameInput] = useState("");
  const [groupNameError, setGroupNameError] = useState("");

  const redeem = trpc.member.redeemCode.useMutation({
    onSuccess: (res) => {
      toast.success(res.message);
      setRedeemInput("");
      utils.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const updateGroupName = trpc.member.updateGroupName.useMutation({
    onSuccess: async (res) => {
      toast.success(`群内名称已更新为「${res.groupName}」`);
      setNameEditing(false);
      setGroupNameError("");
      await utils.invalidate();
    },
    onError: (error) => setGroupNameError(error.message),
  });

  if (isLoading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;

  const baseUrl = window.location.origin;

  return (
    <ConsoleLayout user={user} title="概览" desc="余额、充值与接入信息">
      <div className="space-y-6">
        {/* 余额卡片 */}
        <section className="grid gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-3">
          <div className="bg-[#101d2b] p-5 sm:p-8">
            <p className="text-xs font-bold tracking-[0.3em] text-[#af915f]">BALANCE</p>
            <div className="font-num mt-3 text-4xl font-black text-[#FFB700] sm:text-5xl">${Number(user.balance).toFixed(2)}</div>
            <p className="mt-2 text-xs text-muted-foreground">当前可用额度</p>
          </div>
          <div className="bg-[#101d2b] p-5 sm:p-8">
            <p className="text-xs font-bold tracking-[0.3em] text-[#af915f]">WON</p>
            <div className="font-num mt-3 text-4xl font-black text-[#fce1b6] sm:text-5xl">${Number(user.totalWon).toFixed(2)}</div>
            <p className="mt-2 text-xs text-muted-foreground">抽奖累计获得</p>
          </div>
          <div className="bg-[#101d2b] p-5 sm:p-8">
            <p className="text-xs font-bold tracking-[0.3em] text-[#af915f]">SPENT</p>
            <div className="font-num mt-3 text-4xl font-black text-[#fce1b6] sm:text-5xl">
              ${Number(usage.data?.summary.totalCost ?? 0).toFixed(4)}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              累计消耗 · {Number(usage.data?.summary.totalPrompt ?? 0) + Number(usage.data?.summary.totalCompletion ?? 0)} tokens
            </p>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-[#101d2b] p-5 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="t-section">群内名称</h2>
              <p className="mt-2 text-lg font-bold text-[#fce1b6]">{user.groupName}</p>
              <p className="mt-1 text-xs text-muted-foreground">公开显示在可用额度榜和举报记录中，名称必须唯一。</p>
            </div>
            {!nameEditing && <button
              type="button"
              onClick={() => { setGroupNameInput(user.groupName ?? ""); setGroupNameError(""); setNameEditing(true); }}
              className="rounded border border-[#af915f]/50 px-4 py-2 text-xs font-bold text-[#fce1b6] hover:border-[#FFB700]"
            >修改名称</button>}
          </div>
          {nameEditing && <form className="mt-4 max-w-md space-y-3" onSubmit={(event) => {
            event.preventDefault();
            setGroupNameError("");
            const parsed = groupNameSchema.safeParse(groupNameInput);
            if (!parsed.success) {
              setGroupNameError(parsed.error.issues[0]?.message ?? "请检查群内名称");
              return;
            }
            updateGroupName.mutate({ groupName: parsed.data });
          }}>
            <div className="space-y-1.5">
              <Label htmlFor="group-name-edit" className="text-xs text-[#af915f]">新的群内名称</Label>
              <Input id="group-name-edit" value={groupNameInput}
                onChange={(event) => { setGroupNameInput(event.target.value); setGroupNameError(""); }}
                maxLength={32} autoComplete="nickname" required
                placeholder="1–32 个字符" className="border-border bg-[#162638]" />
            </div>
            {groupNameError && <p className="text-xs text-[#EF5459]">{groupNameError}</p>}
            <div className="flex gap-2">
              <button type="submit" disabled={updateGroupName.isPending}
                className="rounded bg-[#FFB700] px-4 py-2 text-xs font-black text-[#162638] disabled:opacity-50">
                {updateGroupName.isPending ? "保存中…" : "保存"}
              </button>
              <button type="button" onClick={() => { setNameEditing(false); setGroupNameError(""); }}
                className="px-3 py-2 text-xs text-muted-foreground hover:text-[#fce1b6]">取消</button>
            </div>
          </form>}
        </section>

        {/* 兑换码与举报卡 */}
        <section className="rounded-xl border border-border bg-[#101d2b] p-5 sm:p-8">
          <h2 className="t-section">兑换码 / 举报卡</h2>
          <p className="mt-2 text-xs text-muted-foreground">充值码增加账户额度；举报卡增加永久举报次数。限时额度会明确标注北京时间失效点，并按最早到期优先消费。</p>
          <form
            className="mt-4 flex flex-wrap items-center gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (redeemInput.trim()) redeem.mutate({ code: redeemInput.trim() });
            }}
          >
            <Input
              value={redeemInput}
              onChange={(e) => setRedeemInput(e.target.value)}
              placeholder="输入充值码或举报卡，如 LD-XXXXXXXX"
              className="w-full border-border bg-[#162638] font-num tracking-widest placeholder:text-muted-foreground/50 sm:w-72"
            />
            <button
              type="submit"
              disabled={redeem.isPending}
              className="btn-3d rounded-lg bg-[#FFB700] px-6 py-2 text-sm font-black text-[#162638] disabled:opacity-50"
            >
              {redeem.isPending ? "兑换中…" : "兑换"}
            </button>
          </form>
        </section>

        {/* 接入信息 */}
        <section className="rounded-xl border border-border bg-[#101d2b] p-5 sm:p-8">
          <h2 className="t-section">接入信息</h2>
          <div className="mt-4 space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-20 shrink-0 text-muted-foreground">Base URL</span>
              <code className="font-num break-all rounded bg-[#162638] px-3 py-1.5 text-[#FFB700]">{baseUrl}/v1</code>
              <button
                className="text-xs text-[#af915f] hover:underline"
                onClick={() => { navigator.clipboard.writeText(`${baseUrl}/v1`); toast.success("已复制"); }}
              >复制</button>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              四种协议入口全部开放：<code className="text-[#fce1b6]">/v1/chat/completions</code>（OpenAI）、
              <code className="text-[#fce1b6]">/v1/responses</code>（Codex）、
              <code className="text-[#fce1b6]">/v1/messages</code>（Claude）、
              <code className="text-[#fce1b6]">/v1beta/models/…</code>（Gemini）。认证方式{" "}
              <code className="text-[#fce1b6]">Authorization: Bearer &lt;你的 Key&gt;</code>
            </p>
          </div>
        </section>
      </div>
    </ConsoleLayout>
  );
}
