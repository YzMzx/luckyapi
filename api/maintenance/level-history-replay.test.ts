import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getLevelThreshold } from "@contracts/levels";
import { replayHistory } from "./level-history-replay";
import type { HistoryEvent } from "./level-history-source";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY);
    INSERT INTO users VALUES(1),(2),(3),(4),(5);
    CREATE TABLE level_profiles(user_id INTEGER PRIMARY KEY REFERENCES users(id), total_exp INTEGER, exp_remainder INTEGER, equipped_level INTEGER);
    CREATE TABLE experience_events(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER REFERENCES users(id),event_key TEXT,created_at INTEGER,amount INTEGER,usd_units INTEGER,UNIQUE(user_id,event_key));
    CREATE TABLE level_badges(level INTEGER,rank INTEGER,user_id INTEGER REFERENCES users(id),awarded_at INTEGER,event_id INTEGER REFERENCES experience_events(id), UNIQUE(level,rank), UNIQUE(level,user_id));`);
});
afterEach(() => db.close());
const changes = () => db.prepare("SELECT total_changes()").pluck().get();
const apply = (events: HistoryEvent[]) =>
  db.transaction(() => replayHistory(db, events, true))();

it("replays historical, real-time and manual awards by timestamp, user id and event key while preserving IDs and valid equipment", () => {
  const threshold = getLevelThreshold(20);
  const addManual = db.prepare(
    "INSERT INTO experience_events(id,user_id,event_key,created_at,amount) VALUES(?,?,'manual:award',?,?)"
  );
  const addProfile = db.prepare("INSERT INTO level_profiles VALUES(?,?,0,10)");
  const addSeat = db.prepare("INSERT INTO level_badges VALUES(?,?,?,?,?)");
  // In the live database user 4 arrived first. Backfilled users 1 & 2 tied, and 3 still qualifies.
  for (const [user, at, rank, id] of [
    [4, 4000, 1, 20],
    [3, 5000, 2, 21],
  ]) {
    addManual.run(id, user, at, threshold);
    addProfile.run(user, threshold);
    for (const level of [10, 20]) addSeat.run(level, rank, user, at, id);
  }
  const fixed = (
    userId: number,
    key: string,
    at: number,
    fixedExp: number
  ): HistoryEvent => ({ userId, key, at, fixedExp });
  const input = [
    fixed(2, "signin:b", 1000, threshold),
    fixed(1, "signin:z", 1000, threshold - 1),
    fixed(1, "manual:a", 1000, 1),
    fixed(3, "signin:earlier", 2000, threshold),
  ];
  const before = changes();
  const preview = replayHistory(db, input, false);
  expect(changes()).toEqual(before);
  expect(JSON.parse(JSON.stringify(preview))).toEqual(preview);
  expect(preview.stages[0].before.map(s => s.userId)).toEqual([4, 3]);
  const seats = [
    { rank: 1, userId: 1, at: 1000, eventKey: "signin:z" },
    { rank: 2, userId: 2, at: 1000, eventKey: "signin:b" },
    { rank: 3, userId: 3, at: 2000, eventKey: "signin:earlier" },
  ];
  expect(preview.stages[0].after).toEqual(seats);
  expect(preview.stages[1].after).toEqual(seats);
  expect(apply([...input].reverse())).toEqual(preview);
  expect(
    db
      .prepare(
        "SELECT id FROM experience_events WHERE event_key='manual:award' ORDER BY id"
      )
      .pluck()
      .all()
  ).toEqual([20, 21]);
  expect(preview.users.find(u => u.userId === 3)!.after.equippedLevel).toBe(10);
  expect(
    preview.users.find(u => u.userId === 4)!.after.equippedLevel
  ).toBeNull();
  expect(
    db
      .prepare("SELECT user_id FROM level_profiles ORDER BY user_id")
      .pluck()
      .all()
  ).toEqual([1, 2, 3, 4]);
  const written = changes();
  const again = apply(input);
  expect(again.counts).toMatchObject({
    insertedEvents: 0,
    updatedEvents: 0,
    profileWrites: 0,
    seatDeletes: 0,
    seatUpdates: 0,
    seatInserts: 0,
  });
  expect(changes()).toBe(written);
});

it("revalues a matched live event when a historical fractional award precedes it, across two USD rates", () => {
  db.exec(`INSERT INTO experience_events VALUES (93,1,'api_usage:ledger:10',9000,0,40000);
    INSERT INTO level_profiles VALUES(1,0,400000,NULL)`);
  const usage: HistoryEvent = {
    userId: 1,
    key: "api_usage:ledger:10",
    at: 6200,
    usdUnits: 40000,
    source: "api_usage",
  };
  const income: HistoryEvent = {
    userId: 1,
    key: "income:ledger:9",
    at: 5300,
    usdUnits: 6001,
    source: "income",
  };
  const input = [usage, income, usage];
  const report = apply(input);
  expect(report.counts).toMatchObject({
    matchedEvents: 1,
    duplicateInputs: 1,
    insertedEvents: 1,
    updatedEvents: 1,
  });
  expect(report.users[0].after).toMatchObject({
    totalExp: 1,
    expRemainder: 100,
  });
  expect(
    db
      .prepare(
        "SELECT id,amount,created_at FROM experience_events WHERE event_key=?"
      )
      .get(usage.key)
  ).toEqual({ id: 93, amount: 1, created_at: 6200 });
  const written = changes();
  expect(apply(input).counts.updatedEvents).toBe(0);
  expect(changes()).toBe(written);
});

it("rejects mismatched inputs and unexplained balances before writing and enforces the caller transaction", () => {
  const input = { userId: 1, key: "signin:day", at: 400, fixedExp: 200 };
  expect(() => replayHistory(db, [input], true)).toThrow(/事务/);
  apply([input]);
  const written = changes();
  expect(() => apply([input, { ...input, at: 399 }])).toThrow(/时间冲突/);
  expect(() => apply([{ ...input, fixedExp: 201 }])).toThrow(/输入冲突/);
  expect(() => apply([{ ...input, userId: 99 }])).toThrow(/不存在/);
  expect(changes()).toBe(written);
  db.exec("INSERT INTO level_profiles VALUES(2,15,0,NULL)");
  const corrupted = changes();
  expect(() => replayHistory(db, [input], false)).toThrow(/余额/);
  expect(() => apply([input])).toThrow(/余额/);
  expect(changes()).toBe(corrupted);
});

it("lets the caller roll back the complete replay after a late write failure", () => {
  db.exec(
    "CREATE TRIGGER interrupt_seat BEFORE INSERT ON level_badges BEGIN SELECT RAISE(ABORT,'interrupted'); END"
  );
  expect(() =>
    apply([
      { userId: 1, key: "historic", at: 10, fixedExp: getLevelThreshold(10) },
    ])
  ).toThrow("interrupted");
  expect(
    db.prepare("SELECT COUNT(*) FROM experience_events").pluck().get()
  ).toBe(0);
  expect(db.prepare("SELECT COUNT(*) FROM level_profiles").pluck().get()).toBe(
    0
  );
  db.exec("DROP TRIGGER interrupt_seat");
  expect(
    apply([
      { userId: 1, key: "historic", at: 10, fixedExp: getLevelThreshold(10) },
    ]).counts.seatInserts
  ).toBe(1);
});
