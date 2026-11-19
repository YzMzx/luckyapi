const STAGE_LEVELS = [10, 20, 30, 40, 50] as const;
export const STAGE_META = [
  { code: "IGNITION", caption: "点燃第一束星光", motion: "星火彗星" },
  { code: "TRAJECTORY", caption: "让足迹成为轨迹", motion: "双星环游" },
  { code: "CONSTELLATION", caption: "把未知连成星图", motion: "星图织绘" },
  { code: "CORONATION", caption: "以坚持加冕热爱", motion: "紫晶加冕" },
  { code: "ZENITH", caption: "抵达群星之巅", motion: "至臻日冕" },
] as const;

export function getStageIndex(level: number) {
  return STAGE_LEVELS.indexOf(level as (typeof STAGE_LEVELS)[number]);
}

export function getStageMeta(level: number) {
  const index = getStageIndex(level);
  return STAGE_META[index < 0 ? 0 : index];
}
