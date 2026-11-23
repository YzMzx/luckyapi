import type Database from "better-sqlite3";

const REVIEWS_SCHEMA = `
CREATE TABLE IF NOT EXISTS seven_pick_reviews (
  round_id INTEGER PRIMARY KEY REFERENCES seven_pick_rounds(id),
  reason TEXT NOT NULL CHECK(reason IN ('quicknet_unpublished','ots_ineligible')),
  reviewer TEXT NOT NULL CHECK(length(reviewer) BETWEEN 1 AND 120),
  notes TEXT NOT NULL CHECK(length(notes) BETWEEN 1 AND 2000),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  reviewed_at INTEGER NOT NULL CHECK(reviewed_at>0)
);
`;

const LIFECYCLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS seven_pick_seals (
  round_id INTEGER PRIMARY KEY REFERENCES seven_pick_rounds(id),
  sealed_at INTEGER NOT NULL CHECK(sealed_at>0),
  commitment_hex TEXT NOT NULL CHECK(length(commitment_hex)=64 AND commitment_hex NOT GLOB '*[^0-9a-f]*'),
  anonymous_json TEXT NOT NULL CHECK(json_valid(anonymous_json)),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
);
CREATE TABLE IF NOT EXISTS seven_pick_draws (
  round_id INTEGER PRIMARY KEY REFERENCES seven_pick_seals(round_id),
  settled_at INTEGER NOT NULL CHECK(settled_at>0),
  quicknet_round INTEGER NOT NULL CHECK(quicknet_round>0),
  signature TEXT NOT NULL CHECK(length(signature)=96 AND signature NOT GLOB '*[^0-9a-f]*'),
  randomness_hex TEXT NOT NULL CHECK(length(randomness_hex)=64 AND randomness_hex NOT GLOB '*[^0-9a-f]*'),
  item_ids_json TEXT NOT NULL CHECK(json_valid(item_ids_json)),
  total_payout_units INTEGER NOT NULL CHECK(typeof(total_payout_units)='integer' AND total_payout_units BETWEEN 0 AND 9007199254740991),
  upper_bound_ms INTEGER NOT NULL CHECK(upper_bound_ms>0),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  timing_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(timing_json) AND json_type(timing_json)='array'),
  test_only INTEGER NOT NULL CHECK(test_only IN (0,1))
);
${REVIEWS_SCHEMA}
CREATE TABLE IF NOT EXISTS seven_pick_audit (
  id INTEGER PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES seven_pick_rounds(id),
  kind TEXT NOT NULL CHECK(kind IN ('sealed','quicknet','ots','review_needed','review_approved','settled','refund_batch','refunded')),
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  created_at INTEGER NOT NULL CHECK(created_at>0)
);
CREATE TABLE IF NOT EXISTS seven_pick_timing_evidence (
  audit_id INTEGER PRIMARY KEY REFERENCES seven_pick_audit(id),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='object')
);
CREATE TABLE IF NOT EXISTS seven_pick_quicknet_seals (
  round_id INTEGER PRIMARY KEY REFERENCES seven_pick_seals(round_id)
);
CREATE TABLE IF NOT EXISTS seven_pick_quicknet_draws (
  round_id INTEGER PRIMARY KEY REFERENCES seven_pick_quicknet_seals(round_id),
  settled_at INTEGER NOT NULL CHECK(settled_at>0),
  quicknet_round INTEGER NOT NULL CHECK(quicknet_round>0),
  signature TEXT NOT NULL CHECK(length(signature)=96 AND signature NOT GLOB '*[^0-9a-f]*'),
  randomness_hex TEXT NOT NULL CHECK(length(randomness_hex)=64 AND randomness_hex NOT GLOB '*[^0-9a-f]*'),
  item_ids_json TEXT NOT NULL CHECK(json_valid(item_ids_json) AND json_type(item_ids_json)='array'),
  total_payout_units INTEGER NOT NULL CHECK(typeof(total_payout_units)='integer' AND total_payout_units BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE IF NOT EXISTS seven_pick_quicknet_reviews (
  round_id INTEGER PRIMARY KEY REFERENCES seven_pick_quicknet_seals(round_id),
  reason TEXT NOT NULL CHECK(reason='seal_missed'),
  reviewer TEXT NOT NULL CHECK(length(reviewer) BETWEEN 1 AND 120),
  notes TEXT NOT NULL CHECK(length(notes) BETWEEN 1 AND 2000),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  reviewed_at INTEGER NOT NULL CHECK(reviewed_at>0)
);
CREATE INDEX IF NOT EXISTS seven_pick_audit_round_kind ON seven_pick_audit(round_id, kind, id);
CREATE INDEX IF NOT EXISTS seven_pick_rounds_lifecycle ON seven_pick_rounds(status, closes_at, id);

CREATE TRIGGER IF NOT EXISTS seven_pick_no_round_rewrite
BEFORE UPDATE OF config_version_id,enabled,opens_at,closes_at,draw_at,quicknet_round,quicknet_scheduled_at,
  quicknet_network,quicknet_chain_hash,quicknet_public_key,quicknet_scheme,algorithm_version,
  min_stake_units,max_stake_units,multipliers_json,created_at ON seven_pick_rounds
BEGIN SELECT RAISE(ABORT,'七星寻宝场次规则不可修改'); END;
CREATE TRIGGER IF NOT EXISTS seven_pick_round_status_transitions
BEFORE UPDATE OF status ON seven_pick_rounds WHEN NOT (
  OLD.status=NEW.status OR
  (OLD.status='scheduled' AND NEW.status IN ('open','risk_skipped','review')) OR
  (OLD.status='open' AND NEW.status='sealed') OR
  (OLD.status='sealed' AND NEW.status IN ('ots_waiting','review','settled')) OR
  (OLD.status='ots_waiting' AND NEW.status IN ('review','settled')) OR
  (OLD.status='review' AND NEW.status IN ('settled','refunding')) OR
  (OLD.status='refunding' AND NEW.status='refunded')
) BEGIN SELECT RAISE(ABORT,'七星寻宝场次状态不可回退'); END;
CREATE TRIGGER IF NOT EXISTS seven_pick_no_new_sealed_order BEFORE INSERT ON seven_pick_orders
WHEN EXISTS (SELECT 1 FROM seven_pick_seals WHERE round_id=NEW.round_id)
BEGIN SELECT RAISE(ABORT,'七星寻宝封盘场次不可追加订单'); END;
CREATE TRIGGER IF NOT EXISTS seven_pick_no_new_sealed_bet BEFORE INSERT ON seven_pick_bets
WHEN EXISTS (SELECT 1 FROM seven_pick_seals WHERE round_id=NEW.round_id)
BEGIN SELECT RAISE(ABORT,'七星寻宝封盘场次不可追加投注'); END;
CREATE TRIGGER IF NOT EXISTS seven_pick_no_rewrite_sealed_bet BEFORE UPDATE ON seven_pick_bets
WHEN EXISTS (SELECT 1 FROM seven_pick_seals WHERE round_id IN (OLD.round_id,NEW.round_id))
BEGIN SELECT RAISE(ABORT,'七星寻宝封盘投注不可修改'); END;
CREATE TRIGGER IF NOT EXISTS seven_pick_no_delete_sealed_bet BEFORE DELETE ON seven_pick_bets
WHEN EXISTS (SELECT 1 FROM seven_pick_seals WHERE round_id=OLD.round_id)
BEGIN SELECT RAISE(ABORT,'七星寻宝封盘投注不可删除'); END;
CREATE TRIGGER IF NOT EXISTS seven_pick_no_new_late_stake BEFORE INSERT ON seven_pick_ledger
WHEN NEW.kind='stake' AND EXISTS (SELECT 1 FROM seven_pick_seals WHERE round_id=NEW.round_id)
BEGIN SELECT RAISE(ABORT,'七星寻宝封盘后不可扣款'); END;
`;

export function ensureSevenPickLifecycleSchema(db: Database.Database) {
  db.transaction(() => {
    db.exec(LIFECYCLE_SCHEMA);
    const drawColumns = db.prepare<[], { name: string }>("PRAGMA table_info(seven_pick_draws)").all();
    if (!drawColumns.some(column => column.name === "timing_json")) {
      db.exec("ALTER TABLE seven_pick_draws ADD COLUMN timing_json TEXT NOT NULL DEFAULT '[]' " +
        "CHECK(json_valid(timing_json) AND json_type(timing_json)='array')");
    }
    const uniqueness = {
      seals: "round_id=NEW.round_id",
      draws: "round_id=NEW.round_id",
      reviews: "round_id=NEW.round_id",
      audit: "id=NEW.id",
      timing_evidence: "audit_id=NEW.audit_id",
      quicknet_seals: "round_id=NEW.round_id",
      quicknet_draws: "round_id=NEW.round_id",
      quicknet_reviews: "round_id=NEW.round_id",
      round_items: "round_id=NEW.round_id AND (item_id=NEW.item_id OR position=NEW.position)",
      ledger: "id=NEW.id OR (bet_id=NEW.bet_id AND (kind=NEW.kind OR (kind IN ('payout','refund') AND NEW.kind IN ('payout','refund'))))",
    };
    for (const [table, existing] of Object.entries(uniqueness)) {
      for (const operation of ["UPDATE", "DELETE"]) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS seven_pick_no_${operation.toLowerCase()}_${table}
          BEFORE ${operation} ON seven_pick_${table}
          BEGIN SELECT RAISE(ABORT,'七星寻宝记录仅可追加'); END;`);
      }
      // REPLACE can suppress the delete trigger when recursive triggers are off.
      db.exec(`CREATE TRIGGER IF NOT EXISTS seven_pick_no_replace_${table}
        BEFORE INSERT ON seven_pick_${table}
        WHEN EXISTS (SELECT 1 FROM seven_pick_${table} WHERE ${existing})
        BEGIN SELECT RAISE(ABORT,'七星寻宝记录不可覆盖'); END;`);
    }
  }).immediate();
}
