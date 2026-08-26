import { describe, expect, it } from "vitest";
import { clearCookieHeader, cookieHeader, hashAdminPassword, requestUsesHttps, verifyAdminPassword } from "./auth";

describe("administrator credential security", () => {
  it("hashes new passwords and still accepts a legacy plaintext value for migration", () => {
    const hashed = hashAdminPassword("correct horse battery staple");
    expect(hashed).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(hashed).not.toContain("correct horse battery staple");
    expect(verifyAdminPassword("correct horse battery staple", hashed)).toBe(true);
    expect(verifyAdminPassword("wrong password", hashed)).toBe(false);
    expect(verifyAdminPassword("legacy-password", "legacy-password")).toBe(true);
  });

  it("marks only HTTPS cookies Secure and respects reverse-proxy protocol headers", () => {
    expect(requestUsesHttps(new Request("http://app:3000", { headers: { "x-forwarded-proto": "https" } }))).toBe(true);
    expect(requestUsesHttps(new Request("https://example.com"))).toBe(true);
    expect(requestUsesHttps(new Request("http://example.com"))).toBe(false);
    expect(cookieHeader("session", "token", 60, true)).toContain("; Secure");
    expect(clearCookieHeader("session", true)).toContain("; Secure");
    expect(cookieHeader("session", "token", 60, false)).not.toContain("; Secure");
  });
});
