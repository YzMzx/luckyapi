import { describe, expect, it } from "vitest";
import { bodyForLog, extractUsageFromJson } from "./gateway";

describe("gateway cache usage detection", () => {
  it("redacts compound credential keys before persisting request bodies", () => {
    const logged = bodyForLog(JSON.stringify({ access_token: "secret-a", client_secret: "secret-b", nested: { api_key: "secret-c" }, max_tokens: 20 }));
    expect(logged).not.toContain("secret-a");
    expect(logged).not.toContain("secret-b");
    expect(logged).not.toContain("secret-c");
    expect(logged).toContain('"max_tokens":20');
  });
  it("marks an explicitly reported zero cache count as a miss", () => {
    const detected = extractUsageFromJson({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    }, "chat");
    expect(detected?.cacheStatus).toBe("miss");
    expect(detected?.source).toBe("upstream");
  });

  it("keeps cache state unknown when the upstream omits cache metadata", () => {
    const detected = extractUsageFromJson({
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }, "chat");
    expect(detected?.cacheStatus).toBe("unknown");
  });

  it("normalizes Claude cache reads and marks a hit", () => {
    const detected = extractUsageFromJson({
      usage: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 4 },
    }, "claude");
    expect(detected?.cacheStatus).toBe("hit");
    expect(detected?.usage).toEqual({
      promptTokens: 24,
      completionTokens: 8,
      cacheWriteTokens: 0,
      cacheReadTokens: 4,
    });
  });

  it("reads Gemini cached-content tokens", () => {
    const detected = extractUsageFromJson({
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, cachedContentTokenCount: 2 },
    }, "gemini");
    expect(detected?.cacheStatus).toBe("hit");
    expect(detected?.usage.cacheReadTokens).toBe(2);
  });
});
