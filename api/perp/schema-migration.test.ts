import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { migratePerpLeverage } from "./schema";

// Keep this fixture independent of the new schema so it exercises the actual upgrade.
const legacySchema = `
CREATE TABLE perp_positions (
 user_id INTEGER NOT NULL REFERENCES users(id), symbol TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('long','short')),
 quantity_atoms INTEGER NOT NULL CHECK(quantity_atoms>0), entry_units INTEGER NOT NULL CHECK(entry_units>0),
 margin_units INTEGER NOT NULL CHECK(margin_units>=0), leverage INTEGER NOT NULL CHECK(leverage IN (1,2,5)),
 opened_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_funding_at INTEGER NOT NULL, PRIMARY KEY(user_id,symbol));
CREATE INDEX IF NOT EXISTS perp_due ON perp_positions(symbol,next_funding_at);
CREATE TABLE perp_orders (
 id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),symbol TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('openLong','openShort','close','liquidate')),side TEXT NOT NULL CHECK(side IN ('long','short')),
 quantity_atoms INTEGER NOT NULL,leverage INTEGER NOT NULL,price_units INTEGER NOT NULL,mark_units INTEGER NOT NULL,
 fee_units INTEGER NOT NULL,pnl_units INTEGER NOT NULL,created_at INTEGER NOT NULL,request_key TEXT,UNIQUE(user_id,request_key));
CREATE INDEX IF NOT EXISTS perp_user_orders ON perp_orders(user_id,id);
CREATE TABLE perp_pending_orders (
 id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),request_key TEXT NOT NULL,
 symbol TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('openLong','openShort','close')),
 side TEXT NOT NULL CHECK(side IN ('long','short')),order_type TEXT NOT NULL CHECK(order_type IN ('limit','conditional')),
 quantity_atoms INTEGER NOT NULL CHECK(quantity_atoms>0),leverage INTEGER NOT NULL CHECK(leverage IN (1,2,5)),
 limit_price_units INTEGER,trigger_price_units INTEGER,trigger_direction TEXT CHECK(trigger_direction IN ('above','below')),
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,triggered_at INTEGER,last_quote_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','triggered','filled','cancelled','rejected')),
 fill_order_id INTEGER REFERENCES perp_orders(id),reason TEXT,UNIQUE(user_id,request_key));
CREATE INDEX IF NOT EXISTS perp_pending_active ON perp_pending_orders(symbol,id) WHERE status IN ('pending','triggered');
CREATE INDEX IF NOT EXISTS perp_pending_user ON perp_pending_orders(user_id,id);
CREATE TABLE perp_pending_position_bindings (
 pending_id INTEGER PRIMARY KEY REFERENCES perp_pending_orders(id) ON DELETE CASCADE, opened_at INTEGER NOT NULL);
CREATE TABLE perp_exchanges (
 id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id), direction TEXT NOT NULL CHECK(direction IN ('in','out')),
 amount_units INTEGER NOT NULL,fee_units INTEGER NOT NULL,net_units INTEGER NOT NULL,created_at INTEGER NOT NULL,
 request_key TEXT NOT NULL,UNIQUE(user_id,request_key));
CREATE TABLE perp_exchange_rules (
 exchange_id INTEGER PRIMARY KEY REFERENCES perp_exchanges(id), exchange_rate INTEGER NOT NULL CHECK(exchange_rate>=1),
 redemption_fee_bps INTEGER NOT NULL CHECK(redemption_fee_bps BETWEEN 0 AND 10000));
`;
const seed = `
INSERT INTO perp_positions VALUES (1,'BTCUSDT','long',1000000,18000,6000,5,101,102,103);
INSERT INTO perp_orders VALUES (17,1,'BTCUSDT','openLong','long',1000000,2,18000,18001,2,0,101,'market');
INSERT INTO perp_pending_orders VALUES
 (23,1,'filled','BTCUSDT','openLong','long','limit',1000000,2,18000,NULL,NULL,99,101,NULL,101,'filled',17,NULL),
 (31,1,'bound-close','BTCUSDT','close','long','conditional',1000000,5,NULL,16000,'below',102,103,103,103,'triggered',NULL,NULL);
INSERT INTO perp_pending_position_bindings VALUES (31,101);
INSERT INTO perp_exchanges VALUES (41,1,'in',6001,1,6000,98,'funds');
INSERT INTO perp_exchange_rules VALUES (41,100,25);
`;
const leverageTables = ["perp_positions", "perp_orders", "perp_pending_orders"];
const affectedTables = [
  ...leverageTables,
  "perp_pending_position_bindings",
  "perp_exchanges",
  "perp_exchange_rules",
];

function snapshot(db: Database.Database) {
  return affectedTables.map(table =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  );
}

function assertLeverageRange(db: Database.Database) {
  for (const table of leverageTables) {
    const write = db.prepare(`UPDATE ${table} SET leverage = ?`);
    const read = db.prepare(`SELECT DISTINCT leverage FROM ${table}`).pluck();
    for (const value of [1, 3, 37, 100]) {
      write.run(value);
      expect(read.all()).toEqual([value]);
    }
    for (const value of [0, 101, 2.5, "not an integer"]) {
      expect(() => write.run(value)).toThrow(/CHECK constraint failed/);
    }
    expect(() => write.run(null)).toThrow(/NOT NULL constraint failed/);
  }
}

let directory: string | undefined;
let db: Database.Database | undefined;
async function start() {
  db?.close();
  db = undefined;
  vi.resetModules();
  const { getDb } = await import("../queries/connection");
  return (db = getDb().$client);
}
afterEach(() => {
  db?.close();
  db = undefined;
  vi.unstubAllEnvs();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

it("upgrades on startup, preserving rows, indexes and live foreign keys across restarts", async () => {
  directory = mkdtempSync(join(tmpdir(), "lucky-perp-leverage-"));
  const path = join(directory, "legacy.db");
  vi.stubEnv("SQLITE_PATH", path);
  const legacy = await start();
  for (const table of [...affectedTables].reverse())
    legacy.exec(`DROP TABLE ${table}`);
  legacy.exec(
    "INSERT INTO users (id, linuxdo_id, username, group_name) VALUES (1, '1', 'Trader', 'Trader');"
  );
  legacy.exec(legacySchema + seed);
  legacy.exec(
    "CREATE INDEX perp_position_updated ON perp_positions(updated_at DESC)"
  );
  const originalRows = snapshot(legacy);
  const indexes = (sqlite: Database.Database) =>
    sqlite
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name IN " +
          "('perp_positions', 'perp_orders', 'perp_pending_orders', 'perp_exchanges') ORDER BY name"
      )
      .all();
  const originalIndexes = indexes(legacy);
  const sqlite = await start();
  expect(snapshot(sqlite)).toEqual(originalRows);
  expect(indexes(sqlite)).toEqual(originalIndexes);
  expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(() => sqlite.exec("DELETE FROM perp_orders WHERE id = 17")).toThrow(
    /FOREIGN KEY/
  );
  expect(() => sqlite.exec("DELETE FROM perp_exchanges WHERE id = 41")).toThrow(
    /FOREIGN KEY/
  );
  expect(() => sqlite.exec("UPDATE perp_positions SET user_id = 99")).toThrow(
    /FOREIGN KEY/
  );
  expect(() => sqlite.exec("UPDATE perp_orders SET action = 'bogus'")).toThrow(
    /CHECK/
  );
  expect(() =>
    sqlite.exec("UPDATE perp_positions SET quantity_atoms = 0")
  ).toThrow(/CHECK/);
  expect(() =>
    sqlite.exec("UPDATE perp_pending_orders SET request_key = 'duplicate'")
  ).toThrow(/UNIQUE/);

  assertLeverageRange(sqlite);
  const upgradedRows = snapshot(sqlite);
  const schemaVersion = sqlite.pragma("schema_version", { simple: true });
  const reopened = await start();
  expect(reopened.pragma("schema_version", { simple: true })).toBe(
    schemaVersion
  );
  expect(snapshot(reopened)).toEqual(upgradedRows);
  expect(indexes(reopened)).toEqual(originalIndexes);
  expect(reopened.pragma("foreign_key_check")).toEqual([]);
  reopened.exec("DELETE FROM perp_pending_orders WHERE id = 31");
  expect(
    reopened.prepare("SELECT * FROM perp_pending_position_bindings").all()
  ).toEqual([]);
});

it("uses the same integer range for a fresh installation", async () => {
  vi.stubEnv("SQLITE_PATH", ":memory:");
  const sqlite = await start();
  sqlite.exec(
    "INSERT INTO users (id, linuxdo_id, username) VALUES (1, '1', 'Trader');" +
      seed
  );
  assertLeverageRange(sqlite);
  expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
});

it("rolls back the entire upgrade and restores FK enforcement on a failed integrity check", () => {
  const sqlite = (db = new Database(":memory:"));
  sqlite.exec(
    "CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1);" +
      legacySchema +
      seed
  );
  sqlite.exec(
    "PRAGMA foreign_keys = OFF; UPDATE perp_pending_orders SET fill_order_id = 99 WHERE id = 23; PRAGMA foreign_keys = ON;"
  );
  const schema = sqlite.prepare("SELECT * FROM sqlite_schema ORDER BY name");
  const originalSchema = schema.all();
  const originalRows = snapshot(sqlite);
  expect(() => migratePerpLeverage(sqlite)).toThrow(
    /foreign key violation in perp_pending_orders/
  );
  expect(schema.all()).toEqual(originalSchema);
  expect(snapshot(sqlite)).toEqual(originalRows);
  expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(sqlite.inTransaction).toBe(false);
  expect(() => sqlite.exec("UPDATE perp_positions SET leverage = 3")).toThrow(
    /CHECK/
  );
  sqlite.exec(
    "UPDATE perp_pending_orders SET fill_order_id = 17 WHERE id = 23"
  );
  migratePerpLeverage(sqlite);
  expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  assertLeverageRange(sqlite);
});
