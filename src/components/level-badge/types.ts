import type { CSSProperties, ReactNode } from "react";

export type BadgeRank = 1 | 2 | 3;
export type BadgeSize = "xs" | "sm" | "md" | "lg";
export type NatureIconId =
  "firefly" | "spring" | "pine" | "cloud" | "ocean" | "galaxy";
export type BadgeIcon =
  NatureIconId | { readonly path: string; readonly viewBox?: string };
export type BadgeEffect = "none" | "highlight" | "matte" | "glow" | "glaze";
export interface BadgeMotion {
  readonly kind: "none" | "breathe" | "slow-sweep" | "silver-sweep";
  readonly duration: string;
}
export type BadgeTexture =
  | "none"
  | "firefly-dots"
  | "mist"
  | "warm-tail"
  | "ice-crystals"
  | "ripples"
  | "dewdrops"
  | "gold-threads"
  | "brushed"
  | "rock-strata"
  | "gold-cloud"
  | "soft-fog"
  | "feathers"
  | "gold-flecks"
  | "streamlines"
  | "moonlight"
  | "stardust"
  | "constellation"
  | "orbits";

export interface BadgeVariantConfig {
  readonly title: string;
  /** CSS background images, including a solid border represented by two identical stops. */
  readonly background: string;
  readonly border: string;
  readonly textColor: string;
  readonly darkBackground?: string;
  readonly darkBorder?: string;
  readonly darkTextColor?: string;
  readonly texture: BadgeTexture;
  /** Override the stage finish for this variant. */
  readonly effect?: BadgeEffect;
  readonly motion?: BadgeMotion;
  /** Optional tint over a gradient whose brightest stop needs extra text contrast. */
  readonly scrim?: string;
}

export interface BadgeStageConfig {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: BadgeIcon;
  /** Inclusive lower bound. Defaults to 1, 11, 21, … by position. */
  readonly minLevel?: number;
  readonly effect: BadgeEffect;
  readonly base: BadgeVariantConfig;
  readonly ranks: Readonly<Record<BadgeRank, BadgeVariantConfig>>;
}

export interface BadgeThemeConfig {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Stages in ascending order of their effective minimum level. */
  readonly stages: readonly [BadgeStageConfig, ...BadgeStageConfig[]];
}

export interface ResolveBadgeInput {
  readonly level: number;
  readonly rank?: BadgeRank | null;
  readonly themeId?: string;
  readonly customTitle?: string;
}

export interface ResolvedBadgeSpec extends BadgeVariantConfig {
  readonly level: number;
  readonly rank: BadgeRank | null;
  readonly themeId: string;
  readonly stage: BadgeStageConfig;
  readonly effect: BadgeEffect;
  readonly scrim: string;
  readonly motion: BadgeMotion;
  readonly darkBackground: string;
  readonly darkBorder: string;
  readonly darkTextColor: string;
}

export type BadgeStyle = CSSProperties & {
  [token: `--badge-${string}`]: string | number | undefined;
};

export interface LevelBadgeProps {
  level: number;
  rank?: BadgeRank | null;
  theme?: string;
  size?: BadgeSize;
  showLevel?: boolean;
  showRankStamp?: boolean;
  animated?: boolean;
  customTitle?: string;
  icon?: ReactNode;
  className?: string;
  style?: BadgeStyle;
}
