import { Check, CircleDashed, LockKeyhole, Sparkles } from "lucide-react";
import { LEVEL_STAGES, getLevelThreshold } from "@contracts/levels";
import { ConsoleLayout } from "@/components/ConsoleLayout";
import { StagePlate } from "@/components/StagePlate";
import { getStageMeta } from "@/components/stageMeta";
import { useMe } from "@/hooks/useMe";
import { trpc } from "@/providers/trpc";
import "./BadgeHall.css";

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
      desc="穿越五段星海旅程，收藏首批抵达者的限定坐标。"
    >
      <div className="badge-hall">
        <header className="badge-hall-intro">
          <div>
            <p className="badge-hall-eyebrow">
              <Sparkles aria-hidden="true" />
              THE CELESTIAL ARCHIVE
            </p>
            <h2>每一段旅程，都有独特坐标。</h2>
            <p>五款阶段铭牌，三种首发席位。编号随获得顺序永久铭刻。</p>
          </div>
          <div className="badge-hall-legend">
            <span>
              <i className="badge-hall-legend-stage" />
              阶段铭牌
            </span>
            <span>
              <i className="badge-hall-legend-limited" />
              首发限定
            </span>
          </div>
        </header>

        {!hall.data ? (
          <p role="status" className="text-sm text-muted-foreground">
            {hall.isError ? (
              <>
                席位加载失败。{" "}
                <button
                  type="button"
                  onClick={() => void hall.refetch()}
                  className="underline"
                >
                  重试
                </button>
              </>
            ) : (
              "正在加载星海坐标…"
            )}
          </p>
        ) : (
          <div className="badge-hall-stages">
            {LEVEL_STAGES.map((stage, index) => {
              const meta = getStageMeta(stage.level);
              const occupied = hall.data.filter(
                entry => entry.level === stage.level
              ).length;
              return (
                <section
                  className={`badge-stage badge-stage-${index + 1}`}
                  key={stage.level}
                  aria-labelledby={`badge-stage-${stage.level}`}
                >
                  <span className="badge-stage-watermark" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="badge-stage-heading">
                    <div className="badge-stage-identity">
                      <span className="badge-stage-index">0{index + 1}</span>
                      <div>
                        <p>{meta.code}</p>
                        <h3 id={`badge-stage-${stage.level}`}>
                          {stage.name} <span>· Lv.{stage.level}</span>
                        </h3>
                        <p className="badge-stage-caption">{meta.caption}</p>
                      </div>
                    </div>
                    <div className="badge-stage-requirement">
                      <span>UNLOCK AT</span>
                      <strong>
                        {getLevelThreshold(stage.level).toLocaleString()}{" "}
                        <small>EXP</small>
                      </strong>
                    </div>
                  </div>

                  <div className="badge-stage-showcase">
                    <div className="badge-stage-standard">
                      <div className="badge-stage-specimen">
                        <StagePlate {...stage} />
                      </div>
                      <p>
                        <span>01</span>阶段铭牌{" "}
                        <small>抵达对应等级即可解锁</small>
                      </p>
                    </div>
                    <div className="badge-stage-limited-specimen">
                      <div className="badge-stage-specimen">
                        <StagePlate {...stage} rank={1} />
                      </div>
                      <p>
                        <Sparkles aria-hidden="true" />
                        <span>02</span>首发限定{" "}
                        <small>{meta.motion} · 仅每阶段前 3 位</small>
                      </p>
                    </div>
                  </div>

                  <div className="badge-stage-roster">
                    <div className="badge-stage-roster-title">
                      <h4>
                        FIRST ARRIVALS <span>首批抵达者</span>
                      </h4>
                      <span>{occupied} / 3 已铭刻</span>
                    </div>
                    <ol>
                      {[1, 2, 3].map(rank => {
                        const seat = hall.data.find(
                          entry =>
                            entry.level === stage.level && entry.rank === rank
                        );
                        return (
                          <li
                            key={rank}
                            className={seat ? "is-occupied" : "is-vacant"}
                          >
                            <span className="badge-seat-rank">
                              {String(rank).padStart(2, "0")}
                            </span>
                            <span
                              className="badge-seat-icon"
                              aria-hidden="true"
                            >
                              {seat ? (
                                <Check />
                              ) : rank <= occupied + 1 ? (
                                <CircleDashed />
                              ) : (
                                <LockKeyhole />
                              )}
                            </span>
                            <div className="badge-seat-owner">
                              {seat ? (
                                <>
                                  <strong>{seat.userName}</strong>
                                  <time
                                    dateTime={new Date(
                                      seat.awardedAt
                                    ).toISOString()}
                                  >
                                    {awardDate.format(seat.awardedAt)}
                                  </time>
                                </>
                              ) : (
                                <>
                                  <strong>
                                    {rank === occupied + 1
                                      ? "等待下一位抵达者"
                                      : "席位尚未开放"}
                                  </strong>
                                  <span>NO.{rank} · UNCLAIMED</span>
                                </>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </ConsoleLayout>
  );
}
