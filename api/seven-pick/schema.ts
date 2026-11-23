import type Database from "better-sqlite3";

export const SEVEN_PICK_LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS seven_pick_ledger (
  id INTEGER PRIMARY KEY,
  round_id INTEGER NOT NULL,
  bet_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('stake','payout','refund')),
  delta_units INTEGER NOT NULL CHECK(typeof(delta_units)='integer' AND
    ((kind='stake' AND delta_units BETWEEN -100000 AND -1000) OR
     (kind='refund' AND delta_units BETWEEN 1000 AND 100000) OR
     (kind='payout' AND delta_units BETWEEN 1 AND 9007199254740991))),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
  FOREIGN KEY(bet_id,round_id,user_id) REFERENCES seven_pick_bets(id,round_id,user_id),
  UNIQUE(bet_id,kind)
);
CREATE UNIQUE INDEX IF NOT EXISTS seven_pick_ledger_final ON seven_pick_ledger(bet_id)
  WHERE kind IN ('payout','refund');
CREATE INDEX IF NOT EXISTS seven_pick_ledger_user_time ON seven_pick_ledger(user_id,created_at,id);
CREATE INDEX IF NOT EXISTS seven_pick_ledger_time ON seven_pick_ledger(created_at,id);
CREATE INDEX IF NOT EXISTS seven_pick_ledger_round ON seven_pick_ledger(round_id,kind,bet_id);
`;

const CONFIG_VERSION_COLUMNS = `(
  id INTEGER PRIMARY KEY,
  effective_at INTEGER NOT NULL CHECK(effective_at>=created_at),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  open_minutes_json TEXT NOT NULL,
  close_after_minutes INTEGER NOT NULL CHECK(close_after_minutes>0),
  draw_after_minutes INTEGER NOT NULL CHECK(draw_after_minutes>close_after_minutes),
  min_stake_units INTEGER NOT NULL CHECK(min_stake_units BETWEEN 1000 AND 100000),
  max_stake_units INTEGER NOT NULL CHECK(max_stake_units BETWEEN min_stake_units AND 100000),
  multipliers_json TEXT NOT NULL
)`;

export const SEVEN_PICK_SCHEMA = `
CREATE TABLE IF NOT EXISTS seven_pick_config_versions ${CONFIG_VERSION_COLUMNS};
CREATE INDEX IF NOT EXISTS seven_pick_config_effective
  ON seven_pick_config_versions(effective_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS seven_pick_config_cancellations (
  config_version_id INTEGER PRIMARY KEY REFERENCES seven_pick_config_versions(id),
  canceled_at INTEGER NOT NULL CHECK(typeof(canceled_at)='integer' AND canceled_at>=0)
);
CREATE TABLE IF NOT EXISTS seven_pick_items (
  config_version_id INTEGER NOT NULL REFERENCES seven_pick_config_versions(id),
  item_id INTEGER NOT NULL CHECK(item_id BETWEEN 1 AND 32),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 32),
  image_url TEXT,
  PRIMARY KEY(config_version_id,item_id),
  UNIQUE(config_version_id,position)
);
CREATE TABLE IF NOT EXISTS seven_pick_rounds (
  id INTEGER PRIMARY KEY,
  config_version_id INTEGER NOT NULL REFERENCES seven_pick_config_versions(id),
  status TEXT NOT NULL CHECK(status IN ('scheduled','open','sealed','ots_waiting','review','risk_skipped','settled','refunding','refunded')),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  opens_at INTEGER NOT NULL UNIQUE,
  closes_at INTEGER NOT NULL CHECK(closes_at>opens_at),
  draw_at INTEGER NOT NULL CHECK(draw_at>closes_at),
  quicknet_round INTEGER NOT NULL CHECK(quicknet_round>0),
  quicknet_scheduled_at INTEGER NOT NULL CHECK(quicknet_scheduled_at>=draw_at),
  quicknet_network TEXT NOT NULL,
  quicknet_chain_hash TEXT NOT NULL,
  quicknet_public_key TEXT NOT NULL,
  quicknet_scheme TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  min_stake_units INTEGER NOT NULL CHECK(min_stake_units BETWEEN 1000 AND 100000),
  max_stake_units INTEGER NOT NULL CHECK(max_stake_units BETWEEN min_stake_units AND 100000),
  multipliers_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at<=opens_at)
);
CREATE INDEX IF NOT EXISTS seven_pick_rounds_close ON seven_pick_rounds(closes_at);
-- Track manual attempts without rewriting locked round snapshots or changing scheduled rows.
CREATE TABLE IF NOT EXISTS seven_pick_manual_rounds (
  round_id INTEGER PRIMARY KEY REFERENCES seven_pick_rounds(id)
);
CREATE TABLE IF NOT EXISTS seven_pick_round_items (
  round_id INTEGER NOT NULL REFERENCES seven_pick_rounds(id),
  item_id INTEGER NOT NULL CHECK(item_id BETWEEN 1 AND 32),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 32),
  image_url TEXT,
  PRIMARY KEY(round_id,item_id),
  UNIQUE(round_id,position)
);
CREATE TABLE IF NOT EXISTS seven_pick_orders (
  id INTEGER PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES seven_pick_rounds(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  total_stake_units INTEGER NOT NULL CHECK(typeof(total_stake_units)='integer' AND total_stake_units BETWEEN 1000 AND 500000),
  created_at INTEGER NOT NULL,
  UNIQUE(user_id,request_key),
  UNIQUE(id,round_id,user_id)
);
CREATE INDEX IF NOT EXISTS seven_pick_orders_user_history ON seven_pick_orders(user_id,id DESC);
CREATE TABLE IF NOT EXISTS seven_pick_bets (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL,
  round_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  combination_key TEXT NOT NULL,
  item_mask INTEGER NOT NULL CHECK(typeof(item_mask)='integer' AND item_mask BETWEEN 1 AND 4294967295),
  stake_units INTEGER NOT NULL CHECK(typeof(stake_units)='integer' AND stake_units BETWEEN 1000 AND 100000),
  receipt_id TEXT NOT NULL CHECK(length(receipt_id)=32 AND receipt_id NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(order_id,round_id,user_id) REFERENCES seven_pick_orders(id,round_id,user_id),
  UNIQUE(round_id,user_id,combination_key),
  UNIQUE(round_id,receipt_id),
  UNIQUE(id,round_id,user_id)
);
CREATE INDEX IF NOT EXISTS seven_pick_bets_order ON seven_pick_bets(order_id,id);
CREATE TABLE IF NOT EXISTS seven_pick_risk (
  round_id INTEGER PRIMARY KEY REFERENCES seven_pick_rounds(id),
  limit_units INTEGER NOT NULL CHECK(typeof(limit_units)='integer' AND limit_units BETWEEN 0 AND 9007199254740991),
  max_exposure_units INTEGER NOT NULL CHECK(typeof(max_exposure_units)='integer' AND max_exposure_units BETWEEN 0 AND limit_units),
  locked_at INTEGER NOT NULL
);
${SEVEN_PICK_LEDGER_SCHEMA}
`;

function hasLegacyConfigVersionCheck(db: Database.Database) {
  const row = db.prepare<[], { sql: string }>(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='seven_pick_config_versions'"
  ).get();
  return /CHECK\s*\(\s*effective_at\s*>\s*created_at\s*\)/i.test(row?.sql ?? "");
}

export function ensureSevenPickSchema(db: Database.Database) {
  if (!hasLegacyConfigVersionCheck(db)) {
    db.transaction(() => db.exec(SEVEN_PICK_SCHEMA)).immediate();
    return;
  }

  // Rebuild the parent table without changing existing version IDs or child rows.
  // SQLite does not permit toggling foreign-key enforcement inside a transaction.
  if (db.inTransaction)
    throw new Error("SevenPick config schema upgrade requires its own transaction");
  const foreignKeys = db.pragma("foreign_keys", { simple: true });
  try {
    db.pragma("foreign_keys = OFF");
    db.transaction(() => {
      if (hasLegacyConfigVersionCheck(db)) {
        const objects = db.prepare<[], { sql: string }>(
          "SELECT sql FROM sqlite_schema WHERE tbl_name='seven_pick_config_versions' " +
            "AND type IN ('index','trigger') AND sql IS NOT NULL"
        ).all();
        db.exec(
          `CREATE TABLE seven_pick_config_versions_upgrade ${CONFIG_VERSION_COLUMNS};
           INSERT INTO seven_pick_config_versions_upgrade SELECT * FROM seven_pick_config_versions;
           DROP TABLE seven_pick_config_versions;
           ALTER TABLE seven_pick_config_versions_upgrade RENAME TO seven_pick_config_versions;`
        );
        for (const { sql } of objects) db.exec(sql);
      }
      db.exec(SEVEN_PICK_SCHEMA);
      for (const table of ["seven_pick_config_cancellations", "seven_pick_items", "seven_pick_rounds"]) {
        if (db.prepare(`PRAGMA foreign_key_check(${table})`).get())
          throw new Error(`SevenPick config schema upgrade: foreign key violation in ${table}`);
      }
    }).immediate();
  } finally {
    if (foreignKeys) db.pragma("foreign_keys = ON");
  }
}
