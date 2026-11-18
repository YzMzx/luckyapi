import { LEVEL_STAGES, getLevelThreshold } from "@contracts/levels";
import { ConsoleLayout } from "@/components/ConsoleLayout";
import { StagePlate } from "@/components/StagePlate";
import { useMe } from "@/hooks/useMe";
import { trpc } from "@/providers/trpc";

const awardDate = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "Asia/Shanghai",
});

export default function BadgeHall() {
  const { user } = useMe({ requireAuth: true, requireOnboarded: true });
  const hall = trpc.levels.hall.useQuery(undefined, {
    enabled: !!user?.onboarded,
  });
  if (!user?.onboarded)
    return (
      <div role="status" className="p-8 text-muted-foreground">
        加载中…
      </div>
    );
  return (
    <ConsoleLayout
      user={user}
      title="铭牌殿堂"
      desc="每个阶段的前三位达成者获得专属编号铭牌。"
    >
      {!hall.data ? (
        <p role="status" className="text-sm text-muted-foreground">
          {hall.isError ? (
            <>
              席位加载失败。
              <button
                type="button"
                onClick={() => void hall.refetch()}
                className="underline"
              >
                重试
              </button>
            </>
          ) : (
            "正在加载席位…"
          )}
        </p>
      ) : (
        <div className="space-y-4">
          {LEVEL_STAGES.map(stage => (
            <section
              key={stage.level}
              className="rounded-xl border border-border bg-[#101d2b] p-5 sm:p-6"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2>
                  <StagePlate {...stage} />
                </h2>
                <p className="text-sm text-muted-foreground">
                  <strong className="mr-2 font-num text-[#fce1b6]">
                    Lv.{stage.level}
                  </strong>
                  累计 {getLevelThreshold(stage.level).toLocaleString()} EXP
                </p>
              </div>
              <ol className="mt-4 grid gap-2 sm:grid-cols-3">
                {[1, 2, 3].map(rank => {
                  const seat = hall.data.find(
                    entry => entry.level === stage.level && entry.rank === rank
                  );
                  return (
                    <li
                      key={rank}
                      className="min-w-0 rounded-lg border border-border bg-[#162638] p-3"
                    >
                      {seat ? (
                        <StagePlate {...stage} rank={seat.rank} />
                      ) : (
                        <span className="font-num text-xs text-[#d7b580]">
                          No.{rank}
                        </span>
                      )}
                      {seat ? (
                        <>
                          <p className="mt-1 break-all font-bold">
                            {seat.userName}
                          </p>
                          <time
                            className="text-xs text-muted-foreground"
                            dateTime={new Date(seat.awardedAt).toISOString()}
                          >
                            {awardDate.format(seat.awardedAt)}
                          </time>
                        </>
                      ) : (
                        <p className="mt-1 text-sm text-muted-foreground">
                          虚位以待
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </ConsoleLayout>
  );
}
