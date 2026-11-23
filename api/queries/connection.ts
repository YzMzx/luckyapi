import { createRequire as nodeCreateRequire } from "node:module";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "@db/schema";
import {
  migratePerpLeverage,
  migratePerpMarginEvents,
  PERP_ENGINE_SCHEMA,
} from "../perp/schema";
import { PERP_MARKET_SCHEMA } from "../perp/market";
import { PERP_WEEKLY_SCHEMA } from "../perp/weekly";
import { ensureSevenPickSchema } from "../seven-pick/schema";
import { ensureSevenPickLifecycleSchema } from "../seven-pick/lifecycle-schema";
import { ensureSevenPickTimestampSchema } from "../seven-pick/seal-timestamp";
import { LEVEL_SCHEMA, migrateLevelColumns } from "./level-schema";
import { creditDollarsToUnits, creditUnitsToDollars, reverseUserBalanceDebit } from "./credit-grants";
import { recordTx } from "./ledger";
import {
  DEFAULT_SLOT_RULES,
  LEGACY_SLOT_RULES,
  V2_SLOT_RULES,
  serializeSlotRules,
  slotMetrics,
} from "@contracts/slot-machine";

// 原生模块不能被打包，运行时从 node_modules 加载
const require_ = nodeCreateRequire(import.meta.url);
const Database = require_("better-sqlite3") as typeof import("better-sqlite3");

// 启动自动建表（IF NOT EXISTS，幂等）
const DDL = `
CREATE TABLE IF NOT EXISTS users (
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
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS users_linuxdo_id_idx ON users (linuxdo_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_group_name_idx ON users (group_name);

${LEVEL_SCHEMA}

CREATE TABLE IF NOT EXISTS pending_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  linuxdo_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  trust_level INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS pending_users_linuxdo_id_idx ON pending_users (linuxdo_id);

CREATE TABLE IF NOT EXISTS pending_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  pending_user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS pending_sessions_token_idx ON pending_sessions (token);
CREATE INDEX IF NOT EXISTS pending_sessions_user_idx ON pending_sessions (pending_user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_idx ON sessions (token);

CREATE TABLE IF NOT EXISTS user_policies (
  user_id INTEGER PRIMARY KEY,
  all_frozen INTEGER NOT NULL DEFAULT 0,
  frozen_api_group_ids TEXT NOT NULL DEFAULT '[]',
  api_frozen INTEGER NOT NULL DEFAULT 0,
  finance_frozen INTEGER NOT NULL DEFAULT 0,
  entertainment_frozen INTEGER NOT NULL DEFAULT 0,
  api_daily_spend_limit_units INTEGER,
  api_key_limit INTEGER,
  api_concurrency_limit INTEGER,
  transfer_daily_limit_units INTEGER,
  lending_daily_limit_units INTEGER,
  outstanding_borrow_limit_units INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_sessions_token_idx ON admin_sessions (token);

CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'invite',
  amount REAL,
  mode TEXT NOT NULL DEFAULT 'single',
  max_uses INTEGER,
  redemption_count INTEGER NOT NULL DEFAULT 0,
  used_by INTEGER,
  used_at INTEGER,
  balance_below REAL,
  credit_expires_at INTEGER,
  archived_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS invite_codes_code_idx ON invite_codes (code);

CREATE TABLE IF NOT EXISTS code_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  balance_before REAL,
  balance_below REAL,
  credit_expires_at INTEGER,
  redeemed_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS code_redemptions_code_user_unique ON code_redemptions (code_id, user_id);
CREATE INDEX IF NOT EXISTS code_redemptions_code_idx ON code_redemptions (code_id);
CREATE INDEX IF NOT EXISTS code_redemptions_user_idx ON code_redemptions (user_id);

CREATE TABLE IF NOT EXISTS credit_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  redemption_id INTEGER NOT NULL,
  code_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  original_units INTEGER NOT NULL,
  consumed_units INTEGER NOT NULL DEFAULT 0,
  remaining_units INTEGER NOT NULL,
  expired_units INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  exhausted_at INTEGER,
  expired_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_grants_redemption_unique ON credit_grants (redemption_id);
CREATE INDEX IF NOT EXISTS credit_grants_user_expiry_idx ON credit_grants (user_id, status, expires_at, id);
CREATE INDEX IF NOT EXISTS credit_grants_expiry_idx ON credit_grants (status, expires_at, id);

CREATE TABLE IF NOT EXISTS credit_grant_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount_units INTEGER NOT NULL,
  remaining_after_units INTEGER NOT NULL,
  source_kind TEXT NOT NULL DEFAULT '',
  request_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS credit_grant_ledger_grant_idx ON credit_grant_ledger (grant_id, id);
CREATE INDEX IF NOT EXISTS credit_grant_ledger_user_idx ON credit_grant_ledger (user_id, id);

CREATE TABLE IF NOT EXISTS draws (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  ip TEXT NOT NULL,
  user_id INTEGER,
  won INTEGER NOT NULL DEFAULT 0,
  amount REAL,
  config_snapshot TEXT NOT NULL DEFAULT '',
  fund_before_units INTEGER,
  fund_after_units INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS draws_ip_idx ON draws (ip);

CREATE TABLE IF NOT EXISTS draw_fund (
  id INTEGER PRIMARY KEY,
  balance_units INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS daily_signins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  reward_units INTEGER NOT NULL,
  config_snapshot TEXT NOT NULL,
  fund_before_units INTEGER NOT NULL,
  fund_after_units INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS daily_signins_request_unique ON daily_signins (request_id);
CREATE UNIQUE INDEX IF NOT EXISTS daily_signins_user_day_unique ON daily_signins (user_id, day);
CREATE INDEX IF NOT EXISTS daily_signins_day_idx ON daily_signins (day, created_at);

CREATE TABLE IF NOT EXISTS signin_fund (
  id INTEGER PRIMARY KEY,
  balance_units INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS video_reward_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token TEXT NOT NULL,
  start_request_id TEXT NOT NULL,
  claim_request_id TEXT,
  user_id INTEGER NOT NULL,
  business_day TEXT NOT NULL,
  video_resource TEXT NOT NULL,
  config_snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  watched_ms INTEGER NOT NULL DEFAULT 0,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_heartbeat_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  reward_units INTEGER,
  daily_spent_before_units INTEGER,
  daily_spent_after_units INTEGER,
  fund_before_units INTEGER,
  fund_after_units INTEGER,
  claimed_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS video_reward_sessions_token_unique ON video_reward_sessions (session_token);
CREATE UNIQUE INDEX IF NOT EXISTS video_reward_sessions_start_request_unique ON video_reward_sessions (start_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS video_reward_sessions_claim_request_unique ON video_reward_sessions (claim_request_id) WHERE claim_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS video_reward_sessions_user_day_idx ON video_reward_sessions (user_id, business_day);
CREATE INDEX IF NOT EXISTS video_reward_sessions_day_idx ON video_reward_sessions (business_day, started_at);
CREATE INDEX IF NOT EXISTS video_reward_sessions_status_idx ON video_reward_sessions (status, updated_at);

CREATE TABLE IF NOT EXISTS video_reward_fund (
  id INTEGER PRIMARY KEY,
  balance_units INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS video_reward_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  business_day TEXT NOT NULL,
  amount_units INTEGER NOT NULL,
  user_balance_after REAL NOT NULL,
  daily_spent_before_units INTEGER NOT NULL,
  daily_spent_after_units INTEGER NOT NULL,
  fund_before_units INTEGER,
  fund_after_units INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS video_reward_ledger_session_unique ON video_reward_ledger (session_id);
CREATE UNIQUE INDEX IF NOT EXISTS video_reward_ledger_request_unique ON video_reward_ledger (request_id);
CREATE INDEX IF NOT EXISTS video_reward_ledger_day_idx ON video_reward_ledger (business_day, created_at);
CREATE INDEX IF NOT EXISTS video_reward_ledger_user_idx ON video_reward_ledger (user_id, created_at);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  severity TEXT NOT NULL DEFAULT 'info',
  pinned INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER,
  ends_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS announcements_public_idx ON announcements (status, pinned, sort_order, published_at);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '默认 Key',
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  group_id INTEGER,
  quota REAL,
  expires_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  last_used_at INTEGER,
  last_used_ip TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id);

CREATE TABLE IF NOT EXISTS admin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS "groups" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1,
  rpm_limit INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS groups_name_idx ON "groups" (name);

CREATE TABLE IF NOT EXISTS upstreams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  timeout_ms INTEGER NOT NULL DEFAULT 60000,
  last_tested_at INTEGER,
  last_test_ok INTEGER,
  last_test_latency_ms INTEGER,
  last_test_message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  upstream_id INTEGER,
  upstream_base_url TEXT NOT NULL DEFAULT '',
  upstream_key TEXT NOT NULL DEFAULT '',
  upstream_model TEXT NOT NULL,
  api_type TEXT NOT NULL DEFAULT 'chat',
  price_input REAL,
  price_output REAL,
  price_cache_write REAL,
  price_cache_read REAL,
  allowed_groups TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  api_key_id INTEGER,
  api_key_name TEXT NOT NULL DEFAULT '',
  api_key_prefix TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'chat',
  upstream_id INTEGER,
  endpoint TEXT NOT NULL DEFAULT '',
  request_body TEXT NOT NULL DEFAULT '',
  response_body TEXT NOT NULL DEFAULT '',
  http_status INTEGER NOT NULL DEFAULT 200,
  upstream_request_id TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  usage_source TEXT NOT NULL DEFAULT 'estimated',
  cache_status TEXT NOT NULL DEFAULT 'unknown',
  input_cost REAL NOT NULL DEFAULT 0,
  output_cost REAL NOT NULL DEFAULT 0,
  cache_write_cost REAL NOT NULL DEFAULT 0,
  cache_read_cost REAL NOT NULL DEFAULT 0,
  group_multiplier REAL NOT NULL DEFAULT 1,
  cost REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  ttft_ms INTEGER NOT NULL DEFAULT 0,
  stream INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS usage_user_idx ON usage_logs (user_id);

CREATE TABLE IF NOT EXISTS slot_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'base',
  status TEXT NOT NULL DEFAULT 'draft',
  rules_json TEXT NOT NULL,
  min_bet_units INTEGER NOT NULL,
  max_bet_units INTEGER NOT NULL,
  win_rate_ppm INTEGER NOT NULL,
  rtp_ppm INTEGER NOT NULL,
  max_multiplier_basis_points INTEGER NOT NULL,
  max_net_liability_units INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  activated_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS slot_configs_version_unique ON slot_configs (version);
CREATE INDEX IF NOT EXISTS slot_configs_status_idx ON slot_configs (mode, status);
CREATE UNIQUE INDEX IF NOT EXISTS slot_configs_one_active_base ON slot_configs (mode) WHERE mode = 'base' AND status = 'active';

CREATE TABLE IF NOT EXISTS slot_fund (
  id INTEGER PRIMARY KEY,
  balance_units INTEGER NOT NULL,
  reserve_units INTEGER NOT NULL,
  daily_loss_limit_units INTEGER NOT NULL,
  day TEXT NOT NULL,
  day_net_units INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS slot_promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  budget_units INTEGER NOT NULL,
  spent_units INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  stopped_at INTEGER
);
CREATE INDEX IF NOT EXISTS slot_promotions_status_idx ON slot_promotions (status, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS slot_fund_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  round_id INTEGER,
  type TEXT NOT NULL,
  amount_units INTEGER NOT NULL,
  balance_after_units INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS slot_fund_ledger_request_idx ON slot_fund_ledger (request_id);
CREATE INDEX IF NOT EXISTS slot_fund_ledger_round_idx ON slot_fund_ledger (round_id);

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  delta REAL NOT NULL,
  bet REAL NOT NULL DEFAULT 0,
  symbols TEXT NOT NULL DEFAULT '',
  payout_multiplier REAL NOT NULL DEFAULT 0,
  gross_payout REAL NOT NULL DEFAULT 0,
  config_version TEXT NOT NULL DEFAULT 'legacy',
  config_id INTEGER,
  prize_tier TEXT NOT NULL DEFAULT 'legacy',
  rules_snapshot TEXT NOT NULL DEFAULT '',
  win_rate_ppm INTEGER NOT NULL DEFAULT 0,
  rtp_ppm INTEGER NOT NULL DEFAULT 0,
  fund_before_units INTEGER,
  fund_after_units INTEGER,
  promotion_id INTEGER,
  promotion_budget_before_units INTEGER,
  promotion_budget_after_units INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS checkins_user_day_idx ON checkins (user_id, day);

CREATE TABLE IF NOT EXISTS duel_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  dice_enabled INTEGER NOT NULL DEFAULT 1,
  blackjack_enabled INTEGER NOT NULL DEFAULT 1,
  winner_tax_basis_points INTEGER NOT NULL DEFAULT 300,
  fee_basis_points INTEGER NOT NULL DEFAULT 300,
  bet_options_json TEXT NOT NULL,
  min_players INTEGER NOT NULL DEFAULT 2,
  max_players INTEGER NOT NULL DEFAULT 6,
  room_timeout_seconds INTEGER NOT NULL DEFAULT 1800,
  action_timeout_seconds INTEGER NOT NULL DEFAULT 60,
  min_bet_units INTEGER NOT NULL DEFAULT 100000,
  max_bet_units INTEGER NOT NULL DEFAULT 5000000,
  bet_precision INTEGER NOT NULL DEFAULT 2,
  single_bet_limit_units INTEGER NOT NULL DEFAULT 5000000,
  daily_stake_limit_units INTEGER NOT NULL DEFAULT 50000000,
  daily_net_loss_limit_units INTEGER NOT NULL DEFAULT 20000000,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS duel_configs_version_unique ON duel_configs (version);
CREATE INDEX IF NOT EXISTS duel_configs_active_idx ON duel_configs (active);

CREATE TABLE IF NOT EXISTS duel_rooms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  game TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public',
  owner_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'lobby',
  config_id INTEGER NOT NULL,
  config_version INTEGER NOT NULL,
  config_snapshot_json TEXT NOT NULL,
  bet_units INTEGER NOT NULL,
  min_players INTEGER NOT NULL,
  max_players INTEGER NOT NULL,
  winner_tax_basis_points INTEGER NOT NULL DEFAULT 300,
  fee_basis_points INTEGER NOT NULL,
  gross_prize_pool_units INTEGER NOT NULL DEFAULT 0,
  winner_tax_units INTEGER NOT NULL DEFAULT 0,
  net_prize_pool_units INTEGER NOT NULL DEFAULT 0,
  pot_units INTEGER NOT NULL DEFAULT 0,
  fee_units INTEGER NOT NULL DEFAULT 0,
  round_no INTEGER NOT NULL DEFAULT 1,
  nonce INTEGER NOT NULL DEFAULT 0,
  seed_hash TEXT NOT NULL DEFAULT '',
  seed_secret TEXT,
  seed_reveal TEXT,
  state_json TEXT NOT NULL DEFAULT '{}',
  current_seat INTEGER,
  action_deadline_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  started_at INTEGER,
  finished_at INTEGER,
  voided_at INTEGER,
  void_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS duel_rooms_code_unique ON duel_rooms (code);
CREATE INDEX IF NOT EXISTS duel_rooms_status_idx ON duel_rooms (status, created_at);

CREATE TABLE IF NOT EXISTS duel_players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  game_type TEXT NOT NULL,
  seat INTEGER NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'joined',
  balance_before_units INTEGER,
  stake_units INTEGER NOT NULL DEFAULT 0,
  payout_units INTEGER NOT NULL DEFAULT 0,
  settled_net_units INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT 'pending',
  hand_json TEXT NOT NULL DEFAULT '[]',
  hand_rank_json TEXT NOT NULL DEFAULT '{}',
  score INTEGER,
  joined_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  settled_at INTEGER,
  voided_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS duel_players_room_user_unique ON duel_players (room_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS duel_players_room_seat_unique ON duel_players (room_id, seat);
CREATE INDEX IF NOT EXISTS duel_players_user_idx ON duel_players (user_id, joined_at);
CREATE INDEX IF NOT EXISTS duel_players_leaderboard_idx ON duel_players (result, game_type, settled_at);

CREATE TABLE IF NOT EXISTS duel_round_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  round_no INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  game_type TEXT NOT NULL,
  seat INTEGER NOT NULL,
  status TEXT NOT NULL,
  result TEXT NOT NULL,
  balance_before_units INTEGER,
  stake_units INTEGER NOT NULL DEFAULT 0,
  payout_units INTEGER NOT NULL DEFAULT 0,
  settled_net_units INTEGER NOT NULL DEFAULT 0,
  hand_json TEXT NOT NULL DEFAULT '[]',
  hand_rank_json TEXT NOT NULL DEFAULT '{}',
  score INTEGER,
  bet_units INTEGER NOT NULL,
  pot_units INTEGER NOT NULL,
  winner_tax_basis_points INTEGER NOT NULL,
  gross_prize_pool_units INTEGER NOT NULL,
  winner_tax_units INTEGER NOT NULL,
  net_prize_pool_units INTEGER NOT NULL,
  seed_hash TEXT NOT NULL,
  seed_reveal TEXT,
  started_at INTEGER,
  settled_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS duel_round_results_room_round_user_unique ON duel_round_results (room_id, round_no, user_id);
CREATE INDEX IF NOT EXISTS duel_round_results_user_idx ON duel_round_results (user_id, settled_at);
CREATE INDEX IF NOT EXISTS duel_round_results_room_idx ON duel_round_results (room_id, round_no);
CREATE INDEX IF NOT EXISTS duel_round_results_leaderboard_idx ON duel_round_results (result, game_type, settled_at);

CREATE TABLE IF NOT EXISTS duel_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  request_id TEXT,
  user_id INTEGER,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS duel_events_room_seq_unique ON duel_events (room_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS duel_events_request_unique ON duel_events (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS duel_events_room_idx ON duel_events (room_id, id);

CREATE TABLE IF NOT EXISTS duel_fund (
  id INTEGER PRIMARY KEY,
  balance_units INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS duel_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  user_id INTEGER,
  request_id TEXT,
  type TEXT NOT NULL,
  amount_units INTEGER NOT NULL,
  user_balance_after_units INTEGER,
  fund_balance_after_units INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS duel_ledger_room_idx ON duel_ledger (room_id, id);
CREATE INDEX IF NOT EXISTS duel_ledger_user_idx ON duel_ledger (user_id, id);

CREATE TABLE IF NOT EXISTS money_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, sender_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL, amount_units INTEGER NOT NULL, fee_units INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed', created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS money_transfers_request_unique ON money_transfers (request_id);
CREATE INDEX IF NOT EXISTS money_transfers_sender_idx ON money_transfers (sender_id, id);
CREATE INDEX IF NOT EXISTS money_transfers_recipient_idx ON money_transfers (recipient_id, id);

CREATE TABLE IF NOT EXISTS peer_loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, lender_id INTEGER NOT NULL,
  borrower_id INTEGER NOT NULL, principal_units INTEGER NOT NULL, monthly_rate_basis_points INTEGER NOT NULL,
  rule_snapshot_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending', terminal_reason TEXT, offered_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  offer_expires_at INTEGER NOT NULL, accepted_at INTEGER, due_at INTEGER NOT NULL, settled_at INTEGER, accrued_interest_units INTEGER NOT NULL DEFAULT 0,
  interest_tax_units INTEGER NOT NULL DEFAULT 0, outstanding_principal_units INTEGER NOT NULL DEFAULT 0,
  outstanding_interest_units INTEGER NOT NULL DEFAULT 0, paid_principal_units INTEGER NOT NULL DEFAULT 0,
  paid_interest_units INTEGER NOT NULL DEFAULT 0, tax_paid_units INTEGER NOT NULL DEFAULT 0,
  defaulted_at INTEGER, updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS peer_loans_request_unique ON peer_loans (request_id);
CREATE INDEX IF NOT EXISTS peer_loans_lender_idx ON peer_loans (lender_id, id);
CREATE INDEX IF NOT EXISTS peer_loans_borrower_idx ON peer_loans (borrower_id, id);
CREATE INDEX IF NOT EXISTS peer_loans_due_idx ON peer_loans (status, due_at);

CREATE TABLE IF NOT EXISTS peer_loan_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, loan_id INTEGER NOT NULL, request_id TEXT NOT NULL,
  type TEXT NOT NULL, amount_units INTEGER NOT NULL, principal_units INTEGER NOT NULL DEFAULT 0,
  interest_units INTEGER NOT NULL DEFAULT 0, tax_units INTEGER NOT NULL DEFAULT 0,
  borrower_balance_after_units INTEGER, lender_balance_after_units INTEGER, note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS peer_loan_ledger_request_unique ON peer_loan_ledger (request_id);
CREATE INDEX IF NOT EXISTS peer_loan_ledger_loan_idx ON peer_loan_ledger (loan_id, id);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS tx_user_idx ON transactions (user_id, id);
`;

// 老库自动补列（SQLite ALTER 幂等迁移）
function migrate(sqlite: InstanceType<typeof Database>) {
  migrateLevelColumns(sqlite);
  const userPolicyCols = (sqlite.prepare("PRAGMA table_info(user_policies)").all() as { name: string }[]).map((c) => c.name);
  if (!userPolicyCols.includes("frozen_api_group_ids")) sqlite.exec("ALTER TABLE user_policies ADD COLUMN frozen_api_group_ids TEXT NOT NULL DEFAULT '[]'");
  if (!userPolicyCols.includes("all_frozen")) sqlite.exec("ALTER TABLE user_policies ADD COLUMN all_frozen INTEGER NOT NULL DEFAULT 0");
  // A user may claim multiple times per business day, while only one unfinished
  // viewing session may exist. Preserve all historical sessions when replacing
  // the legacy one-session-per-day constraint.
  sqlite.exec(`
    DROP INDEX IF EXISTS video_reward_sessions_user_day_unique;
    UPDATE video_reward_sessions
    SET status = 'expired', updated_at = (unixepoch() * 1000)
    WHERE status IN ('active', 'ready') AND id NOT IN (
      SELECT MAX(id) FROM video_reward_sessions
      WHERE status IN ('active', 'ready')
      GROUP BY user_id, business_day
    );
    CREATE INDEX IF NOT EXISTS video_reward_sessions_user_day_idx
      ON video_reward_sessions (user_id, business_day);
    CREATE UNIQUE INDEX IF NOT EXISTS video_reward_sessions_user_day_active_unique
      ON video_reward_sessions (user_id, business_day)
      WHERE status IN ('active', 'ready');
  `);
  // 旧版 OAuth 回调会提前创建 users。将尚未填写群内名称的脏记录迁入临时身份表，
  // 删除其正式会话与 users 行，使后台用户列表、榜单和统计只包含完成注册者。
  sqlite.exec(`
    INSERT INTO pending_users (linuxdo_id, username, display_name, avatar_url, trust_level, created_at, updated_at)
    SELECT linuxdo_id, username, display_name, avatar_url, trust_level, created_at, (unixepoch() * 1000)
    FROM users
    WHERE group_name IS NULL OR trim(group_name) = ''
    ON CONFLICT(linuxdo_id) DO UPDATE SET
      username = excluded.username,
      display_name = excluded.display_name,
      avatar_url = excluded.avatar_url,
      trust_level = excluded.trust_level,
      updated_at = excluded.updated_at;
    DELETE FROM sessions WHERE user_id IN (
      SELECT id FROM users WHERE group_name IS NULL OR trim(group_name) = ''
    );
    DELETE FROM users WHERE group_name IS NULL OR trim(group_name) = '';
  `);

  // 旧码默认保持“全局单次”语义；为历史已用充值码补齐计数和兑换审计。
  const inviteCols = (sqlite.prepare("PRAGMA table_info(invite_codes)").all() as { name: string }[]).map((c) => c.name);
  if (!inviteCols.includes("mode")) sqlite.exec("ALTER TABLE invite_codes ADD COLUMN mode TEXT NOT NULL DEFAULT 'single'");
  if (!inviteCols.includes("max_uses")) sqlite.exec("ALTER TABLE invite_codes ADD COLUMN max_uses INTEGER");
  if (!inviteCols.includes("redemption_count")) sqlite.exec("ALTER TABLE invite_codes ADD COLUMN redemption_count INTEGER NOT NULL DEFAULT 0");
  if (!inviteCols.includes("archived_at")) sqlite.exec("ALTER TABLE invite_codes ADD COLUMN archived_at INTEGER");
  if (!inviteCols.includes("balance_below")) sqlite.exec("ALTER TABLE invite_codes ADD COLUMN balance_below REAL");
  if (!inviteCols.includes("credit_expires_at")) sqlite.exec("ALTER TABLE invite_codes ADD COLUMN credit_expires_at INTEGER");
  const redemptionCols = (sqlite.prepare("PRAGMA table_info(code_redemptions)").all() as { name: string }[]).map((c) => c.name);
  if (!redemptionCols.includes("balance_before")) sqlite.exec("ALTER TABLE code_redemptions ADD COLUMN balance_before REAL");
  if (!redemptionCols.includes("balance_below")) sqlite.exec("ALTER TABLE code_redemptions ADD COLUMN balance_below REAL");
  if (!redemptionCols.includes("credit_expires_at")) sqlite.exec("ALTER TABLE code_redemptions ADD COLUMN credit_expires_at INTEGER");
  sqlite.exec(`
    UPDATE invite_codes
    SET mode = 'single', redemption_count = 1
    WHERE used_by IS NOT NULL AND redemption_count = 0;
    INSERT OR IGNORE INTO code_redemptions (code_id, code, user_id, amount, redeemed_at)
    SELECT id, code, used_by, COALESCE(amount, 0), COALESCE(used_at, created_at)
    FROM invite_codes
    WHERE type = 'redeem' AND used_by IS NOT NULL;
  `);

  const drawCols = (sqlite.prepare("PRAGMA table_info(draws)").all() as { name: string }[]).map((c) => c.name);
  if (!drawCols.includes("request_id")) sqlite.exec("ALTER TABLE draws ADD COLUMN request_id TEXT");
  if (!drawCols.includes("config_snapshot")) sqlite.exec("ALTER TABLE draws ADD COLUMN config_snapshot TEXT NOT NULL DEFAULT ''");
  if (!drawCols.includes("fund_before_units")) sqlite.exec("ALTER TABLE draws ADD COLUMN fund_before_units INTEGER");
  if (!drawCols.includes("fund_after_units")) sqlite.exec("ALTER TABLE draws ADD COLUMN fund_after_units INTEGER");
  sqlite.exec(`
    DROP INDEX IF EXISTS draws_ip_unique;
    DROP INDEX IF EXISTS draws_user_idx;
    CREATE INDEX IF NOT EXISTS draws_ip_idx ON draws (ip);
    UPDATE draws SET user_id = NULL
    WHERE user_id IS NOT NULL AND id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY won DESC, id ASC) AS row_number
        FROM draws WHERE user_id IS NOT NULL
      ) WHERE row_number = 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS draws_user_unique ON draws (user_id) WHERE user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS draws_request_unique ON draws (request_id) WHERE request_id IS NOT NULL;
  `);

  // models 增加 upstream_id（上游渠道外键）
  const mcols = (sqlite.prepare("PRAGMA table_info(models)").all() as { name: string }[]).map((c) => c.name);
  if (!mcols.includes("upstream_id")) sqlite.exec("ALTER TABLE models ADD COLUMN upstream_id INTEGER");
  // api_keys 增加 quota（密钥独立额度）
  const kcols = (sqlite.prepare("PRAGMA table_info(api_keys)").all() as { name: string }[]).map((c) => c.name);
  if (!kcols.includes("quota")) sqlite.exec("ALTER TABLE api_keys ADD COLUMN quota REAL");
  if (!kcols.includes("expires_at")) sqlite.exec("ALTER TABLE api_keys ADD COLUMN expires_at INTEGER");
  if (!kcols.includes("last_used_ip")) sqlite.exec("ALTER TABLE api_keys ADD COLUMN last_used_ip TEXT");

  const ucols = (sqlite.prepare("PRAGMA table_info(upstreams)").all() as { name: string }[]).map((c) => c.name);
  const upstreamColumns: Array<[string, string]> = [
    ["timeout_ms", "INTEGER NOT NULL DEFAULT 60000"],
    ["last_tested_at", "INTEGER"],
    ["last_test_ok", "INTEGER"],
    ["last_test_latency_ms", "INTEGER"],
    ["last_test_message", "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, definition] of upstreamColumns) {
    if (!ucols.includes(name)) sqlite.exec(`ALTER TABLE upstreams ADD COLUMN ${name} ${definition}`);
  }

  const lcols = (sqlite.prepare("PRAGMA table_info(usage_logs)").all() as { name: string }[]).map((c) => c.name);
  const usageColumns: Array<[string, string]> = [
    ["api_key_name", "TEXT NOT NULL DEFAULT ''"],
    ["api_key_prefix", "TEXT NOT NULL DEFAULT ''"],
    ["request_id", "TEXT NOT NULL DEFAULT ''"],
    ["protocol", "TEXT NOT NULL DEFAULT 'chat'"],
    ["upstream_id", "INTEGER"],
    ["endpoint", "TEXT NOT NULL DEFAULT ''"],
    ["request_body", "TEXT NOT NULL DEFAULT ''"],
    ["response_body", "TEXT NOT NULL DEFAULT ''"],
    ["http_status", "INTEGER NOT NULL DEFAULT 200"],
    ["upstream_request_id", "TEXT NOT NULL DEFAULT ''"],
    ["error_message", "TEXT NOT NULL DEFAULT ''"],
    ["usage_source", "TEXT NOT NULL DEFAULT 'estimated'"],
    ["cache_status", "TEXT NOT NULL DEFAULT 'unknown'"],
    ["input_cost", "REAL NOT NULL DEFAULT 0"],
    ["output_cost", "REAL NOT NULL DEFAULT 0"],
    ["cache_write_cost", "REAL NOT NULL DEFAULT 0"],
    ["cache_read_cost", "REAL NOT NULL DEFAULT 0"],
    ["group_multiplier", "REAL NOT NULL DEFAULT 1"],
  ];
  for (const [name, definition] of usageColumns) {
    if (!lcols.includes(name)) sqlite.exec(`ALTER TABLE usage_logs ADD COLUMN ${name} ${definition}`);
  }

  const checkinCols = (sqlite.prepare("PRAGMA table_info(checkins)").all() as { name: string }[]).map((c) => c.name);
  const checkinColumns: Array<[string, string]> = [
    ["request_id", "TEXT"],
    ["bet", "REAL NOT NULL DEFAULT 0"],
    ["symbols", "TEXT NOT NULL DEFAULT ''"],
    ["payout_multiplier", "REAL NOT NULL DEFAULT 0"],
    ["gross_payout", "REAL NOT NULL DEFAULT 0"],
    ["config_version", "TEXT NOT NULL DEFAULT 'legacy'"],
    ["config_id", "INTEGER"],
    ["prize_tier", "TEXT NOT NULL DEFAULT 'legacy'"],
    ["rules_snapshot", "TEXT NOT NULL DEFAULT ''"],
    ["win_rate_ppm", "INTEGER NOT NULL DEFAULT 0"],
    ["rtp_ppm", "INTEGER NOT NULL DEFAULT 0"],
    ["fund_before_units", "INTEGER"],
    ["fund_after_units", "INTEGER"],
    ["promotion_id", "INTEGER"],
    ["promotion_budget_before_units", "INTEGER"],
    ["promotion_budget_after_units", "INTEGER"],
  ];
  for (const [name, definition] of checkinColumns) {
    if (!checkinCols.includes(name)) sqlite.exec(`ALTER TABLE checkins ADD COLUMN ${name} ${definition}`);
  }
  sqlite.exec("DROP INDEX IF EXISTS checkins_user_day_unique");
  sqlite.exec("CREATE INDEX IF NOT EXISTS checkins_user_day_idx ON checkins (user_id, day)");
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS checkins_request_id_unique ON checkins (request_id) WHERE request_id IS NOT NULL");
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS usage_request_id_idx ON usage_logs (request_id) WHERE request_id != ''");

  // 决斗场早期版本兼容：明确赢家税与排行榜可聚合快照，不从当前余额反推历史输赢。
  const duelConfigCols = (sqlite.prepare("PRAGMA table_info(duel_configs)").all() as { name: string }[]).map((c) => c.name);
  if (!duelConfigCols.includes("winner_tax_basis_points")) {
    sqlite.exec("ALTER TABLE duel_configs ADD COLUMN winner_tax_basis_points INTEGER NOT NULL DEFAULT 300");
    sqlite.exec("UPDATE duel_configs SET winner_tax_basis_points = fee_basis_points");
  }
  const duelConfigCompatibilityColumns: Array<[string, string]> = [
    ["min_bet_units", "INTEGER NOT NULL DEFAULT 100000"],
    ["max_bet_units", "INTEGER NOT NULL DEFAULT 5000000"],
    ["bet_precision", "INTEGER NOT NULL DEFAULT 2"],
  ];
  for (const [name, definition] of duelConfigCompatibilityColumns) {
    if (!duelConfigCols.includes(name)) sqlite.exec(`ALTER TABLE duel_configs ADD COLUMN ${name} ${definition}`);
  }
  sqlite.exec("UPDATE duel_configs SET max_bet_units = single_bet_limit_units WHERE max_bet_units > single_bet_limit_units OR max_bet_units = 5000000");
  const duelRoomCols = (sqlite.prepare("PRAGMA table_info(duel_rooms)").all() as { name: string }[]).map((c) => c.name);
  const duelRoomColumns: Array<[string, string]> = [
    ["winner_tax_basis_points", "INTEGER NOT NULL DEFAULT 300"],
    ["gross_prize_pool_units", "INTEGER NOT NULL DEFAULT 0"],
    ["winner_tax_units", "INTEGER NOT NULL DEFAULT 0"],
    ["net_prize_pool_units", "INTEGER NOT NULL DEFAULT 0"],
    ["voided_at", "INTEGER"],
    ["void_reason", "TEXT"],
  ];
  for (const [name, definition] of duelRoomColumns) {
    if (!duelRoomCols.includes(name)) sqlite.exec(`ALTER TABLE duel_rooms ADD COLUMN ${name} ${definition}`);
  }
  sqlite.exec(`
    UPDATE duel_rooms SET
      winner_tax_basis_points = fee_basis_points,
      gross_prize_pool_units = pot_units,
      winner_tax_units = fee_units,
      net_prize_pool_units = MAX(0, pot_units - fee_units);
  `);
  const duelPlayerCols = (sqlite.prepare("PRAGMA table_info(duel_players)").all() as { name: string }[]).map((c) => c.name);
  const duelPlayerColumns: Array<[string, string]> = [
    ["game_type", "TEXT NOT NULL DEFAULT 'dice'"],
    ["settled_net_units", "INTEGER NOT NULL DEFAULT 0"],
    ["result", "TEXT NOT NULL DEFAULT 'pending'"],
    ["hand_rank_json", "TEXT NOT NULL DEFAULT '{}'"],
    ["settled_at", "INTEGER"],
    ["voided_at", "INTEGER"],
  ];
  for (const [name, definition] of duelPlayerColumns) {
    if (!duelPlayerCols.includes(name)) sqlite.exec(`ALTER TABLE duel_players ADD COLUMN ${name} ${definition}`);
  }
    sqlite.exec(`
      UPDATE duel_players SET
      game_type = COALESCE((SELECT game FROM duel_rooms WHERE duel_rooms.id = duel_players.room_id), game_type),
      settled_net_units = CASE WHEN status IN ('winner', 'lost', 'refunded') THEN payout_units - stake_units ELSE settled_net_units END,
      result = CASE status WHEN 'winner' THEN 'win' WHEN 'lost' THEN 'loss' WHEN 'refunded' THEN 'refund' ELSE result END,
      settled_at = CASE WHEN status IN ('winner', 'lost', 'refunded') THEN COALESCE(settled_at, (SELECT finished_at FROM duel_rooms WHERE duel_rooms.id = duel_players.room_id)) ELSE settled_at END,
      voided_at = CASE WHEN status = 'refunded' THEN COALESCE(voided_at, (SELECT finished_at FROM duel_rooms WHERE duel_rooms.id = duel_players.room_id)) ELSE voided_at END;
    `);
    sqlite.exec("CREATE INDEX IF NOT EXISTS duel_players_leaderboard_idx ON duel_players (result, game_type, settled_at)");
    const duelRoundResultCols = (sqlite.prepare("PRAGMA table_info(duel_round_results)").all() as { name: string }[]).map((c) => c.name);
    if (!duelRoundResultCols.includes("hand_rank_json")) {
      sqlite.exec("ALTER TABLE duel_round_results ADD COLUMN hand_rank_json TEXT NOT NULL DEFAULT '{}'");
    }
    sqlite.exec(`
      INSERT OR IGNORE INTO duel_round_results (
        room_id, round_no, user_id, game_type, seat, status, result,
        balance_before_units, stake_units, payout_units, settled_net_units, hand_json, hand_rank_json, score,
        bet_units, pot_units, winner_tax_basis_points, gross_prize_pool_units,
        winner_tax_units, net_prize_pool_units, seed_hash, seed_reveal, started_at, settled_at
      )
      SELECT
        p.room_id, r.round_no, p.user_id, p.game_type, p.seat, p.status, p.result,
        p.balance_before_units, p.stake_units, p.payout_units, p.settled_net_units, p.hand_json, p.hand_rank_json, p.score,
        r.bet_units, r.pot_units, r.winner_tax_basis_points, r.gross_prize_pool_units,
        r.winner_tax_units, r.net_prize_pool_units, r.seed_hash, r.seed_reveal, r.started_at,
        COALESCE(p.settled_at, r.finished_at, r.created_at)
      FROM duel_players p
      INNER JOIN duel_rooms r ON r.id = p.room_id
      WHERE r.status IN ('settled', 'refunded') AND r.voided_at IS NULL AND p.result IN ('win', 'loss', 'refund');
    `);
  const peerLoanCols = (sqlite.prepare("PRAGMA table_info(peer_loans)").all() as { name: string }[]).map((row) => row.name);
  if (!peerLoanCols.includes("offer_expires_at")) {
    sqlite.exec("ALTER TABLE peer_loans ADD COLUMN offer_expires_at INTEGER NOT NULL DEFAULT 0");
    sqlite.exec("UPDATE peer_loans SET offer_expires_at = offered_at + 300000 WHERE offer_expires_at = 0");
  }
  if (!peerLoanCols.includes("terminal_reason")) sqlite.exec("ALTER TABLE peer_loans ADD COLUMN terminal_reason TEXT");
  if (!peerLoanCols.includes("rule_snapshot_json")) sqlite.exec("ALTER TABLE peer_loans ADD COLUMN rule_snapshot_json TEXT NOT NULL DEFAULT '{}'");
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS usage_status_created_idx ON usage_logs (status, created_at, user_id);
    CREATE INDEX IF NOT EXISTS usage_model_created_idx ON usage_logs (model, created_at);
    CREATE INDEX IF NOT EXISTS checkins_created_user_idx ON checkins (created_at, user_id);
    CREATE INDEX IF NOT EXISTS daily_signins_created_user_idx ON daily_signins (created_at, user_id);
    CREATE INDEX IF NOT EXISTS money_transfers_status_created_idx ON money_transfers (status, created_at);
    CREATE INDEX IF NOT EXISTS peer_loans_status_accepted_idx ON peer_loans (status, accepted_at);
  `);

  // 模型名唯一（老库若有重名则跳过，不影响运行）
  try {
    sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS models_name_unique ON models (name)");
  } catch { /* 老数据有重名时放弃唯一索引 */ }

  // 旧模型数据迁移：按 (地址, 密钥) 去重生成上游渠道并回链
  const orphans = sqlite
    .prepare("SELECT id, upstream_base_url, upstream_key FROM models WHERE upstream_id IS NULL AND upstream_base_url != ''")
    .all() as { id: number; upstream_base_url: string; upstream_key: string }[];
  for (const m of orphans) {
    let up = sqlite
      .prepare("SELECT id FROM upstreams WHERE base_url = ? AND api_key = ?")
      .get(m.upstream_base_url, m.upstream_key) as { id: number } | undefined;
    if (!up) {
      const host = m.upstream_base_url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      const r = sqlite
        .prepare("INSERT INTO upstreams (name, base_url, api_key) VALUES (?, ?, ?)")
        .run(`迁移·${host}`, m.upstream_base_url, m.upstream_key);
      up = { id: Number(r.lastInsertRowid) };
    }
    sqlite.prepare("UPDATE models SET upstream_id = ? WHERE id = ?").run(up.id, m.id);
  }
}

function seedSlotControl(sqlite: InstanceType<typeof Database>) {
  const insertConfig = (rules: typeof DEFAULT_SLOT_RULES, status: "active" | "retired") => {
    const metrics = slotMetrics(rules);
    sqlite.prepare(`
      INSERT OR IGNORE INTO slot_configs (
        version, name, mode, status, rules_json, min_bet_units, max_bet_units,
        win_rate_ppm, rtp_ppm, max_multiplier_basis_points, max_net_liability_units, activated_at
      ) VALUES (?, ?, 'base', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rules.version,
      rules.name,
      status,
      serializeSlotRules(rules),
      rules.minBetUnits,
      rules.maxBetUnits,
      metrics.winRatePpm,
      metrics.rtpPpm,
      metrics.maxMultiplierBasisPoints,
      metrics.maxNetLiabilityUnits,
      status === "active" ? Date.now() : null,
    );
  };

  insertConfig(LEGACY_SLOT_RULES, "retired");
  // Only auto-upgrade the original, unmodified system preset on first v3 seed.
  // An operator's custom table (or deliberate later reactivation) must survive restarts.
  const v3Exists = sqlite.prepare("SELECT 1 FROM slot_configs WHERE version = ?").get(DEFAULT_SLOT_RULES.version);
  if (!v3Exists) {
    sqlite.prepare("UPDATE slot_configs SET status = 'retired' WHERE mode = 'base' AND status = 'active' AND version = ? AND rules_json = ?")
      .run(V2_SLOT_RULES.version, serializeSlotRules(V2_SLOT_RULES));
  }
  insertConfig(V2_SLOT_RULES, "retired");
  const active = sqlite.prepare("SELECT id FROM slot_configs WHERE mode = 'base' AND status = 'active' LIMIT 1").get();
  insertConfig(DEFAULT_SLOT_RULES, active ? "retired" : "active");
  if (!active) {
    sqlite.prepare("UPDATE slot_configs SET status = 'active', activated_at = ? WHERE version = ?")
      .run(Date.now(), DEFAULT_SLOT_RULES.version);
  }

  const day = new Date().toISOString().slice(0, 10);
  const fundInsert = sqlite.prepare(`
    INSERT OR IGNORE INTO slot_fund (
      id, balance_units, reserve_units, daily_loss_limit_units, day, day_net_units
    ) VALUES (1, 1000000, 300000, 300000, ?, 0)
  `).run(day);
  if (fundInsert.changes > 0) {
    sqlite.prepare(`
      INSERT INTO slot_fund_ledger (type, amount_units, balance_after_units, note)
      VALUES ('seed', 1000000, 1000000, '系统迁移初始化奖金池')
    `).run();
  }
}

function seedEntertainmentControl(sqlite: InstanceType<typeof Database>) {
  sqlite.prepare("INSERT OR IGNORE INTO draw_fund (id, balance_units) VALUES (1, 1000000)").run();
  sqlite.prepare("INSERT OR IGNORE INTO signin_fund (id, balance_units) VALUES (1, 1000000)").run();
  sqlite.prepare("INSERT OR IGNORE INTO video_reward_fund (id, balance_units) VALUES (1, 100000000)").run();
  const defaults: Array<[string, string]> = [
    ["draw_enabled", "1"],
    ["draw_total_limit", "0"],
    ["slot_daily_limit", "1"],
    ["business_timezone_offset_minutes", "480"],
    ["business_day_start_hour", "0"],
    ["daily_signin_enabled", "1"],
    ["daily_signin_min_units", "100"],
    ["daily_signin_max_units", "500"],
    ["daily_signin_mode", "range"],
    ["daily_signin_fixed_units", "100"],
    ["daily_signin_tiers_json", '[{"rewardUnits":100,"probabilityPpm":400000},{"rewardUnits":200,"probabilityPpm":250000},{"rewardUnits":300,"probabilityPpm":180000},{"rewardUnits":400,"probabilityPpm":100000},{"rewardUnits":500,"probabilityPpm":70000}]'],
    ["video_reward_enabled", "0"],
    ["video_reward_min_watch_seconds", "15"],
    ["video_reward_min_units", "100000"],
    ["video_reward_max_units", "500000"],
    ["video_reward_daily_budget_units", "50000000"],
    ["video_reward_daily_limit", "1"],
    ["video_reward_use_fund", "1"],
    ["video_reward_video_resource", "/media/lucky-video-red-envelope-15s.mp4"],
  ];
  const insert = sqlite.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const [key, value] of defaults) insert.run(key, value);
  // 旧版默认指向内部生成的 WebM 占位视频；升级时仅迁移该旧默认值，
  // 不覆盖管理员已经配置的其他本地视频资源。
  sqlite.prepare(`
    UPDATE settings
    SET value = ?
    WHERE key = 'video_reward_video_resource' AND value = ?
  `).run(
    "/media/lucky-video-red-envelope-15s.mp4",
    "/media/lucky-video-red-envelope-15s.webm",
  );
}

function seedDuelControl(sqlite: InstanceType<typeof Database>) {
  const active = sqlite.prepare("SELECT id FROM duel_configs WHERE active = 1 ORDER BY version DESC LIMIT 1").get();
  if (!active) {
    sqlite.prepare(`
      INSERT INTO duel_configs (
        version, active, enabled, dice_enabled, blackjack_enabled, winner_tax_basis_points, fee_basis_points,
        bet_options_json, min_players, max_players, room_timeout_seconds,
        action_timeout_seconds, single_bet_limit_units, daily_stake_limit_units,
        daily_net_loss_limit_units
      ) VALUES (1, 1, 1, 1, 1, 300, 300, '[100000,500000,1000000,5000000]', 2, 6, 1800, 60, 5000000, 50000000, 20000000)
    `).run();
  }
  sqlite.prepare("INSERT OR IGNORE INTO duel_fund (id, balance_units) VALUES (1, 0)").run();
}

// The legacy writer debited funds and inserted its escrow row in the same transaction.
// Its terminal statuses already include any payout/refund. Keep those rows as history.
function refundLegacyEscrows(sqlite: InstanceType<typeof Database>) {
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'team_battle_bets'").get()) return;
  const db = drizzle(sqlite, { schema });
  sqlite.transaction(() => {
    const bets = sqlite.prepare(
      "SELECT id, room_id, user_id, request_id, amount_units FROM team_battle_bets WHERE status = 'escrowed' ORDER BY id",
    ).all() as { id: number; room_id: string; user_id: number; request_id: string; amount_units: number }[];
    if (!bets.length) return;
    const now = new Date();
    const markRefunded = sqlite.prepare("UPDATE team_battle_bets SET status = 'refunded', payout_units = ?, settled_at = ? WHERE id = ?");
    const recordRefund = sqlite.prepare(
      `INSERT INTO team_battle_ledger (room_id, user_id, request_id, type, amount_units, user_balance_after_units, note)
       SELECT ?, id, ?, 'refund', ?, ROUND(balance * 1000000), ? FROM users WHERE id = ?`,
    );
    const rooms = new Set<string>();
    for (const bet of bets) {
      const note = `玩法下线退还未结投注（${bet.request_id}）`;
      const refund = reverseUserBalanceDebit(db, {
        userId: bet.user_id, amount: creditUnitsToDollars(bet.amount_units), sourceKind: "team_battle",
        requestId: bet.request_id, note, now,
      });
      const credited = creditDollarsToUnits(refund.credited);
      if (credited > 0) recordTx(db, bet.user_id, "adjust", refund.credited, note);
      recordRefund.run(bet.room_id, bet.request_id, credited, note, bet.user_id);
      const expired = creditDollarsToUnits(refund.expiredTemporary);
      if (expired > 0) {
        sqlite.prepare("UPDATE team_battle_fund SET balance_units = balance_units + ?, updated_at = ? WHERE id = 1").run(expired, now.getTime());
        sqlite.prepare(`INSERT INTO team_battle_ledger (room_id, request_id, type, amount_units, fund_balance_after_units, note)
          SELECT ?, ?, 'expired_credit_forfeit', ?, balance_units, '临时额度已到期' FROM team_battle_fund WHERE id = 1`)
          .run(bet.room_id, bet.request_id, expired);
      }
      markRefunded.run(credited, now.getTime(), bet.id);
      rooms.add(bet.room_id);
    }
    const closeRoom = sqlite.prepare(`UPDATE team_battle_rooms SET status = 'refunded', finished_at = ?,
      payout_units = (SELECT SUM(payout_units) FROM team_battle_bets WHERE room_id = ?), dispute_reason = '玩法下线'
      WHERE id = ?`);
    for (const roomId of rooms) closeRoom.run(now.getTime(), roomId, roomId);
  }).immediate();
}

let instance: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getDb() {
  if (!instance) {
    // Resolve at connection time so isolated jobs can select their database before opening it.
    const target = process.env.SQLITE_PATH || "data/luckydraw.db";
    const dbPath = target === ":memory:" ? target : resolve(target);
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    const sqlite = new Database(dbPath);
    try {
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("busy_timeout = 5000");
      sqlite.exec(DDL);
      sqlite.transaction(() => {
        sqlite.exec(PERP_ENGINE_SCHEMA);
        sqlite.exec(PERP_MARKET_SCHEMA);
        sqlite.exec(PERP_WEEKLY_SCHEMA);
        migratePerpMarginEvents(sqlite);
        ensureSevenPickSchema(sqlite);
        ensureSevenPickLifecycleSchema(sqlite);
        ensureSevenPickTimestampSchema(sqlite);
      }).immediate();
      migratePerpLeverage(sqlite);
      migrate(sqlite);
      refundLegacyEscrows(sqlite);
      sqlite.transaction(() => seedSlotControl(sqlite)).immediate();
      seedEntertainmentControl(sqlite);
      seedDuelControl(sqlite);
      // 预置默认分组
      sqlite
        .prepare("INSERT OR IGNORE INTO \"groups\" (name, multiplier, description) VALUES ('default', 1, '默认分组')")
        .run();
      instance = drizzle(sqlite, { schema });
    } catch (error) {
      sqlite.close();
      throw error;
    }
  }
  return instance;
}
