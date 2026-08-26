import { describe, expect, it } from "vitest";
import { mergeVideoSession, monotonicWatchedSeconds, type VideoSessionProgress } from "../src/lib/video-reward-state";
import { requestBalanceRefresh, subscribeBalanceRefresh } from "../src/lib/balance-sync";

const session = (overrides: Partial<VideoSessionProgress> = {}): VideoSessionProgress => ({
  id: 1,
  sessionToken: "token-1",
  status: "active",
  watchedMs: 0,
  watchedSeconds: 0,
  lastSequence: 0,
  ready: false,
  ...overrides,
});

describe("realtime balance and video progress state", () => {
  it("drops out-of-order heartbeats and never regresses confirmed or displayed progress", () => {
    const newest = session({ watchedMs: 8_400, watchedSeconds: 8, lastSequence: 8 });
    const stale = session({ watchedMs: 2_100, watchedSeconds: 2, lastSequence: 2 });
    expect(mergeVideoSession(newest, stale)).toBe(newest);
    expect(mergeVideoSession(newest, session({ watchedMs: 7_900, watchedSeconds: 7, lastSequence: 9 })))
      .toMatchObject({ watchedMs: 8_400, watchedSeconds: 8, lastSequence: 9 });
    expect(mergeVideoSession(newest, session({ status: "expired", sessionToken: undefined, lastSequence: 9 })))
      .toMatchObject({ status: "expired", sessionToken: undefined, watchedSeconds: 8 });
    expect(monotonicWatchedSeconds(9.5, 3, 15)).toBe(9.5);
    expect(monotonicWatchedSeconds(9.5, 12, 15)).toBe(12);
    expect(monotonicWatchedSeconds(16, 15, 15)).toBe(15);
  });

  it("resets only for a genuinely new session and coalesces balance refresh bursts", async () => {
    const old = session({ watchedMs: 12_000, watchedSeconds: 12, lastSequence: 12 });
    const next = session({ id: 2, sessionToken: "token-2" });
    expect(mergeVideoSession(old, next)).toBe(next);

    let refreshes = 0;
    const unsubscribe = subscribeBalanceRefresh(() => { refreshes += 1; });
    requestBalanceRefresh();
    requestBalanceRefresh();
    requestBalanceRefresh();
    await Promise.resolve();
    unsubscribe();
    expect(refreshes).toBe(1);
  });
});
