import { Link } from "react-router";
import { OwnedBadgeCollection } from "./OwnedBadgeCollection";
import {
  DAILY_CHECKIN_EXP,
  EXP_PER_USD,
  LEVEL_STAGES,
  getLevelThreshold,
} from "@contracts/levels";
import { trpc } from "@/providers/trpc";
import { LevelBadge } from "./level-badge/LevelBadge";

export function MemberLevel() {
  const profile = trpc.levels.profile.useQuery();
  const data = profile.data;
  const next =
    data && LEVEL_STAGES.find(stage => stage.level > data.progress.level);
  return (
    <section
      data-theme="dark"
      className="rounded-xl border border-border bg-[#101d2b] p-5 sm:p-8"
    >
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
            <LevelBadge level={data.progress.level} size="lg" />
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
                  距下一次限定席位授予等级 Lv.{next.level} 还差{" "}
                  {(
                    getLevelThreshold(next.level) - data.progress.totalExp
                  ).toLocaleString()}{" "}
                  EXP
                </p>
              )}
            </div>
          )}
          <h3 className="mt-5 text-sm font-bold">如何获得经验</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>
              每日签到获得 {DAILY_CHECKIN_EXP} EXP，签到所得 USD 另计收益经验。
            </li>
            <li>每获得 1 USD 净收益，增加 {EXP_PER_USD.income} EXP。</li>
            <li>
              API Key 每实际消耗 1 USD，增加 {EXP_PER_USD.api_usage} EXP。
            </li>
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            不足 1 EXP 的部分会保留，凑满后计入等级。
          </p>
          <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
            <h3 className="text-sm font-bold">我的限定铭牌</h3>
            <Link
              to="/console/my-badges"
              className="text-sm underline underline-offset-4"
            >
              查看我的铭牌
            </Link>
          </div>
          <OwnedBadgeCollection data={data} />
        </>
      )}
    </section>
  );
}
