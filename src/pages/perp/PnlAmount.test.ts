import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PnlAmount } from "./PnlAmount";

it.each([
  [1234, "text-emerald-300", "+1.234 模拟金"],
  [-1234, "text-rose-300", "-1.234 模拟金"],
  [-0, "text-muted-foreground", "0 模拟金"],
  [null, "text-muted-foreground", "待估值"],
  [NaN, "text-muted-foreground", "待估值"],
] as const)(
  "gives %s both a clear text value and a consistent tone",
  (units, tone, label) => {
    const html = renderToStaticMarkup(
      createElement(PnlAmount, { units, showUnit: true })
    );
    expect(html).toContain(tone);
    expect(html).toContain(">" + label + "</span>");
  }
);
