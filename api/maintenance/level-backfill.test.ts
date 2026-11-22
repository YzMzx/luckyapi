import Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { runBackfill } from "./level-backfill";

it("previews a pre-level WAL database, publishes a full separate copy and rejects overwrite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lucky-replay-test-"));
  const input = join(directory, "source.db");
  const output = join(directory, "result.db");
  const db = new Database(input);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, linuxdo_id TEXT, balance REAL);
      INSERT INTO users VALUES (1,'member',120);
      CREATE TABLE transactions(id INTEGER PRIMARY KEY, user_id INTEGER, kind TEXT, amount REAL, balance_after REAL, note TEXT, created_at INTEGER);
      INSERT INTO transactions VALUES (1,1,'draw',120,120,'一次性抽奖中奖',1700000000000);`);
    const before = readFileSync(input);
    const preview = await runBackfill(input);
    expect(preview.ready).toBe(true);
    const result = await runBackfill(input, output);
    expect(result.ready).toBe(true);
    if (!result.ready || !preview.ready) throw new Error("unexpected warning");
    expect(result.report).toEqual(preview.report);
    expect(readFileSync(input)).toEqual(before);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name='level_badges'")
        .get()
    ).toBeUndefined();
    const final = new Database(output, { readonly: true });
    try {
      expect(
        final.prepare("SELECT total_exp FROM level_profiles").pluck().get()
      ).toBe(12000);
      expect(
        final
          .prepare("SELECT awarded_at FROM level_badges WHERE level=10")
          .pluck()
          .get()
      ).toBe(1700000000000);
      expect(final.prepare("SELECT balance FROM users").pluck().get()).toBe(
        120
      );
      expect(
        final.prepare("SELECT count(*) FROM transactions").pluck().get()
      ).toBe(1);
    } finally {
      final.close();
    }
    await expect(runBackfill(input, output)).rejects.toThrow();
    await expect(runBackfill(input, input)).rejects.toThrow();
    const replay = await runBackfill(output);
    if (!replay.ready) throw new Error("unexpected warning");
    expect(replay.report.counts).toMatchObject({
      insertedEvents: 0,
      updatedEvents: 0,
      seatInserts: 0,
      seatDeletes: 0,
      profileWrites: 0,
    });
    db.exec(
      "INSERT INTO transactions VALUES (2,1,'loan_repayment',11,131,'借贷 #7 提前还款',1700000001000)"
    );
    const incomplete = join(directory, "incomplete.db");
    const blocked = await runBackfill(input, incomplete);
    expect(blocked).toMatchObject({
      ready: false,
      output: null,
      warnings: [expect.stringContaining("#2")],
    });
    expect(existsSync(incomplete)).toBe(false);
    const missing = join(directory, "missing.db");
    await expect(runBackfill(missing)).rejects.toThrow();
    expect(existsSync(missing)).toBe(false);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
