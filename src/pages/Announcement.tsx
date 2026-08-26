import { Link, useParams } from "react-router";
import { Megaphone } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { useMe } from "@/hooks/useMe";
import { SiteNav } from "@/components/SiteNav";

const SEVERITY = {
  urgent: { label: "紧急", cls: "border-[#EF5459]/60 bg-[#EF5459]/10 text-[#EF5459]" },
  important: { label: "重要", cls: "border-[#FFB700]/60 bg-[#FFB700]/10 text-[#FFB700]" },
  info: { label: "公告", cls: "border-[#af915f]/50 text-[#af915f]" },
} as const;

/** 公告详情：与首页公告卡一致的等级徽章与排版 */
export default function Announcement() {
  const { user } = useMe({ requireAuth: true, requireOnboarded: true });
  const { id } = useParams();
  const announcement = trpc.entertainment.announcement.useQuery(
    { id: Number(id) },
    { enabled: Number.isInteger(Number(id)) && Number(id) > 0 },
  );

  return (
    <div className="min-h-screen">
      <SiteNav user={user} />
      <main className="mx-auto max-w-3xl px-4 py-14">
        <Link to="/" className="text-sm font-bold text-[#FFB700] hover:underline">← 返回首页</Link>
        {announcement.isLoading && <p className="mt-8 text-sm text-muted-foreground">加载公告中…</p>}
        {announcement.error && (
          <div className="rise-in mt-8 rounded-xl border border-[#EF5459]/50 bg-[#101d2b] p-6 text-center">
            <p className="text-sm font-bold text-[#EF5459]">{announcement.error.message}</p>
            <p className="mt-2 text-xs text-muted-foreground">公告可能已撤回或下线</p>
          </div>
        )}
        {announcement.data && (
          <article className="rise-in mt-8 rounded-2xl border border-border bg-[#101d2b] p-6 sm:p-10">
            <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
              <span className={`rounded-full border px-3 py-1 ${SEVERITY[announcement.data.severity].cls}`}>
                {SEVERITY[announcement.data.severity].label}
              </span>
              {announcement.data.pinned && (
                <span className="rounded-full border border-[#FFB700]/50 px-3 py-1 text-[#FFB700]">置顶</span>
              )}
            </div>
            <h1 className="mt-5 text-2xl font-black leading-snug text-[#fce1b6] sm:text-3xl">{announcement.data.title}</h1>
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Megaphone className="h-3.5 w-3.5 text-[#af915f]" />
              发布于 {announcement.data.publishedAt ? new Date(announcement.data.publishedAt).toLocaleString("zh-CN") : "—"}
            </p>
            <div className="mt-6 border-t border-border pt-6">
              <div className="whitespace-pre-wrap break-words text-sm leading-8 text-[#fce1b6]/90">{announcement.data.content}</div>
            </div>
          </article>
        )}
      </main>
    </div>
  );
}
