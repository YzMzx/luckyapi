import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const legacyDbFile = join(tmpdir(), `lucky-registration-migration-${process.pid}-${Date.now()}.db`);
process.env.SQLITE_PATH = legacyDbFile;

const legacy = new Database(legacyDbFile);
legacy.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    linuxdo_id TEXT NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    trust_level INTEGER NOT NULL DEFAULT 0,
    group_name TEXT,
    balance REAL NOT NULL DEFAULT 0,
    total_won REAL NOT NULL DEFAULT 0,
    has_won INTEGER NOT NULL DEFAULT 0,
    banned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE invite_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'invite',
    amount REAL,
    used_by INTEGER,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    delta REAL NOT NULL,
    created_at INTEGER NOT NULL
  );
  INSERT INTO users (linuxdo_id, username, display_name, group_name, created_at)
  VALUES ('pending-legacy', 'pending', 'Pending Legacy', NULL, 1),
         ('registered-legacy', 'registered', 'Registered Legacy', '正式用户', 2);
  INSERT INTO sessions (token, user_id, expires_at, created_at)
  VALUES ('pending-session', 1, 9999999999999, 1),
         ('registered-session', 2, 9999999999999, 1);
  INSERT INTO invite_codes (code, type, amount, used_by, used_at, created_at)
  VALUES ('LEGACY-USED', 'redeem', 5, 2, 3, 2),
         ('LEGACY-UNUSED', 'redeem', 5, NULL, NULL, 2);
  INSERT INTO checkins (user_id, day, delta, created_at)
  VALUES (2, '2026-01-01', 2.5, 4);
`);
legacy.close();

describe("legacy registration migration", () => {
  it("moves OAuth-only users out of formal users and revokes their formal sessions", async () => {
    const [{ getDb }, { pendingUsers, sessions, users, inviteCodes, codeRedemptions, checkins }] = await Promise.all([
      import("./connection"),
      import("../../db/schema"),
    ]);
    const db = getDb();
    expect((await db.select().from(users)).map((user) => user.linuxdoId)).toEqual(["registered-legacy"]);
    expect((await db.select().from(pendingUsers)).map((user) => user.linuxdoId)).toEqual(["pending-legacy"]);
    expect((await db.select().from(sessions)).map((session) => session.token)).toEqual(["registered-session"]);
    const migratedCodes = await db.select().from(inviteCodes);
    expect(migratedCodes.map((code) => ({ code: code.code, mode: code.mode, count: code.redemptionCount }))).toEqual([
      { code: "LEGACY-USED", mode: "single", count: 1 },
      { code: "LEGACY-UNUSED", mode: "single", count: 0 },
    ]);
    expect(await db.select().from(codeRedemptions)).toHaveLength(1);
    expect((await db.select().from(checkins))[0]).toMatchObject({
      requestId: null,
      bet: 0,
      symbols: "",
      payoutMultiplier: 0,
      grossPayout: 0,
      configVersion: "legacy",
      delta: 2.5,
    });
  });
});
