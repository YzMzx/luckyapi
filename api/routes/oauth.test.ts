import { describe, expect, it } from "vitest";
import {
  isTrustedOrigin,
  trustedCandidateOrigin,
  normalizeConfiguredOrigin,
  resolveRequestOrigin,
  safeReturnTo,
  validPendingState,
} from "./oauth.js";

describe("OAuth trusted origin normalization", () => {
  it("keeps only an http(s) origin", () => {
    expect(normalizeConfiguredOrigin("https://entry-a.example.com/path?q=1")).toBe("https://entry-a.example.com");
    expect(normalizeConfiguredOrigin("http://localhost:3000/anything")).toBe("http://localhost:3000");
  });

  it("rejects unsafe schemes and malformed values", () => {
    expect(normalizeConfiguredOrigin("javascript:alert(1)")).toBe("");
    expect(normalizeConfiguredOrigin("not a url")).toBe("");
    expect(normalizeConfiguredOrigin(undefined)).toBe("");
  });
});

describe("OAuth entry selection", () => {
  const origin = "https://entry.example.com";

  it("uses only the one exact configured origin", () => {
    expect(isTrustedOrigin(origin, origin)).toBe(true);
    expect(isTrustedOrigin("https://evil.example.com", origin)).toBe(false);
    expect(isTrustedOrigin("https://entry.example.com.evil.test", origin)).toBe(false);
    expect(isTrustedOrigin("http://entry.example.com", origin)).toBe(false);
  });

  it("accepts an explicitly supplied browser origin when a proxy replaced Host", () => {
    expect(trustedCandidateOrigin(
      ["http://app:3000", origin],
      origin,
    )).toBe(origin);
    expect(trustedCandidateOrigin(
      ["http://app:3000", "https://evil.example.com"],
      origin,
    )).toBeNull();
  });
});

describe("OAuth request origin behind a reverse proxy", () => {
  it("uses the forwarded protocol with the regular Host when X-Forwarded-Host is absent", () => {
    expect(resolveRequestOrigin("http://lucky.example.com/api/oauth/login", undefined, "https"))
      .toBe("https://lucky.example.com");
  });

  it("uses the first forwarded host and protocol from a proxy chain", () => {
    expect(resolveRequestOrigin(
      "http://app:3000/api/oauth/login",
      "lucky.example.com, edge.internal",
      "https, http",
    )).toBe("https://lucky.example.com");
  });

  it("preserves the existing HTTPS default when only X-Forwarded-Host is available", () => {
    expect(resolveRequestOrigin(
      "http://app:3000/api/oauth/login",
      "lucky.example.com",
    )).toBe("https://lucky.example.com");
  });

  it("falls back to the request URL when forwarding headers are absent or invalid", () => {
    expect(resolveRequestOrigin("http://localhost:3000/api/oauth/login"))
      .toBe("http://localhost:3000");
    expect(resolveRequestOrigin("http://localhost:3000/api/oauth/login", undefined, "javascript"))
      .toBe("http://localhost:3000");
    expect(resolveRequestOrigin("http://localhost:3000/api/oauth/login", "bad host value", "https"))
      .toBe("http://localhost:3000");
  });
});

describe("OAuth callback state binding", () => {
  const now = 1_800_000_000_000;
  const pending = { createdAt: now, origin: "https://entry.example.com", returnTo: "/draw" };

  it("accepts only the still-configured origin within the TTL", () => {
    expect(validPendingState(pending, pending.origin, now + 60_000)).toBe(true);
    expect(validPendingState(pending, "https://other.example.com", now + 60_000)).toBe(false);
    expect(validPendingState(pending, pending.origin, now + 10 * 60_000 + 1)).toBe(false);
    expect(validPendingState(undefined, pending.origin, now)).toBe(false);
  });
});

describe("OAuth returnTo validation", () => {
  it("allows local absolute paths", () => {
    expect(safeReturnTo("/draw?tab=mine")).toBe("/draw?tab=mine");
  });

  it("rejects open redirects and header/path confusion", () => {
    expect(safeReturnTo("https://evil.example.com")).toBe("/draw");
    expect(safeReturnTo("//evil.example.com")).toBe("/draw");
    expect(safeReturnTo("/\\evil.example.com")).toBe("/draw");
    expect(safeReturnTo("/draw\r\nLocation: https://evil.example.com")).toBe("/draw");
  });
});
