import type {
  BadgeRank,
  BadgeStageConfig,
  ResolveBadgeOptions,
  ResolvedBadgeSpec,
} from './types';
import { DEFAULT_THEME_ID, getBadgeTheme } from './themes/registry';

export function normalizeLevel(level: number): number {
  if (!Number.isFinite(level) || level < 1) {
    return 1;
  }
  return Math.floor(level);
}

export function normalizeRank(rank?: number | null): BadgeRank | null {
  if (rank === 1 || rank === 2 || rank === 3) {
    return rank;
  }
  return null;
}

export function resolveStageByLevel(
  level: number,
  themeId: string = DEFAULT_THEME_ID
): BadgeStageConfig {
  const theme = getBadgeTheme(themeId);
  const safeLevel = normalizeLevel(level);

  for (const stage of theme.stages) {
    const withinMin = safeLevel >= stage.minLevel;
    const withinMax = stage.maxLevel === null || safeLevel <= stage.maxLevel;
    if (withinMin && withinMax) {
      return stage;
    }
  }

  return safeLevel < theme.stages[0].minLevel
    ? theme.stages[0]
    : theme.stages[theme.stages.length - 1];
}

export function resolveBadgeSpec(options: ResolveBadgeOptions): ResolvedBadgeSpec {
  const theme = getBadgeTheme(options.themeId ?? DEFAULT_THEME_ID);
  const safeLevel = normalizeLevel(options.level);
  const safeRank = normalizeRank(options.rank);
  const stage = resolveStageByLevel(safeLevel, theme.id);

  const rankKey = safeRank ? (String(safeRank) as '1' | '2' | '3') : null;
  const rankSpec = rankKey ? stage.ranks[rankKey] : null;
  const activeSpec = rankSpec ?? stage.regular;

  const title = options.customTitle?.trim() ? options.customTitle.trim() : activeSpec.title;
  const ariaLabel = rankSpec
    ? `Lv.${safeLevel} ${stage.title}阶段第${rankSpec.rank}名限定称号：${title}`
    : `Lv.${safeLevel} ${stage.title}阶段称号：${title}`;

  return {
    themeId: theme.id,
    stageId: stage.id,
    stageIndex: stage.index,
    stageLabel: stage.label,
    stageTitle: stage.title,
    level: options.level,
    normalizedLevel: safeLevel,
    rank: safeRank,
    isLimited: Boolean(rankSpec),
    stamp: rankSpec ? rankSpec.stamp : null,
    tier: rankSpec ? rankSpec.tier : null,
    title,
    icon: stage.icon,
    surface: activeSpec.surface,
    effect: activeSpec.effect,
    texture: activeSpec.texture,
    tokens: {
      light: activeSpec.light,
      dark: activeSpec.dark,
    },
    ariaLabel,
  };
}

export function buildBadgeStyleVars(spec: ResolvedBadgeSpec): Record<string, string> {
  const { light, dark } = spec.tokens;
  const vars: Record<string, string> = {
    '--lb-bg-light': light.bg,
    '--lb-border-light': light.border,
    '--lb-text-light': light.text,
    '--lb-accent-light': light.accent,
    '--lb-glow-light': light.glow,

    '--lb-bg-dark': dark.bg,
    '--lb-border-dark': dark.border,
    '--lb-text-dark': dark.text,
    '--lb-accent-dark': dark.accent,
    '--lb-glow-dark': dark.glow,
  };

  if (light.sweepColor) vars['--lb-sweep-color-light'] = light.sweepColor;
  if (dark.sweepColor) vars['--lb-sweep-color-dark'] = dark.sweepColor;
  if (light.pulseColor) vars['--lb-pulse-color-light'] = light.pulseColor;
  if (dark.pulseColor) vars['--lb-pulse-color-dark'] = dark.pulseColor;
  if (light.orbitColor) vars['--lb-orbit-color-light'] = light.orbitColor;
  if (dark.orbitColor) vars['--lb-orbit-color-dark'] = dark.orbitColor;
  if (light.fxColor) vars['--lb-fx-color-light'] = light.fxColor;
  if (dark.fxColor) vars['--lb-fx-color-dark'] = dark.fxColor;

  return vars;
}

export { normalizeRank as normalizeBadgeRank };
