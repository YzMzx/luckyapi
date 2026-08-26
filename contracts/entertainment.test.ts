import { describe, expect, it } from "vitest";
import { businessDayInfo, sanitizeAnnouncementText, validateWeightedRewards } from "./entertainment";

describe("entertainment contracts", () => {
  it("computes configured business-day boundaries", () => {
    const before = businessDayInfo(new Date("2026-08-19T19:59:59.999Z"), 480, 4);
    const after = businessDayInfo(new Date("2026-08-19T20:00:00.000Z"), 480, 4);
    expect(before.key).toBe("2026-08-19");
    expect(before.startsAt.toISOString()).toBe("2026-08-18T20:00:00.000Z");
    expect(after.key).toBe("2026-08-20");
  });

  it("validates probability totals and filters active content", () => {
    expect(() => validateWeightedRewards([{ rewardUnits: 100, probabilityPpm: 999_999 }], 100, 500)).toThrow("100%");
    expect(sanitizeAnnouncementText("<script>bad</script>通知", 20)).toBe("bad通知");
  });
});
