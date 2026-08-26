import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const dbPath = join(tmpdir(), `lucky-entertainment-migration-${process.pid}-${Date.now()}.db`);
process.env.SQLITE_PATH = dbPath;

describe("entertainment compatibility migration", () => {
  it("keeps legacy rows readable while adding account/day and balance-threshold semantics", async () => {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE draws (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, user_id INTEGER,
        won INTEGER NOT NULL DEFAULT 0, amount REAL, created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX draws_ip_unique ON draws (ip);
      CREATE INDEX draws_user_idx ON draws (user_id);
      INSERT INTO draws (ip, user_id, won, amount, created_at) VALUES
        ('192.0.2.1', 7, 0, NULL, 1), ('192.0.2.2', 7, 1, 5, 2);

      CREATE TABLE checkins (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, day TEXT NOT NULL,
        delta REAL NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX checkins_user_day_unique ON checkins (user_id, day);
      INSERT INTO checkins (user_id, day, delta, created_at) VALUES (7, '2026-08-19', 1, 1);

      CREATE TABLE invite_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'invite',
        amount REAL, used_by INTEGER, used_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX invite_codes_code_idx ON invite_codes (code);
      INSERT INTO invite_codes (code, type, amount, created_at) VALUES ('LD-LEGACY', 'redeem', 2, 1);

      CREATE TABLE code_redemptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, code_id INTEGER NOT NULL, code TEXT NOT NULL,
        user_id INTEGER NOT NULL, amount REAL NOT NULL, redeemed_at INTEGER NOT NULL
      );
    `);
    legacy.close();

    const [{ getDb }, schema] = await Promise.all([import("./connection"), import("../../db/schema")]);
    const db = getDb();
    const drawRows = await db.select().from(schema.draws);
    expect(drawRows).toHaveLength(2);
    expect(drawRows.filter((row) => row.userId === 7)).toHaveLength(1);
    expect(drawRows.every((row) => row.configSnapshot === "")).toBe(true);
    await expect(db.insert(schema.draws).values({ ip: "192.0.2.1", userId: 8, won: false })).resolves.toBeDefined();
    await expect(db.insert(schema.checkins).values({ userId: 7, day: "2026-08-19", delta: 0, requestId: "migration-request" })).resolves.toBeDefined();
    const legacyCode = (await db.select().from(schema.inviteCodes))[0];
    expect(legacyCode.balanceBelow).toBeNull();
    expect(await db.select().from(schema.announcements)).toEqual([]);
    expect(await db.select().from(schema.dailySignins)).toEqual([]);
  });
});
