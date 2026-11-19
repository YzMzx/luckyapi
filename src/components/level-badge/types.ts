export type BadgeRank = 1 | 2 | 3;

export type BadgeSize = 'xs' | 'sm' | 'md' | 'lg';

export type BadgeSurface = 'light' | 'dark';

export type BadgeEffect =
  | 'none'
  | 'hover-glint'
  | 'breathe'
  | 'firefly-swarm'
  | 'silver-twinkle'
  | 'beacon-pulse'
  | 'glacier-prism'
  | 'water-ripple'
  | 'dew-glint'
  | 'pine-goldflow'
  | 'silver-sheen'
  | 'bronze-breath'
  | 'cloud-aurora'
  | 'mist-drift'
  | 'feather-glide'
  | 'ocean-tide'
  | 'current-glide'
  | 'moon-tide'
  | 'galaxy-supernova'
  | 'constellation-pulse'
  | 'orbit-shimmer';

export type BadgeTexture =
  | 'none'
  | 'top-sheen'
  | 'pine-grain'
  | 'firefly-dots'
  | 'brushed'
  | 'tail-glow'
  | 'crystal'
  | 'ripple'
  | 'glass'
  | 'rings'
  | 'stone'
  | 'cloud-mist'
  | 'feather'
  | 'wave'
  | 'wave-gold'
  | 'moon-halo'
  | 'stardust'
  | 'constellation'
  | 'orbit';

export type RankTier = 'gold' | 'silver' | 'bronze' | 'prismatic';

export interface BadgeColorTokens {
  bg: string;
  border: string;
  text: string;
  accent: string;
  glow: string;
  sweepColor?: string;
  pulseColor?: string;
  orbitColor?: string;
  fxColor?: string;
}

export interface BadgeVariantSpec {
  title: string;
  surface: BadgeSurface;
  effect: BadgeEffect;
  texture: BadgeTexture;
  light: BadgeColorTokens;
  dark: BadgeColorTokens;
}

export interface BadgeRankSpec extends BadgeVariantSpec {
  rank: BadgeRank;
  stamp: string;
  tier: RankTier;
}

export interface BadgeStageConfig {
  id: string;
  index: number;
  minLevel: number;
  maxLevel: number | null;
  label: string;
  title: string;
  imagery: string;
  icon: string;
  surface: BadgeSurface;
  regular: BadgeVariantSpec;
  ranks: Record<'1' | '2' | '3', BadgeRankSpec>;
}

export interface BadgeThemeConfig {
  id: string;
  name: string;
  description?: string;
  stages: BadgeStageConfig[];
}

export interface ResolveBadgeOptions {
  level: number;
  rank?: number | null;
  themeId?: string;
  customTitle?: string;
}

export interface ResolvedBadgeSpec {
  themeId: string;
  stageId: string;
  stageIndex: number;
  stageLabel: string;
  stageTitle: string;
  level: number;
  normalizedLevel: number;
  rank: BadgeRank | null;
  isLimited: boolean;
  stamp: string | null;
  tier: RankTier | null;
  title: string;
  icon: string;
  surface: BadgeSurface;
  effect: BadgeEffect;
  texture: BadgeTexture;
  tokens: {
    light: BadgeColorTokens;
    dark: BadgeColorTokens;
  };
  ariaLabel: string;
}

export type { LevelBadgeProps } from "./LevelBadge";
