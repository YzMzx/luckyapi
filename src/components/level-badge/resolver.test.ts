import { describe, expect, it } from "vitest";
import {
  normalizeBadgeRank,
  resolveBadgeSpec,
  resolveStageByLevel,
} from "./resolver";
import {
  badgeThemes,
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
    expect(resolveBadgeSpec({ level }).stage.id).toBe(id);
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
      expect(normalizeBadgeRank(input)).toBeNull();
      // Simulate a runtime caller that bypasses the TypeScript boundary.
      expect(
        resolveBadgeSpec({ level: 31, rank: input as BadgeRank })
      ).toMatchObject({ rank: null, title: "流云" });
    }
  );

  it("keeps the actual level at the last stage and cleans up invalid display levels", () => {
    expect(resolveBadgeSpec({ level: 999 }).level).toBe(999);
    expect(resolveBadgeSpec({ level: NaN }).level).toBe(1);
    expect(resolveBadgeSpec({ level: -1 }).level).toBe(1);
    expect(resolveBadgeSpec({ level: 10.9 }).level).toBe(10);
  });

  it("overrides the title without mutating the theme or leaking to later resolutions", () => {
    const input = { level: 51, rank: 2 } as const;
    const base = resolveBadgeSpec(input);
    expect(resolveBadgeSpec({ ...input, customTitle: "  云游  " })).toEqual({
      ...base,
      title: "云游",
    });
    expect(resolveBadgeSpec({ ...input, customTitle: " " })).toEqual(base);
    expect(resolveBadgeSpec(input).title).toBe("北斗天枢");
  });

  it("limits motion to the configured variants and preserves winner timing", () => {
    for (const [i, stage] of natureTheme.stages.entries()) {
      const level = 1 + i * 10;
      expect(resolveBadgeSpec({ level, rank: 1 }).motion).toEqual({
        kind: "slow-sweep",
        duration: "4s",
      });
      expect(resolveBadgeSpec({ level, rank: 3 }).motion.kind).toBe("none");
      if (stage.id !== "galaxy") {
        expect(resolveBadgeSpec({ level }).motion.kind).toBe("none");
        expect(resolveBadgeSpec({ level, rank: 2 }).motion.kind).toBe("none");
      }
    }
    expect(resolveBadgeSpec({ level: 51 }).motion).toEqual({
      kind: "breathe",
      duration: "6s",
    });
  });

  it("chooses a finish per variant and carries dark-mode colors through", () => {
    expect(
      ([null, 1, 2, 3] as const).map(
        rank => resolveBadgeSpec({ level: 51, rank }).motion.kind
      )
    ).toEqual(["breathe", "slow-sweep", "silver-sweep", "none"]);
    const moss = resolveBadgeSpec({ level: 1 });
    expect(moss.darkBackground).not.toBe(moss.background);
    expect(moss.darkTextColor).not.toBe(moss.textColor);
    const galaxy = resolveBadgeSpec({ level: 51, rank: 1 });
    expect(galaxy.darkBackground).toBe(galaxy.background);
    expect(galaxy.border).toContain("#FDE047, #C084FC, #60A5FA");
  });
});

describe("theme registry", () => {
  it("falls back for unknown themes, including property names", () => {
    expect(getBadgeTheme("toString")).toBe(natureTheme);
    expect(resolveBadgeSpec({ level: 11, themeId: "missing" }).themeId).toBe(
      "nature"
    );
  });

  it("registers a theme with sparse custom thresholds and a new SVG path", () => {
    const theme: BadgeThemeConfig = {
      ...natureTheme,
      id: "test-woodland",
      stages: [
        natureTheme.stages[0],
        { ...natureTheme.stages[1], minLevel: 4, icon: { path: "M2 6h8" } },
        natureTheme.stages[2],
      ],
    };
    registerBadgeTheme(theme);
    const resolve = (level: number) => resolveStageByLevel(level, theme.id);
    expect(resolve(3)).toBe(theme.stages[0]);
    expect(resolve(4)).toBe(theme.stages[1]);
    expect(resolve(20)).toBe(theme.stages[1]);
    expect(resolve(21)).toBe(theme.stages[2]);
    expect(
      resolveBadgeSpec({ level: 4, themeId: theme.id, rank: 1 })
    ).toMatchObject({
      themeId: theme.id,
      title: "雪山源泉",
      stage: { icon: { path: "M2 6h8" } },
    });
    registerBadgeTheme({ ...theme, name: "新版" });
    expect(badgeThemes.filter(item => item.id === theme.id)).toHaveLength(1);
    expect(getBadgeTheme(theme.id).name).toBe("新版");
    expect(resolveStageByLevel(4)).toBe(natureTheme.stages[0]);
  });

  it("rejects invalid thresholds before changing the registry", () => {
    const id = "test-invalid";
    expect(() =>
      registerBadgeTheme({
        ...natureTheme,
        id,
        stages: [
          natureTheme.stages[0],
          { ...natureTheme.stages[1], minLevel: 1 },
        ],
      })
    ).toThrow(RangeError);
    expect(badgeThemes.some(theme => theme.id === id)).toBe(false);
  });
});

function luminance(hex: string, canvas = "#FFFFFF", blackScrim = 0): number {
  const alpha = hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1;
  const channels = [1, 3, 5].map(i => {
    const top = parseInt(hex.slice(i, i + 2), 16);
    const below = parseInt(canvas.slice(i, i + 2), 16);
    const c = ((top * alpha + below * (1 - alpha)) / 255) * (1 - blackScrim);
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

it.each(["#FFFFFF", "#101D2B", "#000000"])(
  "keeps AA text contrast at every nature gradient stop on %s",
  canvas => {
    for (const [index, stage] of natureTheme.stages.entries()) {
      for (const rank of [null, 1, 2, 3] as const) {
        const spec = resolveBadgeSpec({ level: 1 + 10 * index, rank });
        const scrim =
          spec.scrim === "transparent"
            ? 0
            : Number(spec.scrim.match(/([\d.]+)\)$/)?.[1]);
        const dark = canvas !== "#FFFFFF";
        const fg = luminance(dark ? spec.darkTextColor : spec.textColor);
        const paint = dark ? spec.darkBackground : spec.background;
        const stops = paint.match(/#[a-f0-9]{6}(?:[a-f0-9]{2})?/gi) ?? [];
        expect(stops.length).toBeGreaterThanOrEqual(2);
        for (const stop of stops) {
          const bg = luminance(stop, canvas, scrim);
          expect(
            (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
            stage.name + "/" + spec.title
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  }
);
