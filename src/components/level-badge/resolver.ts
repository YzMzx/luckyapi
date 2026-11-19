import { getBadgeTheme, getStageMinLevel } from "./themes/registry";
import type {
  BadgeRank,
  BadgeStageConfig,
  BadgeThemeConfig,
  ResolveBadgeInput,
  ResolvedBadgeSpec,
} from "./types";

export function normalizeBadgeRank(value: unknown): BadgeRank | null {
  return value === 1 || value === 2 || value === 3 ? value : null;
}

function normalizeLevel(level: number): number {
  return Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
}

function stageForLevel(
  level: number,
  theme: BadgeThemeConfig
): BadgeStageConfig {
  const { stages } = theme;
  for (let i = stages.length - 1; i > 0; i--) {
    if (level >= getStageMinLevel(stages[i], i)) return stages[i];
  }
  return stages[0];
}

export function resolveStageByLevel(
  level: number,
  themeId?: string
): BadgeStageConfig {
  return stageForLevel(normalizeLevel(level), getBadgeTheme(themeId));
}

export function resolveBadgeSpec({
  level,
  rank,
  themeId,
  customTitle,
}: ResolveBadgeInput): ResolvedBadgeSpec {
  const theme = getBadgeTheme(themeId);
  const normalizedLevel = normalizeLevel(level);
  const stage = stageForLevel(normalizedLevel, theme);
  const place = normalizeBadgeRank(rank);
  const variant = place === null ? stage.base : stage.ranks[place];
  return {
    ...variant,
    themeId: theme.id,
    level: normalizedLevel,
    rank: place,
    stage,
    title: customTitle?.trim() || variant.title,
    darkBackground: variant.darkBackground ?? variant.background,
    darkBorder: variant.darkBorder ?? variant.border,
    darkTextColor: variant.darkTextColor ?? variant.textColor,
    effect: variant.effect ?? stage.effect,
    motion: variant.motion ?? { kind: "none", duration: "0s" },
    scrim: variant.scrim ?? "transparent",
  };
}
