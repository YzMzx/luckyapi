const STAGE_LEVELS = [10, 20, 30, 40, 50] as const;
export const STAGE_META = [
  { code: "IGNITION", caption: "点燃第一束星光" },
  { code: "TRAJECTORY", caption: "让足迹成为轨迹" },
  { code: "CONSTELLATION", caption: "把未知连成星图" },
  { code: "CORONATION", caption: "以坚持加冕热爱" },
  { code: "ZENITH", caption: "抵达群星之巅" },
] as const;

export function getStageIndex(level: number) {
  return STAGE_LEVELS.indexOf(level as (typeof STAGE_LEVELS)[number]);
}

export function getStageMeta(level: number) {
  const index = getStageIndex(level);
  return STAGE_META[index < 0 ? 0 : index];
}
