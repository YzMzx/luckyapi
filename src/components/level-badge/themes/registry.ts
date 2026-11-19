import type { BadgeThemeConfig } from '../types';
import { NATURE_THEME } from './nature';

const themeRegistry = new Map<string, BadgeThemeConfig>([
  [NATURE_THEME.id, NATURE_THEME],
]);

export const DEFAULT_THEME_ID = NATURE_THEME.id;

export function registerBadgeTheme(theme: BadgeThemeConfig): void {
  if (!theme || !theme.id || !Array.isArray(theme.stages) || theme.stages.length === 0) {
    throw new Error('Invalid badge theme: requires non-empty id and at least one stage.');
  }
  const sortedStages = [...theme.stages].sort((a, b) => a.minLevel - b.minLevel);
  themeRegistry.set(theme.id, { ...theme, stages: sortedStages });
}

export function getBadgeTheme(themeId: string = DEFAULT_THEME_ID): BadgeThemeConfig {
  return themeRegistry.get(themeId) ?? themeRegistry.get(DEFAULT_THEME_ID) ?? NATURE_THEME;
}

export function listBadgeThemes(): BadgeThemeConfig[] {
  return Array.from(themeRegistry.values());
}

export function hasBadgeTheme(themeId: string): boolean {
  return themeRegistry.has(themeId);
}
