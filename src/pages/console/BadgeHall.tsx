import { Link } from "react-router";
import { LEVEL_STAGES, getLevelThreshold } from "@contracts/levels";
import { ConsoleLayout } from "@/components/ConsoleLayout";
import { LevelBadge } from "@/components/level-badge/LevelBadge";
import { useMe } from "@/hooks/useMe";
import { trpc } from "@/providers/trpc";

const awardDate = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "long",
  timeZone: "Asia/Shanghai",
});

export default function BadgeHall() {
  const { user } = useMe({ requireAuth: true, requireOnboarded: true });
  const hall = trpc.levels.hall.useQuery(undefined, {
    enabled: !!user?.onboarded,
  });
  if (!user?.onboarded)
    return (
      <p role="status" className="p-8">
        加载中…
      </p>
    );

  return (
    <ConsoleLayout
      user={user}
      title="铭牌殿堂"
      desc="查看等级里程碑的前三位抵达者与永久席位。"
    >
      <div className="space-y-5" data-theme="dark">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="t-section">首达席位</h2>
          <Link
            to="/badges"
            className="text-sm text-[#fce1b6] underline underline-offset-4"
          >
            浏览全部 24 款徽章 →
          </Link>
        </div>
        {hall.data ? (
          LEVEL_STAGES.map(({ level }) => {
            const seats = hall.data.filter(entry => entry.level === level);
            return (
              <section
                className="rounded-xl border border-border bg-card p-4 sm:p-6"
                key={level}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3>
                    <LevelBadge level={level} size="lg" />
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {getLevelThreshold(level).toLocaleString()} EXP ·{" "}
                    {seats.length} / 3 席已授予
                  </p>
                </div>
                <ol className="mt-4 grid gap-3 xl:grid-cols-3">
                  {([1, 2, 3] as const).map(rank => {
                    const seat = seats.find(entry => entry.rank === rank);
                    return (
                      <li
                        key={rank}
                        className="flex flex-col items-start gap-2 rounded-lg border border-border bg-[#101d2b] p-3"
                      >
                        <LevelBadge level={level} rank={rank} size="sm" />
                        {seat ? (
                          <>
                            <strong className="break-all text-sm">
                              {seat.userName}
                            </strong>
                            <time
                              className="text-xs text-muted-foreground"
                              dateTime={new Date(seat.awardedAt).toISOString()}
                            >
                              {awardDate.format(seat.awardedAt)}
                            </time>
                          </>
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            席位待领取
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </section>
            );
          })
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {hall.isError ? (
              <>
                席位加载失败。{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => void hall.refetch()}
                >
                  重试
                </button>
              </>
            ) : (
              "正在加载首达席位…"
            )}
          </p>
        )}
      </div>
    </ConsoleLayout>
  );
}
