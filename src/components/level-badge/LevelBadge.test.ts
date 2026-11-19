import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LevelBadge } from "./LevelBadge";
import type { LevelBadgeProps } from "./types";

const render = (props: LevelBadgeProps) =>
  renderToStaticMarkup(createElement(LevelBadge, props));

it("renders a readable limited title, level and separate serial on the server", () => {
  const html = render({ level: 45, rank: 1 });
  expect(html).toContain('aria-label="Lv.45 沧海阶段第1名限定称号：东临沧海"');
  expect(html).toContain(">Lv.45<");
  expect(html).toContain(">东临沧海<");
  expect(html).toContain(">No.01<");
  expect(render({ level: 45 })).not.toContain("No.0");
});

it("preserves semantics when a compact consumer overrides the title and icon", () => {
  const html = render({
    level: 45,
    rank: 2,
    size: "xs",
    showLevel: false,
    showRankStamp: false,
    animated: false,
    customTitle: "同行者",
    icon: createElement("i", { className: "custom-icon" }),
    className: "profile-mark",
    style: { "--lb-radius": "8px" },
  });
  expect(html).toContain('aria-label="Lv.45 沧海阶段第2名限定称号：同行者"');
  expect(html).not.toContain(">Lv.45<");
  expect(html).not.toContain("No.02");
  expect(html).toContain("custom-icon");
  expect(html).toContain("profile-mark");
  expect(html).toContain("--lb-radius:8px");
});
