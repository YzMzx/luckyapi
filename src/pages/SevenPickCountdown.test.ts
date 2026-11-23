import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { SevenPickCountdown } from "./SevenPickCountdown";

const opensAt = Date.parse("2026-11-23T20:00:00+08:00");
const round = {
  opensAt,
  closesAt: opensAt + 10 * 60_000,
  drawAt: opensAt + 20 * 60_000,
};
type Status = Parameters<typeof SevenPickCountdown>[0]["round"]["status"];

function render(status: Status, now: number, serverOffset = 0) {
  vi.spyOn(Date, "now").mockReturnValue(now);
  return renderToStaticMarkup(
    createElement(SevenPickCountdown, {
      round: { ...round, status },
      serverOffset,
    })
  );
}

afterEach(() => vi.restoreAllMocks());

it("shows a labeled empty progress bar until the round opens", () => {
  const html = render("scheduled", opensAt - 30_000);
  expect(html).toContain("距离开盘");
  expect(html).toContain(">00:00:30</span>");
  expect(html).toContain("开奖倒计时");
  expect(html).toContain(">00:20:30</span>");
  expect(html).toMatch(
    /<progress aria-labelledby="[^"]+"[^>]*value="0" max="1200000"/
  );
});

it("uses server-adjusted time and keeps the closing countdown distinct", () => {
  const html = render("open", opensAt - 60_000, 6 * 60_000);
  expect(html).toContain("距离封盘");
  expect(html).toContain(">00:05:00</span>");
  expect(html).toContain(">00:15:00</span>");
  expect(html).toContain('value="300000" max="1200000"');
});

it("continues after sealing and switches to waiting at the target instead of declaring a result", () => {
  const sealed = render("sealed", round.drawAt - 1);
  expect(sealed).toContain(">00:00:01</span>");
  expect(sealed).not.toContain("距离封盘");
  const waiting = render("ots_waiting", round.drawAt + 60_000);
  expect(waiting).toContain('value="1200000" max="1200000"');
  expect(waiting).toContain("已到目标开奖时间，等待验签及开奖结果。");
  expect(waiting).not.toContain('role="timer"');
});

it.each([
  "settled",
  "refunded",
  "review",
  "risk_skipped",
  "refunding",
] as const)("does not display a countdown in %s", status => {
  expect(render(status, round.drawAt)).toBe("");
});
