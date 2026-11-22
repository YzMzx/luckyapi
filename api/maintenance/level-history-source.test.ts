import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readHistory } from "./level-history-source";

const at = Date.UTC(2025, 9, 1, 12);
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE transactions(id INTEGER PRIMARY KEY, user_id INTEGER, kind TEXT, amount REAL, balance_after REAL, note TEXT, created_at INTEGER)"
  );
});
afterEach(() => db.close());
function tx(kind: string, amount: number, note = "", time = at) {
  return Number(
    db
      .prepare(
        "INSERT INTO transactions(user_id,kind,amount,balance_after,note,created_at) VALUES (1,?,?,20,?,?)"
      )
      .run(kind, amount, note, time).lastInsertRowid
  );
}
function amounts() {
  return readHistory(db).events.map(e => [e.key, e.usdUnits ?? e.fixedExp]);
}

it("uses exact business keys, micro-USD and recorded dates from a read-only database", () => {
  db.exec(
    "CREATE TABLE daily_signins(id INTEGER PRIMARY KEY,user_id,day,created_at,reward_units)"
  );
  db.prepare("INSERT INTO daily_signins VALUES (1,1,'2025-10-01',?,25)").run(
    at / 1000
  );
  tx("checkin", 0.25, "每日签到（业务日 2025-10-01）");
  tx("checkin", 0.01, "老虎机：下注 $0.10");
  tx("usage", -0.000001, "", at + 123);
  tx("draw", 0.03);
  tx("redeem", 2);
  tx("video_reward", 0.02);
  tx("report", 0.04);
  tx("transfer_in", 10);
  tx("loan_disbursement", 2);
  tx("loan_offer_refund", 3);
  tx("usage", 0);
  tx("checkin", -0.1);
  db.pragma("query_only=ON");
  const history = readHistory(db);
  expect(history.warnings).toEqual([]);
  expect(history.events[0]).toEqual({
    userId: 1,
    key: "signin:2025-10-01",
    at,
    fixedExp: 200,
  });
  expect(history.events.at(-1)).toEqual({
    userId: 1,
    key: "api_usage:ledger:3",
    at: at + 123,
    source: "api_usage",
    usdUnits: 1,
  });
  expect(amounts()).toEqual([
    ["signin:2025-10-01", 200],
    ["income:ledger:1", 250000],
    ["income:ledger:2", 10000],
    ["income:ledger:4", 30000],
    ["income:ledger:5", 2000000],
    ["income:ledger:6", 20000],
    ["income:ledger:7", 40000],
    ["api_usage:ledger:3", 1],
  ]);
});

it("replays net contract redemptions with the same principal-first rule", () => {
  tx("perp_exchange_in", -10);
  tx("perp_exchange_out", 9.5);
  tx("perp_exchange_out", 1.9);
  tx("perp_exchange_in", -2);
  tx("perp_exchange_out", 1.9);
  expect(readHistory(db).warnings).toEqual([]);
  expect(amounts()).toEqual([["income:ledger:3", 1_400_000]]);
});
it("recovers the business day from explicit legacy signin receipts and excludes repair credits", () => {
  tx("checkin", 0, "每日签到（业务日 2025-10-01）");
  tx("adjust", 4, "管理员调整（请求 -1，余额下限 0，实际 4）");
  tx("adjust", 4, "管理员调整（请求 0.125，余额下限 0，实际 4）");
  tx("adjust", 1, "管理员调整");
  tx("adjust", 1, "玩法下线退还未结投注（id）");
  tx("duel", 4, "决斗房 AB 全员爆牌退款");
  expect(readHistory(db).warnings).toEqual([]);
  expect(amounts()).toEqual([
    ["signin:2025-10-01", 200],
    ["income:ledger:3", 125000],
    ["income:ledger:4", 1000000],
  ]);
});

it("flags a surviving signin whose money receipt was purged", () => {
  db.exec(
    "CREATE TABLE daily_signins(id INTEGER PRIMARY KEY,user_id,day,created_at,reward_units)"
  );
  db.prepare("INSERT INTO daily_signins VALUES(1,1,'2025-10-01',?,25)").run(at);
  const history = readHistory(db);
  expect(history.events).toEqual([
    { userId: 1, key: "signin:2025-10-01", at, fixedExp: 200 },
  ]);
  expect(history.warnings).toHaveLength(1);
});

it("requires corroborated net loan receipts and duel payouts", () => {
  db.exec(`CREATE TABLE peer_loans(id,lender_id); INSERT INTO peer_loans VALUES(10,1);
  CREATE TABLE peer_loan_ledger(id INTEGER PRIMARY KEY, loan_id, type, amount_units, principal_units, interest_units, tax_units, lender_balance_after_units, created_at);
  CREATE TABLE duel_rooms(id,code,bet_units); INSERT INTO duel_rooms VALUES('r','ROOM',1000000);
  CREATE TABLE duel_ledger(id INTEGER PRIMARY KEY,room_id,user_id,type,note,amount_units,user_balance_after_units,created_at);`);
  const repayment = db.prepare(
    "INSERT INTO peer_loan_ledger VALUES(?,10,?,?,?,?,?,20000000,?)"
  );
  [
    ["early_repayment", "提前还款"],
    ["due_collection", "到期回收"],
    ["income_interception", "后续回收"],
  ].forEach(([type, label], i) => {
    tx("loan_repayment", 10.9, "借贷 #10 " + label);
    repayment.run(i + 1, type, 11000000, 10000000, 1000000, 100000, at);
  });
  tx("duel", 1.94, "决斗房 ROOM 结算入账");
  db.prepare(
    "INSERT INTO duel_ledger VALUES(1,'r',1,'payout','决斗房 ROOM 结算入账',1940000,20000000,?)"
  ).run(at);
  expect(readHistory(db).warnings).toEqual([]);
  expect(amounts()).toEqual([
    ["income:ledger:1", 900000],
    ["income:ledger:2", 900000],
    ["income:ledger:3", 900000],
    ["income:ledger:4", 940000],
  ]);
  db.exec(
    "INSERT INTO peer_loan_ledger SELECT 99,loan_id,type,amount_units,principal_units,interest_units,tax_units,lender_balance_after_units,created_at FROM peer_loan_ledger WHERE id=1"
  );
  tx("duel", 1.94, "决斗房 ROOM 结算入账"); // duplicate payout match
  const invalid = readHistory(db);
  expect(invalid.warnings).toHaveLength(2);
  expect(invalid.events.some(e => e.key === "income:ledger:1")).toBe(false);
});

it("deducts all retired team-battle stakes before awarding a payout", () => {
  db.exec(`CREATE TABLE team_battle_rooms(id,code); INSERT INTO team_battle_rooms VALUES ('r','X');
    CREATE TABLE team_battle_ledger(id,room_id,user_id,type,note,amount_units,user_balance_after_units,created_at);
    CREATE TABLE team_battle_bets(room_id,user_id,amount_units,status,payout_units);
    INSERT INTO team_battle_bets VALUES ('r',1,1000000,'won',2400000),('r',1,100000,'lost',0);`);
  db.prepare(
    "INSERT INTO team_battle_ledger VALUES (1,'r',1,'winner_payout','战队房 X 胜方本金及分成',2400000,20000000,?)"
  ).run(at);
  tx("team_battle", 2.4, "战队房 X 胜方本金及分成");
  tx("team_battle", 0.01, "战队房 X 选手税分成");
  tx("team_battle", 10, "战队房 X 争议作废退款");
  expect(readHistory(db).warnings).toEqual([]);
  expect(amounts()).toEqual([
    ["income:ledger:1", 1300000],
    ["income:ledger:2", 10000],
  ]);
});

it("reports missing, malformed and ambiguous history without inventing credits", () => {
  tx("adjust", 1, "？？");
  tx("unexpected", 1);
  tx("draw", 0.0000001);
  tx("loan_repayment", 10, "借贷 #10 提前还款");
  tx("usage", -1, "", 0);
  expect(readHistory(db).events).toEqual([]);
  expect(readHistory(db).warnings).toHaveLength(5);
  db.exec("DROP TABLE transactions");
  expect(readHistory(db).warnings).toHaveLength(1);
});
