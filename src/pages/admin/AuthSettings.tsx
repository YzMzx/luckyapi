import { useEffect, useState } from "react";
import { CheckCircle2, KeyRound, LockKeyhole, Save } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/providers/trpc";

type Form = {
  primaryOrigin: string;
  primaryClientId: string;
  primaryClientSecret?: string;
  adminUsername: string;
  adminPassword?: string;
};

function Field({ label, value, onChange, type = "text", placeholder }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return <div className="space-y-1.5"><Label>{label}</Label><Input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="admin-input" /></div>;
}

export default function AuthSettings() {
  const query = trpc.admin.authSettings.get.useQuery();
  const [form, setForm] = useState<Form | null>(null);

  useEffect(() => {
    if (query.data) setForm({
      primaryOrigin: query.data.primaryOrigin,
      primaryClientId: query.data.primaryClientId,
      adminUsername: query.data.adminUsername,
    });
  }, [query.data]);

  const save = trpc.admin.authSettings.update.useMutation({
    onSuccess: () => {
      toast.success("认证与安全配置已保存");
      query.refetch();
      setForm((current) => current ? { ...current, primaryClientSecret: "", adminPassword: "" } : current);
    },
    onError: (error) => toast.error(error.message),
  });

  if (!form || !query.data) return <div className="admin-panel p-8 text-muted-foreground">加载认证配置中…</div>;

  return <form className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(20rem,.75fr)] xl:gap-6" onSubmit={(event) => { event.preventDefault(); save.mutate(form); }}>
    <section className="admin-panel p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <KeyRound className="h-5 w-5 text-primary" />
        <div>
          <h2 className="font-black text-foreground">Linux.do OAuth 单入口</h2>
          <p className="mt-1 text-xs text-muted-foreground">全站只使用这一组域名、Client ID 和 Client Secret；反向代理不会再触发 A/B 客户端识别。</p>
        </div>
      </div>
      <div className="mt-5 rounded-2xl border border-border bg-background/35 p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-black text-foreground">唯一登录入口</h3>
          <span className={query.data.primarySecretConfigured ? "admin-status-ok" : "admin-status-warn"}>{query.data.primarySecretConfigured ? "密钥已配置" : "缺少密钥"}</span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="可信站点 Origin" value={form.primaryOrigin} onChange={(value) => setForm({ ...form, primaryOrigin: value })} placeholder="https://example.com" />
          <Field label="OAuth Client ID" value={form.primaryClientId} onChange={(value) => setForm({ ...form, primaryClientId: value })} />
          <Field label="OAuth Client Secret" type="password" value={form.primaryClientSecret ?? ""} onChange={(value) => setForm({ ...form, primaryClientSecret: value })} placeholder={query.data.primarySecretConfigured ? "留空表示保留现有密钥" : "输入密钥"} />
          <div><Label>Linux.do 回调地址</Label><p className="mt-1.5 break-all rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">{form.primaryOrigin || "https://你的域名"}{query.data.callbackPath}</p></div>
        </div>
      </div>
    </section>

    <section className="admin-panel h-fit p-4 sm:p-6">
      <div className="flex items-center gap-3"><LockKeyhole className="h-5 w-5 text-primary" /><h2 className="font-black text-foreground">管理员安全</h2></div>
      <div className="mt-5 grid gap-4">
        <Field label="管理员用户名" value={form.adminUsername} onChange={(value) => setForm({ ...form, adminUsername: value })} />
        <Field label="新管理员密码" type="password" value={form.adminPassword ?? ""} onChange={(value) => setForm({ ...form, adminPassword: value })} placeholder={query.data.adminPasswordConfigured ? "留空表示不修改" : "至少 8 个字符"} />
      </div>
    </section>

    <div className="sticky bottom-2 z-20 flex flex-col gap-3 rounded-2xl border border-primary/30 bg-card/95 p-3 shadow-2xl backdrop-blur sm:bottom-4 sm:flex-row sm:items-center sm:justify-between sm:p-4 xl:col-span-2">
      <p className="flex items-center gap-2 text-xs text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-[#00B77D]" />密钥不会从服务器回传，留空即保留原值。</p>
      <button disabled={save.isPending} className="admin-primary flex w-full items-center justify-center gap-2 px-6 py-2.5 sm:w-auto"><Save className="h-4 w-4" />保存认证设置</button>
    </div>
  </form>;
}
