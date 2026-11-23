import type Database from "better-sqlite3";
import { ensureSevenPickSchema } from "../seven-pick/schema";

export function seedGameRound(db: Database.Database, at: number) {
  ensureSevenPickSchema(db);
  db.prepare(
    `INSERT INTO seven_pick_config_versions(
    id,effective_at,created_at,enabled,open_minutes_json,close_after_minutes,
    draw_after_minutes,min_stake_units,max_stake_units,multipliers_json
  ) VALUES(1,?,?,1,'[780]',10,20,1000,100000,'[0,0,0,3,12,100,1000,50000]')`
  ).run(at, at - 1);
  db.prepare(
    `INSERT INTO seven_pick_rounds(
    id,config_version_id,status,enabled,opens_at,closes_at,draw_at,quicknet_round,
    quicknet_scheduled_at,quicknet_network,quicknet_chain_hash,quicknet_public_key,
    quicknet_scheme,algorithm_version,min_stake_units,max_stake_units,multipliers_json,created_at
  ) VALUES(1,1,'open',1,?,?,?,1,?,'quicknet','chain','key','scheme','v1',1000,100000,
    '[0,0,0,3,12,100,1000,50000]',?)`
  ).run(at, at + 600_000, at + 1_200_000, at + 1_200_000, at);
}

export function seedGameBet(
  db: Database.Database,
  betId: number,
  userId: number,
  stake: number,
  at: number
) {
  db.prepare(
    `INSERT INTO seven_pick_orders(
    id,round_id,user_id,request_key,payload_hash,total_stake_units,created_at
  ) VALUES(?,1,?,?,?,?,?)`
  ).run(betId, userId, `game-${betId}`, "a".repeat(64), stake, at);
  db.prepare(
    `INSERT INTO seven_pick_bets(
    id,order_id,round_id,user_id,combination_key,item_mask,stake_units,receipt_id,created_at
  ) VALUES(?,?,1,?,?,127,?,?,?)`
  ).run(
    betId,
    betId,
    userId,
    `combo-${betId}`,
    stake,
    betId.toString(16).padStart(32, "0"),
    at
  );
}
