import "./LevelBadge.css";
import React from 'react';
import type { BadgeSize } from './types';
import { resolveBadgeSpec, buildBadgeStyleVars } from './resolver';
import { STAGE_ICON_PATHS, RANK_ICON_PATHS } from './icons';

export interface LevelBadgeProps {
  /** User level (auto-maps to 6 stages: 1-10, 11-20, 21-30, 31-40, 41-50, 51+) */
  level: number;
  /** Optional Top-3 stage rank (1, 2, or 3) to upgrade into limited badge */
  rank?: 1 | 2 | 3 | number | null;
  /** Registered theme id (defaults to 'nature') */
  theme?: string;
  /** Visual density preset */
  size?: BadgeSize;
  /** Display "Lv.xx" prefix (default: true) */
  showLevel?: boolean;
  /** Display "No.01 / No.02 / No.03" stamp on limited badges (default: true) */
  showRankStamp?: boolean;
  /** Enable stage+rank bespoke animations (default: true) */
  animated?: boolean;
  /** Override badge title while preserving stage/rank visual style */
  customTitle?: string;
  /** Custom icon node overriding built-in SVG stage/rank icon */
  icon?: React.ReactNode;
  /** Hide built-in icon completely */
  hideIcon?: boolean;
  className?: string;
  style?: React.CSSProperties & { [token: `--lb-${string}`]: string | number | undefined };
}

export const LevelBadge: React.FC<LevelBadgeProps> = ({
  level,
  rank = null,
  theme = 'nature',
  size = 'md',
  showLevel = true,
  showRankStamp = true,
  animated = true,
  customTitle,
  icon,
  hideIcon = false,
  className = '',
  style,
}) => {
  const spec = resolveBadgeSpec({
    level,
    rank,
    themeId: theme,
    customTitle,
  });

  const cssVars = buildBadgeStyleVars(spec) as React.CSSProperties;
  const iconPath = spec.rank
    ? RANK_ICON_PATHS[spec.rank]
    : (STAGE_ICON_PATHS[spec.icon] ?? STAGE_ICON_PATHS.firefly);

  return (
    <span
      role="status"
      aria-label={spec.ariaLabel}
      title={spec.ariaLabel}
      className={className ? `lb-badge ${className}` : 'lb-badge'}
      data-theme-id={spec.themeId}
      data-stage={spec.stageId}
      data-rank={spec.rank ?? undefined}
      data-tier={spec.tier ?? undefined}
      data-surface={spec.surface}
      data-size={size}
      data-effect={spec.effect}
      data-texture={spec.texture}
      data-animated={animated ? 'true' : 'false'}
      style={{ ...cssVars, ...style }}
    >
      <span className="lb-pulse" aria-hidden="true" />
      <span className="lb-border-orbit" aria-hidden="true" />
      <span className="lb-fx-clip" aria-hidden="true">
        <span className="lb-texture" />
        <span className="lb-layer-a" />
        <span className="lb-layer-b" />
        <span className="lb-sweep" />
        <span className="lb-particles">
          <i className="lb-p lb-p1" />
          <i className="lb-p lb-p2" />
          <i className="lb-p lb-p3" />
          <i className="lb-p lb-p4" />
        </span>
      </span>

      {!hideIcon && (
        <span className="lb-icon" aria-hidden="true">
          {icon ?? (
            <svg
              className="lb-icon-svg"
              viewBox="0 0 16 16"
              width="1em"
              height="1em"
              focusable="false"
              dangerouslySetInnerHTML={{ __html: iconPath }}
            />
          )}
        </span>
      )}

      {showLevel && <span className="lb-level">Lv.{spec.normalizedLevel}</span>}
      <span className="lb-title">{spec.title}</span>
      {showRankStamp && spec.stamp && <span className="lb-stamp">{spec.stamp}</span>}
    </span>
  );
};

export default LevelBadge;
