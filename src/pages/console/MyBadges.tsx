import { Link } from "react-router";
import { ConsoleLayout } from "@/components/ConsoleLayout";
import { OwnedBadgeCollection } from "@/components/OwnedBadgeCollection";
import { useMe } from "@/hooks/useMe";
import { trpc } from "@/providers/trpc";

export default function MyBadges() {
  const { user } = useMe({ requireAuth: true, requireOnboarded: true });
  const profile = trpc.levels.profile.useQuery(undefined, {
    enabled: !!user?.onboarded,
  });
  if (!user?.onboarded)
    return (
      <p role="status" className="p-8 text-muted-foreground">
        正在加载会员资料…
      </p>
    );
  return (
    <ConsoleLayout
      user={user}
      title="我的铭牌"
      desc="查看收藏，选择要在榜单上展示的铭牌。"
    >
      <section
        data-theme="dark"
        className="rounded-xl border border-border bg-[#101d2b] p-5 sm:p-8"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="t-section">
            已拥有的铭牌{profile.data && `（${profile.data.badges.length}）`}
          </h2>
          <Link
            to="/console/badges"
            className="text-sm underline underline-offset-4"
          >
            铭牌殿堂
          </Link>
        </div>
        {profile.data ? (
          <OwnedBadgeCollection data={profile.data} />
        ) : profile.isError ? (
          <p role="alert" className="mt-4 text-sm">
            铭牌加载失败。
            <button
              type="button"
              onClick={() => void profile.refetch()}
              className="underline"
            >
              重试
            </button>
          </p>
        ) : (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            正在加载铭牌…
          </p>
        )}
      </section>
    </ConsoleLayout>
  );
}
