import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { useMe } from "@/hooks/useMe";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { groupNameSchema } from "@contracts/group-name";

export default function Onboarding() {
  const { user, isLoading } = useMe({ requireAuth: true });
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [inviteCode, setInviteCode] = useState("");
  const [groupName, setGroupName] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (user?.onboarded) navigate("/draw", { replace: true });
  }, [user, navigate]);

  const submit = trpc.auth.completeOnboarding.useMutation({
    onSuccess: async () => {
      await utils.invalidate();
      navigate("/draw");
    },
    onError: (e) => setError(e.message),
  });

  if (isLoading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="rise-in w-full max-w-md">
        <div className="rounded-xl bg-gradient-to-b from-[#af915f] to-[#af915f]/30 p-px">
          <div className="rounded-[11px] bg-[#101d2b] p-5 sm:p-8">
            <p className="text-xs font-bold tracking-[0.4em] text-[#af915f]">WELCOME</p>
            <h1 className="mt-2 text-2xl font-black text-[#fce1b6]">完成注册</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              你好，<span className="text-[#FFB700]">{user.displayName || user.username}</span>（Lv.{user.trustLevel}）
              。填入邀请码和群内名称即可入场。
            </p>
            <form
              className="mt-8 space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                setError("");
                const parsed = groupNameSchema.safeParse(groupName);
                if (!parsed.success) {
                  setError(parsed.error.issues[0]?.message ?? "请检查群内名称");
                  return;
                }
                submit.mutate({ inviteCode: inviteCode.trim(), groupName: parsed.data });
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="invite" className="text-[#af915f]">邀请码</Label>
                <Input
                  id="invite"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="LD-XXXXXXXX"
                  className="border-border bg-[#162638] font-num tracking-widest placeholder:text-muted-foreground/50"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="gname" className="text-[#af915f]">群内名称（必填）</Label>
                <Input
                  id="gname"
                  value={groupName}
                  onChange={(e) => { setGroupName(e.target.value); setError(""); }}
                  placeholder="请输入你在群内使用的名称"
                  className="border-border bg-[#162638] placeholder:text-muted-foreground/50"
                  maxLength={32}
                  autoComplete="nickname"
                  required
                />
                <p className="text-xs text-muted-foreground">1–32 个字符，将公开显示在榜单和举报记录中；注册后可在控制台修改，且不能与他人重复。</p>
              </div>
              {error && <p className="text-sm text-[#EF5459]">{error}</p>}
              <button
                type="submit"
                disabled={submit.isPending}
                className="btn-3d w-full rounded-lg bg-[#FFB700] py-3 font-black text-[#162638] disabled:opacity-50"
              >
                {submit.isPending ? "提交中…" : "入场 →"}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
