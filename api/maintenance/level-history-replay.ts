import type { Database } from "better-sqlite3";
import { MONEY_SCALE } from "@contracts/finance";
import {
  EXP_PER_USD,
  getLevelProgress,
  getLevelThreshold,
  LEVEL_STAGES,
} from "@contracts/levels";
import type { HistoryEvent } from "./level-history-source";

type Snapshot = {
  totalExp: number;
  expRemainder: number;
  level: number;
  equippedLevel: number | null;
};
type Seat = { rank: number; userId: number; at: number; eventKey: string };
type StoredEvent = {
  id: number;
  userId: number;
  key: string;
  at: number;
  amount: number;
  usdUnits: number | null;
};
type Entry = {
  input: HistoryEvent;
  microExp: bigint;
  amount: number;
  stored?: StoredEvent;
  id?: number;
};
const scale = BigInt(MONEY_SCALE);

function integer(value: number, min: number, label: string) {
  if (!Number.isSafeInteger(value) || value < min)
    throw new Error(`无效的 ${label}: ${value}`);
  return value;
}

// Convert at the database's exact integer precision. A zero-EXP charge still carries value.
function microExp(event: HistoryEvent) {
  integer(event.userId, 1, "userId");
  integer(event.at, 0, "at");
  if (typeof event.key !== "string" || !event.key.trim())
    throw new Error("缺少经验事件标识");
  if (
    event.fixedExp !== undefined &&
    event.usdUnits === undefined &&
    event.source === undefined
  ) {
    return BigInt(integer(event.fixedExp, 1, event.key)) * scale;
  }
  if (
    event.fixedExp === undefined &&
    event.usdUnits !== undefined &&
    (event.source === "income" || event.source === "api_usage") &&
    event.key.startsWith(event.source + ":")
  ) {
    return (
      BigInt(integer(event.usdUnits, 1, event.key)) *
      BigInt(EXP_PER_USD[event.source])
    );
  }
  throw new Error(`经验事件金额、来源或键冲突: ${event.key}`);
}

function keyOf(userId: number, key: string) {
  return `${userId}:${key}`;
}
function storedInput(row: StoredEvent): HistoryEvent {
  const base = { userId: row.userId, key: row.key, at: row.at };
  if (row.usdUnits === null) return { ...base, fixedExp: row.amount };
  const source = row.key.split(":", 1)[0];
  if (source !== "income" && source !== "api_usage")
    throw new Error(`无法确定已有金额事件来源: ${row.key}`);
  return { ...base, usdUnits: row.usdUnits, source };
}

function snapshot(
  totalExp = 0,
  expRemainder = 0,
  equippedLevel: number | null = null
): Snapshot {
  integer(expRemainder, 0, "exp_remainder");
  if (expRemainder >= MONEY_SCALE) throw new Error("经验零头超出范围");
  return {
    totalExp,
    expRemainder,
    level: getLevelProgress(totalExp).level,
    equippedLevel,
  };
}

/** Caller supplies a consistent SQLite transaction. Dry-run and apply build the same write plan. */
export function replayHistory(
  db: Database,
  events: HistoryEvent[],
  apply: boolean
) {
  if (apply && !db.inTransaction)
    throw new Error("写入历史经验需要调用方持有事务");
  const userIds = db
    .prepare("SELECT id FROM users ORDER BY id")
    .pluck()
    .all() as number[];
  const users = new Set(userIds);
  const profiles = new Map<number, Snapshot>();
  for (const row of db
    .prepare(
      "SELECT user_id, total_exp, exp_remainder, equipped_level FROM level_profiles"
    )
    .iterate() as Iterable<{
    user_id: number;
    total_exp: number;
    exp_remainder: number;
    equipped_level: number | null;
  }>) {
    if (!users.has(row.user_id))
      throw new Error(`等级档案用户不存在: ${row.user_id}`);
    profiles.set(
      row.user_id,
      snapshot(row.total_exp, row.exp_remainder, row.equipped_level)
    );
  }
  const entries = new Map<string, Entry>();
  const audit = new Map<number, { raw: bigint; credited: bigint }>();
  for (const row of db
    .prepare(
      "SELECT id, user_id AS userId, event_key AS key, created_at AS at, usd_units AS usdUnits, amount FROM experience_events"
    )
    .iterate() as Iterable<StoredEvent>) {
    integer(row.id, 1, "event_id");
    integer(row.amount, 0, "amount");
    if (!users.has(row.userId))
      throw new Error(`经验事件用户不存在: ${row.userId}`);
    const input = storedInput(row);
    const raw = microExp(input);
    const whole = BigInt(row.amount);
    if (whole < raw / scale || whole > (raw + scale - 1n) / scale)
      throw new Error(`已有事件经验金额冲突: ${row.key}`);
    const balance = audit.get(row.userId) ?? { raw: 0n, credited: 0n };
    balance.raw += raw;
    balance.credited += whole;
    audit.set(row.userId, balance);
    entries.set(keyOf(row.userId, row.key), {
      input,
      microExp: raw,
      amount: row.amount,
      stored: row,
      id: row.id,
    });
  }
  // An unexplained opening balance has no timestamp. Inventing one would change all first-arrival seats.
  for (const userId of userIds) {
    const profile = profiles.get(userId) ?? snapshot();
    const balance = audit.get(userId) ?? { raw: 0n, credited: 0n };
    if (
      balance.raw !==
        BigInt(profile.totalExp) * scale + BigInt(profile.expRemainder) ||
      balance.credited !== BigInt(profile.totalExp)
    ) {
      throw new Error(
        `用户 ${userId} 的等级余额与已有经验事件不符，无法还原原始时间`
      );
    }
  }

  const counts = {
    inputEvents: events.length,
    duplicateInputs: 0,
    matchedEvents: 0,
    insertedEvents: 0,
    updatedEvents: 0,
    profileWrites: 0,
    seatDeletes: 0,
    seatUpdates: 0,
    seatInserts: 0,
  };
  const seen = new Set<string>();
  for (const input of events) {
    const raw = microExp(input);
    if (!users.has(input.userId))
      throw new Error(`历史事件用户不存在: ${input.userId}`);
    const key = keyOf(input.userId, input.key);
    const previous = entries.get(key);
    if (
      previous &&
      (previous.input.fixedExp !== input.fixedExp ||
        previous.input.usdUnits !== input.usdUnits ||
        previous.input.source !== input.source)
    ) {
      throw new Error(`同一事件的输入冲突: ${key}`);
    }
    if (seen.has(key)) {
      if (previous!.input.at !== input.at)
        throw new Error(`同一历史事件的时间冲突: ${key}`);
      counts.duplicateInputs++;
      continue;
    }
    seen.add(key);
    if (previous) {
      counts.matchedEvents++;
      previous.input = input; // Business timestamp takes precedence over the wall clock used to credit EXP.
    } else {
      counts.insertedEvents++;
      entries.set(key, { input, microExp: raw, amount: 0 });
    }
  }

  const stages = LEVEL_STAGES.map(({ level }) => ({
    level,
    before: [] as Seat[],
    after: [] as Seat[],
  }));
  for (const seat of db
    .prepare(
      `SELECT b.level, b.rank, b.user_id AS userId, b.awarded_at AS at, e.event_key AS eventKey, e.user_id AS owner
    FROM level_badges b LEFT JOIN experience_events e ON e.id = b.event_id ORDER BY b.level, b.rank`
    )
    .iterate() as Iterable<Seat & { level: number; owner: number | null }>) {
    const stage = stages.find(s => s.level === seat.level);
    if (!stage || seat.owner !== seat.userId || seat.rank < 1 || seat.rank > 3)
      throw new Error(`无效的原等级席位: ${seat.level}/${seat.rank}`);
    stage.before.push({
      rank: seat.rank,
      userId: seat.userId,
      at: seat.at,
      eventKey: seat.eventKey,
    });
  }
  const ordered = [...entries.values()].sort(
    ({ input: a }, { input: b }) =>
      a.at - b.at ||
      a.userId - b.userId ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
  const totals = new Map<number, bigint>();
  for (const entry of ordered) {
    const { userId, at, key } = entry.input;
    const old = totals.get(userId) ?? 0n;
    const total = old + entry.microExp;
    const whole = integer(Number(total / scale), 0, "total_exp");
    entry.amount = Number(total / scale - old / scale);
    totals.set(userId, total);
    if (
      entry.stored &&
      (entry.stored.amount !== entry.amount || entry.stored.at !== at)
    )
      counts.updatedEvents++;
    for (const stage of stages) {
      const threshold = getLevelThreshold(stage.level);
      if (
        stage.after.length < 3 &&
        whole >= threshold &&
        old / scale < BigInt(threshold)
      ) {
        stage.after.push({
          rank: stage.after.length + 1,
          userId,
          at,
          eventKey: key,
        });
      }
    }
  }

  const userChanges = userIds.map(userId => {
    const before = profiles.get(userId) ?? snapshot();
    const total = totals.get(userId) ?? 0n;
    const retained = stages.some(
      stage =>
        stage.level === before.equippedLevel &&
        stage.after.some(seat => seat.userId === userId)
    );
    const after = snapshot(
      Number(total / scale),
      Number(total % scale),
      retained ? before.equippedLevel : null
    );
    return { userId, before, after };
  });
  const profileWrites = userChanges.filter(
    ({ before, after }) =>
      before.totalExp !== after.totalExp ||
      before.expRemainder !== after.expRemainder ||
      before.equippedLevel !== after.equippedLevel
  );
  counts.profileWrites = profileWrites.length;
  type SeatWrite = Seat & { level: number };
  const deletes: SeatWrite[] = [],
    updates: SeatWrite[] = [],
    inserts: SeatWrite[] = [];
  for (const { level, before, after } of stages) {
    for (const old of before) {
      if (!after.some(s => s.rank === old.rank && s.userId === old.userId))
        deletes.push({ ...old, level });
    }
    for (const seat of after) {
      const old = before.find(
        s => s.rank === seat.rank && s.userId === seat.userId
      );
      if (!old) inserts.push({ ...seat, level });
      else if (old.eventKey !== seat.eventKey || old.at !== seat.at)
        updates.push({ ...seat, level });
    }
  }
  counts.seatDeletes = deletes.length;
  counts.seatUpdates = updates.length;
  counts.seatInserts = inserts.length;
  if (apply) {
    const add = db.prepare(
      "INSERT INTO experience_events (user_id,event_key,created_at,amount,usd_units) VALUES (?,?,?,?,?)"
    );
    const edit = db.prepare(
      "UPDATE experience_events SET amount=?, created_at=? WHERE id=?"
    );
    for (const entry of ordered) {
      const { userId, key, at, usdUnits } = entry.input;
      if (!entry.stored)
        entry.id = integer(
          Number(
            add.run(userId, key, at, entry.amount, usdUnits ?? null)
              .lastInsertRowid
          ),
          1,
          "event_id"
        );
      else if (entry.amount !== entry.stored.amount || at !== entry.stored.at)
        edit.run(entry.amount, at, entry.id);
    }
    const save =
      db.prepare(`INSERT INTO level_profiles (user_id,total_exp,exp_remainder,equipped_level) VALUES (?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET total_exp=excluded.total_exp, exp_remainder=excluded.exp_remainder, equipped_level=excluded.equipped_level`);
    for (const { userId, after } of profileWrites)
      save.run(userId, after.totalExp, after.expRemainder, after.equippedLevel);
    const remove = db.prepare(
      "DELETE FROM level_badges WHERE level=? AND rank=?"
    );
    for (const seat of deletes) remove.run(seat.level, seat.rank);
    const updateSeat = db.prepare(
      "UPDATE level_badges SET awarded_at=?, event_id=? WHERE level=? AND rank=?"
    );
    const addSeat = db.prepare(
      "INSERT INTO level_badges (awarded_at,event_id,level,rank,user_id) VALUES (?,?,?,?,?)"
    );
    for (const seat of updates)
      updateSeat.run(
        seat.at,
        entries.get(keyOf(seat.userId, seat.eventKey))!.id,
        seat.level,
        seat.rank
      );
    for (const seat of inserts)
      addSeat.run(
        seat.at,
        entries.get(keyOf(seat.userId, seat.eventKey))!.id,
        seat.level,
        seat.rank,
        seat.userId
      );
  }
  return { counts, users: userChanges, stages };
}
