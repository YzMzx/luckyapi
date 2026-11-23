import { afterEach, expect, it, vi } from "vitest";
import { sevenPickLaunchReady } from "./release";

afterEach(() => vi.unstubAllEnvs());

it("requires explicit production enablement without a separate proof file", () => {
  vi.stubEnv("SEVEN_PICK_ENABLED", "");
  expect(sevenPickLaunchReady()).toBe(false);
  vi.stubEnv("SEVEN_PICK_ENABLED", "true");
  expect(sevenPickLaunchReady()).toBe(false);
  vi.stubEnv("SEVEN_PICK_ENABLED", "1");
  expect(sevenPickLaunchReady()).toBe(true);
  vi.stubEnv("SEVEN_PICK_ENABLED", "0");
  expect(sevenPickLaunchReady()).toBe(false);
});
