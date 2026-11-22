// Cash/price: milli-USDT. Contract quantity: one hundred million atoms per coin.
export const PERP_ENGINE_SCHEMA = `CREATE TABLE IF NOT EXISTS perp_wallets (
 user_id INTEGER PRIMARY KEY REFERENCES users(id), cash_units INTEGER NOT NULL CHECK(cash_units>=0));
CREATE TABLE IF NOT EXISTS perp_positions (
 user_id INTEGER NOT NULL REFERENCES users(id), symbol TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('long','short')),
 quantity_atoms INTEGER NOT NULL CHECK(quantity_atoms>0), entry_units INTEGER NOT NULL CHECK(entry_units>0),
 margin_units INTEGER NOT NULL CHECK(margin_units>=0), leverage INTEGER NOT NULL CHECK(leverage IN (1,2,5)),
 opened_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_funding_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,symbol));
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
CREATE TABLE IF NOT EXISTS perp_orders (
 id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),symbol TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('openLong','openShort','close','liquidate')),side TEXT NOT NULL CHECK(side IN ('long','short')),
 quantity_atoms INTEGER NOT NULL,leverage INTEGER NOT NULL,price_units INTEGER NOT NULL,mark_units INTEGER NOT NULL,
 fee_units INTEGER NOT NULL,pnl_units INTEGER NOT NULL,created_at INTEGER NOT NULL,request_key TEXT,UNIQUE(user_id,request_key));
CREATE INDEX IF NOT EXISTS perp_user_orders ON perp_orders(user_id,id);
CREATE TABLE IF NOT EXISTS perp_events (
 id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),symbol TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('in','out','open','close','liquidate','funding')),
 cash_delta_units INTEGER NOT NULL,margin_delta_units INTEGER NOT NULL,entry_delta_units INTEGER NOT NULL,qty_delta_atoms INTEGER NOT NULL,
 created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS perp_event_time ON perp_events(created_at,id);
CREATE TABLE IF NOT EXISTS perp_funding (
 id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),symbol TEXT NOT NULL,as_of INTEGER NOT NULL,
 rate_e8 INTEGER NOT NULL,mark_units INTEGER NOT NULL,amount_units INTEGER NOT NULL,UNIQUE(user_id,symbol,as_of));`;
