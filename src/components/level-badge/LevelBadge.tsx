import type { CSSProperties } from "react";
import { BadgeGlyph } from "./BadgeGlyph";
import { BadgeTexture } from "./BadgeTexture";
import { resolveBadgeSpec } from "./resolver";
import type { LevelBadgeProps } from "./types";
import "./LevelBadge.css";

export function LevelBadge({
  level,
  rank,
  theme = "nature",
  size = "md",
  showLevel = true,
  showRankStamp = true,
  animated = true,
  customTitle,
  icon,
  className,
  style,
}: LevelBadgeProps) {
  const spec = resolveBadgeSpec({ level, rank, themeId: theme, customTitle });
  const place = spec.rank === null ? "" : `第${spec.rank}名限定`;
  const label = `Lv.${spec.level} ${spec.stage.name}阶段${place}称号：${spec.title}`;
  // Only private defaults are set inline. Public --badge-* tokens can
  // be inherited from a container or set by a caller's className or style.
  const tokens = {
    "--lb-light-surface": spec.background,
    "--lb-dark-surface": spec.darkBackground,
    "--lb-light-edge": spec.border,
    "--lb-dark-edge": spec.darkBorder,
    "--lb-light-ink": spec.textColor,
    "--lb-dark-ink": spec.darkTextColor,
    "--lb-spec-scrim": spec.scrim,
    "--lb-spec-duration": spec.motion.duration,
    ...style,
  } as CSSProperties;

  return (
    <span
      className={["level-badge", className].filter(Boolean).join(" ")}
      role="img"
      aria-label={label}
      data-size={size}
      data-stage={spec.stage.id}
      data-badge-theme={spec.themeId}
      data-rank={spec.rank ?? "base"}
      data-effect={spec.effect}
      data-motion={spec.motion.kind}
      data-animated={animated}
      style={tokens}
    >
      <span className="level-badge__finish" aria-hidden="true">
        {spec.texture !== "none" && <BadgeTexture texture={spec.texture} />}
        {animated && spec.motion.kind !== "none" && (
          <span className="level-badge__motion" />
        )}
      </span>
      <span className="level-badge__glyph" aria-hidden="true">
        {icon ?? <BadgeGlyph icon={spec.stage.icon} />}
        {spec.rank === 1 && (
          <svg
            className="level-badge__crown"
            viewBox="0 0 16 10"
            fill="currentColor"
            aria-hidden="true"
            focusable="false"
          >
            <path d="m1 3 4 2L8 0l3 5 4-2-2 6H3Z" />
          </svg>
        )}
      </span>
      {showLevel && (
        <span className="level-badge__level" aria-hidden="true">
          Lv.{spec.level}
        </span>
      )}
      <span className="level-badge__title" aria-hidden="true">
        {spec.title}
      </span>
      {showRankStamp && spec.rank !== null && (
        <span className="level-badge__stamp" aria-hidden="true">
          No.0{spec.rank}
        </span>
      )}
    </span>
  );
}
