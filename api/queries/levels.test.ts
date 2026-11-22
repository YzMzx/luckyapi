import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let directory: string;
async function open() {
  vi.resetModules();
  const { getDb } = await import("./connection");
  return {
    db: getDb(),
    sqlite: getDb().$client,
    ...(await import("./levels")),
  };
}
let api: Awaited<ReturnType<typeof open>>;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "lucky-levels-"));
  vi.stubEnv("SQLITE_PATH", join(directory, "levels.db"));
  api = await open();
  const insert = api.sqlite.prepare(
    "INSERT INTO users (linuxdo_id, username, group_name) VALUES (?, ?, ?)"
  );
  for (let id = 1; id <= 4; id++)
    insert.run(String(id), "login" + id, "成员" + id);
});
afterEach(() => {
  if (api?.sqlite.open) api.sqlite.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("upgrades a populated pre-level database and preserves awards, deduplication and equipment on restart", async () => {
  api.sqlite.exec(
    "DROP TABLE level_badges; DROP TABLE experience_events; DROP TABLE level_profiles"
  );
  api.sqlite.close();
  api = await open();
  expect(api.getLevelProfile(1)).toEqual({
    progress: { level: 1, totalExp: 0, currentExp: 0, requiredExp: 80 },
    badges: [],
    equippedLevel: null,
  });
  expect(api.getLevelHall()).toEqual([]);
  expect(api.grantExperience(1, "game:1", 7979)).toBe(true);
  expect(api.getLevelHall()).toEqual([]);
  api.grantExperience(1, "game:2", 1);
  expect(api.getLevelHall()).toEqual([
    { level: 10, rank: 1, userName: "成员1", awardedAt: expect.any(Number) },
  ]);
  api.equipLevelBadge(1, 10);
  const profile = api.getLevelProfile(1);
  expect(profile.equippedLevel).toBe(10);
  api.sqlite.close();
  api = await open();
  expect(api.grantExperience(1, "game:2", 1)).toBe(false);
  expect(api.getLevelProfile(1)).toEqual(profile);
  expect(() => api.grantExperience(1, "game:2", 2)).toThrow();
  expect(() => api.equipLevelBadge(2, 10)).toThrow(
    expect.objectContaining({ code: "FORBIDDEN" })
  );
  api.equipLevelBadge(1, null);
  expect(api.getLevelProfile(1).equippedLevel).toBeNull();
});

it("preserves old grants and carries fractional income and usage across restarts and retries", async () => {
  api.grantExperience(1, "old", 79);
  api.sqlite.exec(
    "ALTER TABLE level_profiles DROP COLUMN exp_remainder; ALTER TABLE experience_events DROP COLUMN usd_units"
  );
  api.sqlite.close();
  api = await open();
  expect(api.grantExperience(1, "old", 79)).toBe(false);
  const award = (key: string, usd: number, source: "income" | "api_usage") =>
    api.db.transaction(tx => api.awardUsdExperience(tx, 1, key, usd, source));
  expect(award("a", 0.006, "income")).toBe(true); // +0.6 EXP
  expect(api.getLevelProfile(1).progress.totalExp).toBe(79);
  api.sqlite.close();
  api = await open();
  expect(award("a", 0.006, "income")).toBe(false);
  expect(() => award("a", 0.005, "income")).toThrow("同一事件的经验值不一致");
  expect(award("b", 0.04, "api_usage")).toBe(true); // +0.4 EXP
  expect(api.getLevelProfile(1).progress).toMatchObject({
    totalExp: 80,
    level: 2,
  });
  expect(award("b", 0.04, "api_usage")).toBe(false);
  expect(api.getLevelProfile(1).progress.totalExp).toBe(80);
});

it("rolls back a failed award, allows retry, and rejects invalid or overflowing grants", () => {
  for (const amount of [0, -1, 0.5, Infinity, NaN])
    expect(() => api.grantExperience(1, "invalid", amount)).toThrow();
  expect(() => api.grantExperience(1, " ", 1)).toThrow();
  expect(() => api.grantExperience(99, "event", 1)).toThrow();
  api.sqlite.exec(
    "CREATE TRIGGER interrupt_badge BEFORE INSERT ON level_badges WHEN NEW.level = 20 BEGIN SELECT RAISE(ABORT, 'failure'); END"
  );
  expect(() => api.grantExperience(1, "game:1", 678980)).toThrow();
  expect(api.getLevelHall()).toEqual([]);
  expect(api.getLevelProfile(1).progress.totalExp).toBe(0);
  api.sqlite.exec("DROP TRIGGER interrupt_badge");
  expect(api.grantExperience(1, "game:1", 678980)).toBe(true);
  expect(api.getLevelProfile(1).progress.level).toBe(51);
  expect(api.getLevelProfile(1).badges.map(badge => badge.level)).toEqual([
    10, 20, 30, 40, 50,
  ]);
  expect(() =>
    api.grantExperience(1, "overflow", Number.MAX_SAFE_INTEGER)
  ).toThrow();
  expect(api.grantExperience(1, "overflow", 1)).toBe(true);
});

it("serializes simultaneous grants from independent SQLite connections", async () => {
  // Each worker opens its own connection, then waits until all writers are ready.
  const bundle = await build({
    stdin: {
      contents: `
      import { parentPort, workerData } from "node:worker_threads";
      import { getDb } from "./api/queries/connection";
      import { grantExperience } from "./api/queries/levels";
      getDb();
      parentPort.postMessage("ready");
      parentPort.once("message", () => {
        parentPort.postMessage(grantExperience(workerData, "race", 120980));
        getDb().$client.close();
      });
    `,
      resolveDir: process.cwd(),
    },
    tsconfig: "tsconfig.server.json",
    platform: "node",
    format: "cjs",
    bundle: true,
    write: false,
    define: { "import.meta.url": JSON.stringify(import.meta.url) },
  });
  const workers: Worker[] = [];
  try {
    for (const id of [1, 2, 3, 4, 1]) {
      const worker = new Worker(bundle.outputFiles[0].text, {
        eval: true,
        workerData: id,
      });
      workers.push(worker);
      await once(worker, "message");
    }
    const results = await Promise.all(
      workers.map(async worker => {
        const reply = once(worker, "message");
        worker.postMessage("start");
        return (await reply)[0];
      })
    );
    expect(results.filter(Boolean)).toHaveLength(4);
    const hall = api.getLevelHall();
    expect(hall.map(row => [row.level, row.rank])).toEqual([
      [10, 1],
      [10, 2],
      [10, 3],
      [20, 1],
      [20, 2],
      [20, 3],
    ]);
    expect(hall.slice(0, 3).map(row => row.userName)).toEqual(
      hall.slice(3).map(row => row.userName)
    );
    expect(api.getLevelProfile(1).progress.totalExp).toBe(120980);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}, 30_000);
