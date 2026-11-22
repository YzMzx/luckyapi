import { LEVEL_STAGES, getLevelThreshold } from "@contracts/levels";
import { LevelBadge } from "@/components/level-badge/LevelBadge";
import { trpc } from "@/providers/trpc";

const awardDate = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "long",
  timeZone: "Asia/Shanghai",
});

export function LevelExhibit() {
  const hall = trpc.levels.hall.useQuery();
  return (
    <section aria-labelledby="level-seats-heading" className="space-y-5">
      <h2 id="level-seats-heading" className="t-section">
        等级铭牌 · 首达席位
      </h2>
      {hall.data ? (
        LEVEL_STAGES.map(({ level, name }) => {
          const seats = hall.data.filter(entry => entry.level === level);
          return (
            <section
              className="overflow-hidden rounded-2xl border border-border bg-[#101d2b] shadow-lg"
              key={level}
            >
              <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-gradient-to-r from-[#203448] to-[#101d2b] px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="font-black text-[#fce1b6]">{name}</h3>
                  <LevelBadge level={level} size="sm" animated={false} />
                </div>
                <p className="text-xs text-muted-foreground">
                  累计 {getLevelThreshold(level).toLocaleString("zh-CN")} EXP ·
                  已授予 {seats.length} / 3 席
                </p>
              </header>
              <ol className="hall-seat-grid p-4 sm:p-5">
                {([1, 2, 3] as const).map(rank => {
                  const seat = seats.find(entry => entry.rank === rank);
                  return (
                    <li
                      key={rank}
                      className={
                        seat
                          ? "flex min-w-0 flex-col items-start gap-2 rounded-xl border border-[#af915f]/40 bg-[#1d2c3a] p-4"
                          : "flex min-w-0 flex-col items-start gap-2 rounded-xl border border-dashed border-border p-4"
                      }
                    >
                      <LevelBadge
                        level={level}
                        rank={rank}
                        size="sm"
                        animated={false}
                      />
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
                          席位待授予
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
    </section>
  );
}
