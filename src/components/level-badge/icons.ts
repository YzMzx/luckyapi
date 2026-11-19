export const STAGE_ICON_PATHS: Record<string, string> = {
  firefly:
    '<circle cx="8" cy="8" r="2.3" fill="currentColor"/><path d="M8 2.2v2M8 11.8v2M2.2 8h2M11.8 8h2M4.1 4.1l1.3 1.3M10.6 10.6l1.3 1.3M11.9 4.1l-1.3 1.3M5.4 10.6l-1.3 1.3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>',
  spring:
    '<path d="M8 2.2C8 2.2 3.8 6.9 3.8 10a4.2 4.2 0 0 0 8.4 0C12.2 6.9 8 2.2 8 2.2Z" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/><path d="M6.4 10.2c0 1 .7 1.7 1.6 1.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  pine:
    '<path d="M8 2.1 4.4 7h2.1L3.6 11.2h8.8L9.5 7h2.1L8 2.1Z" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/><path d="M8 11.2v2.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  cloud:
    '<path d="M4.8 12h6.8a2.5 2.5 0 0 0 .3-4.98A3.6 3.6 0 0 0 5 6.3 2.8 2.8 0 0 0 4.8 12Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  ocean:
    '<path d="M2 7.2c1.2-1.2 2.4-1.2 3.6 0s2.4 1.2 3.6 0 2.4-1.2 3.6 0c.5.5.8.7 1.2.8" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/><path d="M2 10.8c1.2-1.2 2.4-1.2 3.6 0s2.4 1.2 3.6 0 2.4-1.2 3.6 0c.5.5.8.7 1.2.8" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/>',
  galaxy:
    '<path d="M8 1.8 9.5 6.5 14.2 8 9.5 9.5 8 14.2 6.5 9.5 1.8 8 6.5 6.5 8 1.8Z" fill="currentColor"/><circle cx="12.6" cy="3.6" r="0.9" fill="currentColor" opacity="0.85"/><circle cx="3.4" cy="12.4" r="0.75" fill="currentColor" opacity="0.75"/>',
};

export const RANK_ICON_PATHS: Record<1 | 2 | 3, string> = {
  1: '<path d="M2.6 11.5 3.6 5.2 6.5 7.7 8 3.6 9.5 7.7 12.4 5.2 13.4 11.5H2.6Z" fill="currentColor"/><rect x="3.1" y="12.4" width="9.8" height="1.3" rx="0.65" fill="currentColor"/>',
  2: '<path d="M8 2.3 12.8 5.1v5.8L8 13.7 3.2 10.9V5.1L8 2.3Z" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/><path d="M8 5.1 9.1 7.2 11.2 8 9.1 8.8 8 10.9 6.9 8.8 4.8 8 6.9 7.2 8 5.1Z" fill="currentColor"/>',
  3: '<path d="M8 2.5 13 8 8 13.5 3 8 8 2.5Z" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.7" fill="currentColor"/>',
};

export function renderIconSvg(iconName: string, rank: 1 | 2 | 3 | null = null): string {
  const path = rank ? RANK_ICON_PATHS[rank] : (STAGE_ICON_PATHS[iconName] ?? STAGE_ICON_PATHS.firefly);
  return `<svg class="lb-icon-svg" viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true" focusable="false">${path}</svg>`;
}
