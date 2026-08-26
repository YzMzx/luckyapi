import { describe, expect, it } from "vitest";
import { sanitizeAccountId, sanitizeMoneyInput, transferInputProblem } from "@/lib/finance-input";

describe("finance transfer input", () => {
  it("cleans account IDs and decimal amounts", () => {
    expect(sanitizeAccountId(" 12ab-34 ")).toBe("1234");
    expect(sanitizeAccountId("1".repeat(40))).toHaveLength(32);
    expect(sanitizeMoneyInput("$0012.3456789")).toBe("12.345678");
    expect(sanitizeMoneyInput(".5")).toBe("0.5");
    expect(sanitizeMoneyInput("1e3")).toBe("1");
  });

  it("uses input validity rather than lookup state", () => {
    expect(transferInputProblem("123456", "0.000001")).toBeNull();
    expect(transferInputProblem("123456", "0")).toContain("大于 0");
    expect(transferInputProblem("123456", "1.0000001")).toContain("6 位");
    expect(transferInputProblem("12ab", "1")).toContain("纯数字");
  });
});
