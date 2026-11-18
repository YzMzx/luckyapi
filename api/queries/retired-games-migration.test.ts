import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

let directory: string;
let path: string;
let sqlite: Database.Database;

async function start() {
  vi.resetModules();
  const { getDb } = await import("./connection");
  getDb().$client.close();
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "lucky-retired-"));
  path = join(directory, "test.db");
  vi.stubEnv("SQLITE_PATH", path);
  await start();
  sqlite = new Database(path);
});
afterEach(() => {
  if (sqlite?.open) sqlite.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("starts without retired tables or settings", () => {
  expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'report*' OR name GLOB 'team_battle*'").all()).toEqual([]);
  expect(sqlite.prepare("SELECT key FROM settings WHERE key GLOB 'report_*'").all()).toEqual([]);
});

it("refunds only open escrow, preserves original credit expiry and leaves history intact on restart", async () => {
  sqlite.exec(`
    CREATE TABLE reports (id INTEGER PRIMARY KEY, amount REAL);
    INSERT INTO reports VALUES (4, 1.25);
    CREATE TABLE team_battle_bets (id INTEGER PRIMARY KEY, room_id TEXT, user_id INTEGER, request_id TEXT, amount_units INTEGER, status TEXT, payout_units INTEGER, settled_at INTEGER);
    CREATE TABLE team_battle_rooms (id TEXT PRIMARY KEY, status TEXT, finished_at INTEGER, payout_units INTEGER, dispute_reason TEXT);
    CREATE TABLE team_battle_ledger (room_id TEXT, user_id INTEGER, request_id TEXT, type TEXT, amount_units INTEGER, user_balance_after_units INTEGER, fund_balance_after_units INTEGER, note TEXT);
    CREATE TABLE team_battle_fund (id INTEGER PRIMARY KEY, balance_units INTEGER, updated_at INTEGER);
    INSERT INTO team_battle_fund VALUES (1, 10, 0);
    INSERT INTO team_battle_rooms VALUES ('open', 'voting', NULL, 0, NULL), ('old', 'settled', 42, 9000000, NULL);
    INSERT INTO users (id, linuxdo_id, username, group_name, balance) VALUES (1, 'first', 'first', 'first', -2.5), (2, 'second', 'second', 'second', 18);
    INSERT INTO team_battle_bets VALUES
      (1, 'open', 1, 'mixed', 6000000, 'escrowed', 0, NULL), (2, 'open', 1, 'permanent', 1, 'escrowed', 0, NULL),
      (3, 'old', 2, 'win', 5000000, 'won', 9000000, 42), (4, 'old', 1, 'loss', 5000000, 'lost', 0, 42),
      (5, 'earlier', 2, 'prior-refund', 1000000, 'refunded', 1000000, 40);
    INSERT INTO credit_grants (id, redemption_id, code_id, code, user_id, original_units, remaining_units, consumed_units, expires_at, status) VALUES
      (1, 1, 1, 'valid', 1, 2000000, 0, 2000000, (unixepoch() + 86400) * 1000, 'exhausted'),
      (2, 2, 2, 'expired', 1, 3000000, 0, 3000000, 1, 'exhausted');
    INSERT INTO credit_grant_ledger (grant_id, user_id, type, amount_units, remaining_after_units, source_kind, request_id) VALUES
      (1, 1, 'consume', -2000000, 0, 'team_battle', 'mixed'), (2, 1, 'consume', -3000000, 0, 'team_battle', 'mixed');
    INSERT INTO transactions (user_id, kind, amount, balance_after, note) VALUES (2, 'report', -1.25, 18, 'history');
  `);
  // Simulate a failure after the first refund has updated every affected ledger.
  sqlite.exec(`CREATE TRIGGER interrupt_refund BEFORE UPDATE ON team_battle_bets WHEN OLD.id = 2
    BEGIN SELECT RAISE(ABORT, 'interrupted migration'); END`);
  await expect(start()).rejects.toThrow('interrupted migration');
  expect(sqlite.prepare("SELECT balance FROM users WHERE id = 1").pluck().get()).toBe(-2.5);
  expect(sqlite.prepare("SELECT count(*) FROM team_battle_ledger").pluck().get()).toBe(0);
  expect(sqlite.prepare("SELECT count(*) FROM team_battle_bets WHERE status = 'escrowed'").pluck().get()).toBe(2);
  sqlite.exec("DROP TRIGGER interrupt_refund");

  const expectedBets = [
    ['refunded', 3000000], ['refunded', 1], ['won', 9000000], ['lost', 0], ['refunded', 1000000],
  ];
  for (let boot = 0; boot < 2; boot++) {
    await start();
    expect(sqlite.prepare("SELECT balance FROM users ORDER BY id").pluck().all()).toEqual([0.500001, 18]);
    expect(sqlite.prepare("SELECT status, payout_units FROM team_battle_bets ORDER BY id").raw().all()).toEqual(expectedBets);
    expect(sqlite.prepare("SELECT status, remaining_units FROM credit_grants ORDER BY id").raw().all()).toEqual([['active', 2000000], ['exhausted', 0]]);
    expect(sqlite.prepare("SELECT status, payout_units FROM team_battle_rooms ORDER BY id").raw().all()).toEqual([['settled', 9000000], ['refunded', 3000001]]);
    expect(sqlite.prepare("SELECT balance_units FROM team_battle_fund").pluck().get()).toBe(3000010);
    expect(sqlite.prepare("SELECT type, amount_units FROM team_battle_ledger ORDER BY rowid").raw().all()).toEqual([['refund', 3000000], ['expired_credit_forfeit', 3000000], ['refund', 1]]);
    expect(sqlite.prepare("SELECT kind, amount FROM transactions ORDER BY id").raw().all()).toEqual([['report', -1.25], ['adjust', 3], ['adjust', 0.000001]]);
    expect(sqlite.prepare("SELECT * FROM reports").get()).toEqual({ id: 4, amount: 1.25 });
  }
});
