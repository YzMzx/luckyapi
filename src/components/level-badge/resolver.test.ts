import { describe, expect, it } from "vitest";
import {
  normalizeBadgeRank,
  resolveBadgeSpec,
  resolveStageByLevel,
} from "./resolver";
import {
  listBadgeThemes,
  getBadgeTheme,
  natureTheme,
  registerBadgeTheme,
} from "./themes";
import type { BadgeRank, BadgeThemeConfig } from "./types";

describe("nature badge resolver", () => {
  it.each([
    [-1, "firefly"],
    [0, "firefly"],
    [1, "firefly"],
    [10, "firefly"],
    [11, "spring"],
    [20, "spring"],
    [21, "pine"],
    [30, "pine"],
    [31, "cloud"],
    [40, "cloud"],
    [41, "ocean"],
    [50, "ocean"],
    [51, "galaxy"],
    [999, "galaxy"],
  ] as const)("maps level %i to %s", (level, id) => {
    expect(resolveStageByLevel(level).id).toBe(id);
    expect(resolveBadgeSpec({ level }).stageId).toBe(id);
  });

  it.each([
    [1, "萤火", "破夜初萤", "林间星火", "微芒引路"],
    [11, "清泉", "雪山源泉", "听松鸣涧", "玉露清溪"],
    [21, "劲松", "凌云古松", "听涛苍柏", "青崖翠杉"],
    [31, "流云", "九天垂云", "归岫闲云", "晴空鹤影"],
    [41, "沧海", "东临沧海", "扶摇巨鲲", "潮生明月"],
    [51, "星河", "银河之心", "北斗天枢", "织梦星轨"],
  ] as const)("resolves all four titles at level %i", (level, ...titles) => {
    const ranks = [null, 1, 2, 3] as const;
    expect(ranks.map(rank => resolveBadgeSpec({ level, rank }).title)).toEqual(
      titles
    );
  });

  it.each([4, 0, -1, 1.2, "1", null, undefined, NaN])(
    "uses the base variant for rank %s",
    input => {
      expect(normalizeBadgeRank(input as number)).toBeNull();
      // Simulate a runtime caller that bypasses the TypeScript boundary.
      expect(
        resolveBadgeSpec({ level: 31, rank: input as BadgeRank })
      ).toMatchObject({ rank: null, title: "流云" });
    }
  );

  it("keeps the actual level at the last stage and cleans up invalid display levels", () => {
    expect(resolveBadgeSpec({ level: 999 }).normalizedLevel).toBe(999);
    expect(resolveBadgeSpec({ level: NaN }).normalizedLevel).toBe(1);
    expect(resolveBadgeSpec({ level: -1 }).normalizedLevel).toBe(1);
    expect(resolveBadgeSpec({ level: 10.9 }).normalizedLevel).toBe(10);
  });

  it("overrides the title without mutating the theme or leaking to later resolutions", () => {
    const input = { level: 51, rank: 2 } as const;
    const base = resolveBadgeSpec(input);
    expect(resolveBadgeSpec({ ...input, customTitle: "  云游  " })).toEqual({
      ...base,
      title: "云游",
      ariaLabel: "Lv.51 星河阶段第2名限定称号：云游",
    });
    expect(resolveBadgeSpec({ ...input, customTitle: " " })).toEqual(base);
    expect(resolveBadgeSpec(input).title).toBe("北斗天枢");
  });

  it("assigns the kit's eighteen distinct limited effects", () => {
    const effects = natureTheme.stages.flatMap(stage =>
      ([1, 2, 3] as const).map(
        rank => resolveBadgeSpec({ level: stage.minLevel, rank }).effect
      )
    );
    expect(new Set(effects).size).toBe(18);
    expect(effects).toContain("galaxy-supernova");
  });
  it("registers custom thresholds and falls back for unknown themes", () => {
    const theme: BadgeThemeConfig = {
      ...natureTheme,
      id: "test-kit",
      stages: [
        { ...natureTheme.stages[1], minLevel: 4, maxLevel: null },
        { ...natureTheme.stages[0], maxLevel: 3 },
      ],
    };
    registerBadgeTheme(theme);
    expect(resolveStageByLevel(3, theme.id).id).toBe("firefly");
    expect(resolveStageByLevel(4, theme.id).id).toBe("spring");
    expect(listBadgeThemes().some(t => t.id === theme.id)).toBe(true);
    expect(getBadgeTheme("unknown")).toBe(natureTheme);
  });
});
