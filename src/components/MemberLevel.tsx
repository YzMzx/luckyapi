import { Link } from "react-router";
import { toast } from "sonner";
import { LEVEL_STAGES, getLevelThreshold } from "@contracts/levels";
import { trpc } from "@/providers/trpc";
import { StagePlate } from "./StagePlate";

export function MemberLevel() {
  const profile = trpc.levels.profile.useQuery();
  const utils = trpc.useUtils();
  const equip = trpc.levels.equip.useMutation({
    onSuccess: async () => {
      await utils.levels.profile.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const data = profile.data;
  const next =
    data && LEVEL_STAGES.find(stage => stage.level > data.progress.level);
  const title =
    data &&
    LEVEL_STAGES.filter(stage => stage.level <= data.progress.level).at(-1);
  return (
    <section className="rounded-xl border border-border bg-[#101d2b] p-5 sm:p-8">
      <div className="flex items-center justify-between gap-3">
        <h2 className="t-section">个人等级</h2>
        <Link
          to="/console/badges"
          className="text-sm text-[#fce1b6] underline underline-offset-4"
        >
          铭牌殿堂
        </Link>
      </div>
      {!data ? (
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          {profile.isError ? (
            <>
              等级加载失败。
              <button
                type="button"
                onClick={() => void profile.refetch()}
                className="underline"
              >
                重试
              </button>
            </>
          ) : (
            "正在加载等级…"
          )}
        </p>
      ) : (
        <>
          <div className="mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <strong className="font-num text-4xl text-[#FFB700]">
              Lv.{data.progress.level}
            </strong>
            {title && (
              <span className="font-bold text-[#fce1b6]">{title.name}</span>
            )}
            <span className="text-sm text-muted-foreground">
              累计 {data.progress.totalExp.toLocaleString()} EXP
            </span>
          </div>
          {data.progress.requiredExp == null ? (
            <p className="mt-3 text-sm">已满级</p>
          ) : (
            <div className="mt-3 space-y-1">
              <p className="text-sm">
                本级经验 {data.progress.currentExp.toLocaleString()} /{" "}
                {data.progress.requiredExp.toLocaleString()} EXP
              </p>
              <progress
                aria-label="本级经验"
                value={data.progress.currentExp}
                max={data.progress.requiredExp}
                className="w-full accent-amber-400"
              />
              {next && (
                <p className="text-xs text-muted-foreground">
                  距 Lv.{next.level}「{next.name}」还差{" "}
                  {(
                    getLevelThreshold(next.level) - data.progress.totalExp
                  ).toLocaleString()}{" "}
                  EXP
                </p>
              )}
            </div>
          )}
          <h3 className="mt-5 border-t border-border pt-4 text-sm font-bold">
            我的限定铭牌
          </h3>
          {data.badges.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              暂无铭牌。每个阶段的前三位达成者可获得限定铭牌。
            </p>
          ) : (
            <ul className="mt-3 flex flex-wrap gap-3">
              {data.badges.map(badge => {
                const stage = LEVEL_STAGES.find(
                  item => item.level === badge.level
                );
                if (!stage) return null;
                const equipped = data.equippedLevel === badge.level;
                return (
                  <li
                    key={badge.level}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <StagePlate {...stage} rank={badge.rank} />
                    <button
                      type="button"
                      disabled={equip.isPending}
                      aria-pressed={equipped}
                      aria-label={"佩戴" + stage.name + "铭牌"}
                      onClick={() =>
                        equip.mutate({ level: equipped ? null : badge.level })
                      }
                      className="rounded border border-border px-3 py-2 text-xs text-[#fce1b6] hover:border-amber-400 disabled:opacity-50"
                    >
                      {equipped ? "已佩戴 · 摘下" : "佩戴"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
