import type { BadgeStageConfig, BadgeThemeConfig } from "../types";
import { natureTheme } from "./nature";

const themes: BadgeThemeConfig[] = [natureTheme];
export const badgeThemes: readonly BadgeThemeConfig[] = themes;

export function getStageMinLevel(
  stage: BadgeStageConfig,
  index: number
): number {
  return stage.minLevel ?? 1 + index * 10;
}

/** Register during app setup. Re-registering an id replaces the previous config. */
export function registerBadgeTheme(theme: BadgeThemeConfig): void {
  if (!theme.id.trim() || !theme.stages.length) {
    throw new Error("徽章主题需要标识和至少一个阶段");
  }
  let previous = 0;
  for (const [index, stage] of theme.stages.entries()) {
    const min = getStageMinLevel(stage, index);
    if (!Number.isSafeInteger(min) || min <= previous) {
      throw new RangeError("徽章等级阈值必须是严格递增的正整数");
    }
    previous = min;
  }
  const index = themes.findIndex(item => item.id === theme.id);
  if (index === -1) themes.push(theme);
  else themes[index] = theme;
}

export function getBadgeTheme(themeId?: string): BadgeThemeConfig {
  return themes.find(theme => theme.id === themeId) ?? themes[0];
}
