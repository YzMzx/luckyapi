import type Database from "better-sqlite3";
import { PERP_LEVERAGE_MAX, PERP_LEVERAGE_MIN } from "@contracts/perp-leverage";

const LEVERAGE_CHECK = `CONSTRAINT perp_leverage_range CHECK(typeof(leverage) = 'integer' AND leverage BETWEEN ${PERP_LEVERAGE_MIN} AND ${PERP_LEVERAGE_MAX})`;

const leverageTables = {
  perp_positions: `(
 user_id INTEGER NOT NULL REFERENCES users(id), symbol TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('long','short')),
 quantity_atoms INTEGER NOT NULL CHECK(quantity_atoms>0), entry_units INTEGER NOT NULL CHECK(entry_units>0),
 margin_units INTEGER NOT NULL CHECK(margin_units>=0), leverage INTEGER NOT NULL ${LEVERAGE_CHECK},
 opened_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_funding_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,symbol))`,
  perp_orders: `(
 id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),symbol TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('openLong','openShort','close','liquidate')),side TEXT NOT NULL CHECK(side IN ('long','short')),
 quantity_atoms INTEGER NOT NULL,leverage INTEGER NOT NULL ${LEVERAGE_CHECK},price_units INTEGER NOT NULL,mark_units INTEGER NOT NULL,
 fee_units INTEGER NOT NULL,pnl_units INTEGER NOT NULL,created_at INTEGER NOT NULL,request_key TEXT,UNIQUE(user_id,request_key))`,
  perp_pending_orders: `(
 id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),request_key TEXT NOT NULL,
 symbol TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('openLong','openShort','close')),
 side TEXT NOT NULL CHECK(side IN ('long','short')),order_type TEXT NOT NULL CHECK(order_type IN ('limit','conditional')),
 quantity_atoms INTEGER NOT NULL CHECK(quantity_atoms>0),leverage INTEGER NOT NULL ${LEVERAGE_CHECK},
 limit_price_units INTEGER,trigger_price_units INTEGER,trigger_direction TEXT CHECK(trigger_direction IN ('above','below')),
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,triggered_at INTEGER,last_quote_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','triggered','filled','cancelled','rejected')),
 fill_order_id INTEGER REFERENCES perp_orders(id),reason TEXT,UNIQUE(user_id,request_key)
)`,
};

type LeverageTable = keyof typeof leverageTables;

function createLeverageTable(table: LeverageTable) {
  return `CREATE TABLE IF NOT EXISTS ${table} ${leverageTables[table]};`;
}

const MARGIN_EVENT_CHECK =
  "CHECK(kind IN ('in','out','open','close','liquidate','funding','margin'))";
const eventTable = `(
 id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),symbol TEXT,
 kind TEXT NOT NULL ${MARGIN_EVENT_CHECK},
 cash_delta_units INTEGER NOT NULL,margin_delta_units INTEGER NOT NULL,entry_delta_units INTEGER NOT NULL,qty_delta_atoms INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 CHECK(kind<>'margin' OR (symbol IS NOT NULL AND margin_delta_units>0 AND cash_delta_units=-margin_delta_units AND entry_delta_units=0 AND qty_delta_atoms=0)))`;

// Cash/price: milli-USDT. Contract quantity: one hundred million atoms per coin.
export const PERP_ENGINE_SCHEMA = `CREATE TABLE IF NOT EXISTS perp_wallets (
 user_id INTEGER PRIMARY KEY REFERENCES users(id), cash_units INTEGER NOT NULL CHECK(cash_units>=0));
CREATE TABLE IF NOT EXISTS perp_presence (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, seen_at INTEGER NOT NULL);
${createLeverageTable("perp_positions")}
CREATE INDEX IF NOT EXISTS perp_due ON perp_positions(symbol,next_funding_at);
CREATE TABLE IF NOT EXISTS perp_exp_basis (
 user_id INTEGER PRIMARY KEY REFERENCES users(id), principal_units INTEGER NOT NULL CHECK(principal_units>=0));
CREATE TABLE IF NOT EXISTS perp_exchanges (
 id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id), direction TEXT NOT NULL CHECK(direction IN ('in','out')),
 amount_units INTEGER NOT NULL,fee_units INTEGER NOT NULL,net_units INTEGER NOT NULL,created_at INTEGER NOT NULL,
 request_key TEXT NOT NULL, UNIQUE(user_id,request_key));
CREATE TABLE IF NOT EXISTS perp_exchange_rules (
 exchange_id INTEGER PRIMARY KEY REFERENCES perp_exchanges(id), exchange_rate INTEGER NOT NULL CHECK(exchange_rate>=1),
 redemption_fee_bps INTEGER NOT NULL CHECK(redemption_fee_bps BETWEEN 0 AND 10000));
${createLeverageTable("perp_orders")}
CREATE INDEX IF NOT EXISTS perp_user_orders ON perp_orders(user_id,id);
${createLeverageTable("perp_pending_orders")}
CREATE INDEX IF NOT EXISTS perp_pending_active ON perp_pending_orders(symbol,id) WHERE status IN ('pending','triggered');
CREATE TABLE IF NOT EXISTS perp_pending_position_bindings (
 pending_id INTEGER PRIMARY KEY REFERENCES perp_pending_orders(id) ON DELETE CASCADE, opened_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS perp_pending_user ON perp_pending_orders(user_id,id);
CREATE TABLE IF NOT EXISTS perp_depth_cursors (
 symbol TEXT PRIMARY KEY,sequence INTEGER NOT NULL CHECK(sequence>0),as_of INTEGER NOT NULL CHECK(as_of>0),contents TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS perp_depth_consumption (
 symbol TEXT NOT NULL REFERENCES perp_depth_cursors(symbol) ON DELETE CASCADE,
 side TEXT NOT NULL CHECK(side IN ('buy','sell')),price_units INTEGER NOT NULL CHECK(price_units>0),
 quantity_atoms INTEGER NOT NULL CHECK(quantity_atoms>0),PRIMARY KEY(symbol,side,price_units));
CREATE TABLE IF NOT EXISTS perp_order_execution (
 order_id INTEGER PRIMARY KEY REFERENCES perp_orders(id) ON DELETE CASCADE,
 notional_units INTEGER NOT NULL CHECK(notional_units>=0),book_sequence INTEGER NOT NULL CHECK(book_sequence>0),
 book_as_of INTEGER NOT NULL CHECK(book_as_of>0),requested_quantity_atoms INTEGER CHECK(requested_quantity_atoms>0),
 requested_action TEXT,requested_leverage INTEGER,slippage_bps INTEGER CHECK(slippage_bps BETWEEN 1 AND 1000));
CREATE TABLE IF NOT EXISTS perp_pending_slippage (
 pending_id INTEGER PRIMARY KEY REFERENCES perp_pending_orders(id) ON DELETE CASCADE,
 slippage_bps INTEGER NOT NULL CHECK(slippage_bps BETWEEN 1 AND 1000));
CREATE TABLE IF NOT EXISTS perp_liquidation_locks (
 user_id INTEGER NOT NULL,symbol TEXT NOT NULL,triggered_at INTEGER NOT NULL,mark_units INTEGER NOT NULL,
 PRIMARY KEY(user_id,symbol),FOREIGN KEY(user_id,symbol) REFERENCES perp_positions(user_id,symbol) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS perp_margin_additions (
 user_id INTEGER NOT NULL REFERENCES users(id), request_key TEXT NOT NULL, symbol TEXT NOT NULL,
 opened_at INTEGER NOT NULL, amount_units INTEGER NOT NULL CHECK(amount_units>0),
 previous_margin_units INTEGER NOT NULL CHECK(previous_margin_units>=0),
 margin_units INTEGER NOT NULL CHECK(margin_units=previous_margin_units+amount_units),
 previous_liquidation_price_units INTEGER NOT NULL CHECK(previous_liquidation_price_units>=0),
 liquidation_price_units INTEGER NOT NULL CHECK(liquidation_price_units>=0),
 available_cash_units INTEGER NOT NULL CHECK(available_cash_units>=0), created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,request_key));
CREATE TABLE IF NOT EXISTS perp_events ${eventTable};
CREATE INDEX IF NOT EXISTS perp_event_time ON perp_events(created_at,id);
CREATE TABLE IF NOT EXISTS perp_funding (
 id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),symbol TEXT NOT NULL,as_of INTEGER NOT NULL,
 rate_e8 INTEGER NOT NULL,mark_units INTEGER NOT NULL,amount_units INTEGER NOT NULL,UNIQUE(user_id,symbol,as_of));`;

export function migratePerpMarginEvents(db: Database.Database) {
  db.transaction(() => {
    const definition = db
      .prepare<[], { sql: string }>(
        "SELECT sql FROM sqlite_schema WHERE type='table' AND name='perp_events'"
      )
      .get();
    if (!definition || definition.sql.includes(MARGIN_EVENT_CHECK)) return;

    // Preserve event IDs/order and dependent indexes/triggers used by replay.
    const objects = db
      .prepare<[], { sql: string }>(
        "SELECT sql FROM sqlite_schema WHERE tbl_name='perp_events' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name"
      )
      .all();
    const columns =
      "id,user_id,symbol,kind,cash_delta_units,margin_delta_units,entry_delta_units,qty_delta_atoms,created_at";
    db.exec(`CREATE TABLE perp_events_margin_upgrade ${eventTable};
      INSERT INTO perp_events_margin_upgrade(${columns}) SELECT ${columns} FROM perp_events;
      DROP TABLE perp_events;
      ALTER TABLE perp_events_margin_upgrade RENAME TO perp_events;`);
    for (const { sql } of objects) db.exec(sql);
  }).immediate();
}

export function migratePerpLeverage(db: Database.Database) {
  // foreign_keys cannot be changed inside a transaction. Leaving it on during DROP
  // would cascade-delete pending position bindings even with deferred FK checks.
  if (db.inTransaction)
    throw new Error("Perp leverage migration requires its own transaction");
  const foreignKeys = db.pragma("foreign_keys", { simple: true });
  try {
    db.pragma("foreign_keys = OFF");
    db.transaction(() => {
      const definition = db.prepare<[string], { sql: string }>(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?"
      );
      const dependencies = db.prepare<[string], { sql: string }>(
        "SELECT sql FROM sqlite_schema WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL"
      );
      let changed = false;
      for (const table of Object.keys(leverageTables) as LeverageTable[]) {
        const schema = definition.get(table)?.sql;
        if (!schema || schema.includes(LEVERAGE_CHECK)) continue;

        const replacement = table + "_leverage_upgrade";
        const objects = dependencies.all(table);
        db.exec(
          `CREATE TABLE ${replacement} ${leverageTables[table]};
           INSERT INTO ${replacement} SELECT * FROM ${table};
           DROP TABLE ${table};
           ALTER TABLE ${replacement} RENAME TO ${table};`
        );
        for (const { sql } of objects) db.exec(sql);
        changed = true;
      }
      if (changed) {
        const violation = db
          .prepare<[], { table: string }>("PRAGMA foreign_key_check")
          .get();
        if (violation)
          throw new Error(
            "Perp leverage migration: foreign key violation in " +
              violation.table
          );
      }
    }).immediate();
  } finally {
    if (foreignKeys) db.pragma("foreign_keys = ON");
  }
}
