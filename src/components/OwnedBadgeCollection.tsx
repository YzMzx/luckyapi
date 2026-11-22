import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { LevelBadge } from "./level-badge/LevelBadge";
import { normalizeBadgeRank, resolveBadgeSpec } from "./level-badge/resolver";

export function OwnedBadgeCollection({
  data,
}: {
  data: inferRouterOutputs<AppRouter>["levels"]["profile"];
}) {
  const utils = trpc.useUtils();
  const equip = trpc.levels.equip.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.levels.profile.invalidate(),
        utils.rankings.query.invalidate(),
        utils.duel.leaderboard.invalidate(),
        utils.finance.creditLeaderboard.invalidate(),
        utils.finance.loanVolumeLeaderboard.invalidate(),
      ]);
    },
    onError: error => toast.error(error.message),
  });
  const equipped = data.badges.find(
    badge => badge.level === data.equippedLevel
  );
  return (
    <>
      <div className="my-3 flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">榜单当前展示</span>
        <LevelBadge
          level={equipped?.level ?? data.progress.level}
          rank={equipped?.rank}
          size="sm"
        />
        {!equipped && (
          <span className="text-xs text-muted-foreground">默认等级铭牌</span>
        )}
      </div>
      {data.badges.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          暂无铭牌。每个阶段的前三位达成者可获得限定铭牌。
        </p>
      ) : (
        <div>
          <ul className="mt-3 grid gap-4">
            {data.badges.map(badge => {
              const rank = normalizeBadgeRank(badge.rank);
              const spec = resolveBadgeSpec({ level: badge.level, rank });
              const equipped = data.equippedLevel === badge.level;
              return (
                <li
                  key={badge.level}
                  className="flex flex-wrap items-center justify-between gap-3 rounded border border-border/70 bg-[#0d1926] p-3"
                >
                  <LevelBadge level={badge.level} rank={rank} size="sm" />
                  <button
                    type="button"
                    disabled={equip.isPending}
                    aria-pressed={equipped}
                    aria-label={
                      (equipped ? "摘下" : "佩戴") + spec.title + "铭牌"
                    }
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
        </div>
      )}
    </>
  );
}
