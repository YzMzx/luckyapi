import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useMe } from "@/hooks/useMe";
import { SiteNav } from "@/components/SiteNav";

const PROTO_LABEL: Record<string, string> = {
  chat: "chat",
  responses: "responses",
  claude: "claude",
  gemini: "gemini",
};

function fmtPrice(v: number | null): string {
  if (v === null) return "免费";
  return `$${Number(v.toFixed(6))}`;
}

export default function Models() {
  const { user, isLoading } = useMe({ requireAuth: true, requireOnboarded: true });
  const models = trpc.member.listModels.useQuery(undefined, { enabled: !!user?.onboarded });
  const groups = trpc.member.listGroups.useQuery(undefined, { enabled: !!user?.onboarded });
  const [groupName, setGroupName] = useState<string | null>(null); // null = 全部
  const [keyword, setKeyword] = useState("");

  if (isLoading || !user) return <div className="flex min-h-screen items-center justify-center text-muted-foreground">加载中…</div>;

  const group = groups.data?.find((g) => g.name === groupName) ?? null;
  const mult = group ? Number(group.multiplier) : 1;

  const visible = (models.data ?? []).filter((m) => {
    if (keyword && !m.name.toLowerCase().includes(keyword.toLowerCase())) return false;
    if (!group) return true;
    if (!m.allowedGroups.trim()) return true; // 空 = 全部分组可用
    return m.allowedGroups.split(",").map((s) => s.trim()).includes(group.name);
  });

  const price = (v: number | null) => (v === null ? null : v * mult);

  return (
    <div className="min-h-screen">
      <SiteNav user={user} />
      <main className="mx-auto max-w-6xl px-4 py-12">
        <div className="rise-in flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold tracking-[0.5em] text-[#af915f]">MODEL PLAZA</p>
            <h1 className="mt-2 text-4xl font-black"><span className="text-outline">模型广场</span></h1>
          </div>
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索模型名…"
            className="w-52 rounded-lg border border-border bg-[#101d2b] px-4 py-2 text-sm text-[#fce1b6] outline-none placeholder:text-muted-foreground/50 focus:border-[#af915f]"
          />
        </div>

        {/* 分组筛选 */}
        <div className="rise-in rise-in-1 mt-6 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setGroupName(null)}
            className={`rounded-lg border px-4 py-2 text-xs font-bold transition-colors ${
              group === null
                ? "border-[#FFB700] bg-[#FFB700] text-[#162638]"
                : "border-border bg-[#101d2b] text-muted-foreground hover:text-[#fce1b6]"
            }`}
          >
            全部分组
          </button>
          {groups.data?.map((g) => (
            <button
              key={g.id}
              onClick={() => setGroupName(g.name)}
              className={`rounded-lg border px-4 py-2 text-xs font-bold transition-colors ${
                group?.id === g.id
                  ? "border-[#FFB700] bg-[#FFB700] text-[#162638]"
                  : "border-border bg-[#101d2b] text-muted-foreground hover:text-[#fce1b6]"
              }`}
            >
              {g.name}
              <span className="font-num ml-1.5 opacity-70">×{Number(g.multiplier)}</span>
            </button>
          ))}
          {group && (
            <span className="text-xs text-muted-foreground">
              已按「{group.name}」倍率 ×{Number(group.multiplier)} 折算实际价格
            </span>
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-4 text-xs text-muted-foreground">
          <span>当前展示 <b className="font-num text-[#fce1b6]">{visible.length}</b> 个可用模型</span>
          <span>价格单位：美元 / 每百万 tokens</span>
          <span>停用渠道与停用模型会自动从广场隐藏</span>
        </div>

        {/* 模型卡片 */}
        <div className="rise-in rise-in-2 mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((m) => (
            <div key={m.id} className="rounded-xl border border-border bg-[#101d2b] p-6 transition-colors hover:border-[#af915f]/60">
              <div className="flex items-center justify-between gap-2">
                <p className="font-num truncate text-lg font-black text-[#FFB700]">{m.name}</p>
                <span className="shrink-0 rounded bg-[#176EFF]/15 px-2 py-0.5 text-[10px] font-bold text-[#7db4ff]">
                  {PROTO_LABEL[m.apiType] ?? m.apiType}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {m.upstreamName ? `${m.upstreamName} · ` : ""}{m.allowedGroups.trim() ? `限组：${m.allowedGroups}` : "全部分组可用"}
              </p>
              <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border text-center">
                {([
                  ["输入", price(m.priceInput)],
                  ["输出", price(m.priceOutput)],
                  ["写缓存", price(m.priceCacheWrite)],
                  ["读缓存", price(m.priceCacheRead)],
                ] as const).map(([label, v]) => (
                  <div key={label} className="bg-[#162638] px-2 py-2.5">
                    <p className="text-[10px] text-muted-foreground">{label}</p>
                    <p className={`font-num mt-0.5 text-sm font-bold ${v === null ? "text-[#00B77D]" : "text-[#fce1b6]"}`}>
                      {fmtPrice(v)}
                    </p>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-right text-[10px] text-muted-foreground">美元 / 每百万 tokens</p>
            </div>
          ))}
        </div>

        {!visible.length && (
          <p className="mt-16 text-center text-sm text-muted-foreground">
            {keyword ? "没有匹配的模型" : "该分组暂无可用模型"}
          </p>
        )}
      </main>
    </div>
  );
}
