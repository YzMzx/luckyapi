import type { DisplayLevelBadge } from "@contracts/levels";
import { LevelBadge } from "./level-badge/LevelBadge";
import { cn } from "@/lib/utils";

export function RankingBadge({ badge }: { badge: DisplayLevelBadge }) {
  return (
    <LevelBadge
      level={badge.level}
      rank={badge.rank}
      size="xs"
      animated={false}
    />
  );
}

export function RankingIdentity({
  name,
  badge,
  className,
}: {
  name: string;
  badge: DisplayLevelBadge;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full flex-col items-start gap-1",
        className
      )}
    >
      <span className="max-w-full truncate" title={name}>
        {name}
      </span>
      <RankingBadge badge={badge} />
    </span>
  );
}
