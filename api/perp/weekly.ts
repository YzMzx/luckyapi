import type Database from "better-sqlite3";

type Db = Database.Database;
const WEEK = 7 * 86_400_000;
const ORIGIN = Date.UTC(1970, 0, 4, 16); // Monday midnight in Asia/Shanghai
const GRACE = 5 * 60_000;
const SCALE = 100_000_000n;

export const PERP_WEEKLY_SCHEMA = `CREATE TABLE IF NOT EXISTS perp_week_cursor (
  id INTEGER PRIMARY KEY CHECK(id=1), next_week INTEGER NOT NULL, pending_reason TEXT
);
CREATE TABLE IF NOT EXISTS perp_weeks (
  week_start INTEGER PRIMARY KEY, week_end INTEGER NOT NULL, published_at INTEGER NOT NULL, rules_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS perp_week_results (
  week_start INTEGER NOT NULL REFERENCES perp_weeks(week_start), user_id INTEGER NOT NULL,
  display_name TEXT NOT NULL, opening_units INTEGER NOT NULL, closing_units INTEGER NOT NULL,
  cash_units INTEGER NOT NULL, in_units INTEGER NOT NULL, out_units INTEGER NOT NULL,
  pnl_units INTEGER NOT NULL, rank INTEGER, PRIMARY KEY(week_start,user_id)
);
CREATE INDEX IF NOT EXISTS perp_week_profits ON perp_week_results(week_start,pnl_units DESC,user_id) WHERE pnl_units>0;
CREATE INDEX IF NOT EXISTS perp_week_losses ON perp_week_results(week_start,pnl_units,user_id) WHERE pnl_units<0;
CREATE TABLE IF NOT EXISTS perp_week_positions (
  week_start INTEGER NOT NULL REFERENCES perp_weeks(week_start), user_id INTEGER NOT NULL, symbol TEXT NOT NULL,
  qty_atoms INTEGER NOT NULL, basis_units INTEGER NOT NULL, margin_units INTEGER NOT NULL,
  PRIMARY KEY(week_start,user_id,symbol)
);
CREATE TABLE IF NOT EXISTS perp_week_marks (
  boundary INTEGER NOT NULL, symbol TEXT NOT NULL, mark_units INTEGER NOT NULL CHECK(mark_units>0),
  PRIMARY KEY(boundary,symbol)
);`;

export function perpWeekStart(ms: number) {
  return ORIGIN + Math.floor((ms - ORIGIN) / WEEK) * WEEK;
}
function readCursor(db: Db) {
  return db
    .prepare<[], { next_week: number; pending_reason: string | null }>(
      "SELECT next_week,pending_reason FROM perp_week_cursor WHERE id=1"
    )
    .get();
}
function units(n: bigint) {
  const value = Number(n);
  if (!Number.isSafeInteger(value)) throw new Error("合约周榜金额溢出");
  return value;
}
type Position = { quantity: bigint; basis: bigint; margin: bigint };
type Account = {
  opening: bigint;
  cash: bigint;
  inFlow: bigint;
  outFlow: bigint;
  closing: bigint;
  pnl: bigint;
  rank: number | null;
  positions: Map<string, Position>;
};

function replay(db: Db, start: number) {
  const accounts = new Map<number, Account>();
  function account(id: number) {
    let a = accounts.get(id);
    if (!a) {
      a = {
        opening: 0n,
        cash: 0n,
        inFlow: 0n,
        outFlow: 0n,
        closing: 0n,
        pnl: 0n,
        rank: null,
        positions: new Map(),
      };
      accounts.set(id, a);
    }
    return a;
  }
  type Previous = {
    user_id: number;
    cash_units: number;
    closing_units: number;
  };
  for (const row of db
    .prepare<[number], Previous>(
      "SELECT user_id,cash_units,closing_units FROM perp_week_results WHERE week_start=? AND closing_units<>0"
    )
    .iterate(start - WEEK)) {
    const a = account(row.user_id);
    a.cash = BigInt(row.cash_units);
    a.opening = BigInt(row.closing_units);
  }
  type Held = {
    user_id: number;
    symbol: string;
    qty_atoms: number;
    basis_units: number;
    margin_units: number;
  };
  for (const r of db
    .prepare<[number], Held>(
      "SELECT * FROM perp_week_positions WHERE week_start=?"
    )
    .iterate(start - WEEK)) {
    account(r.user_id).positions.set(r.symbol, {
      quantity: BigInt(r.qty_atoms),
      basis: BigInt(r.basis_units),
      margin: BigInt(r.margin_units),
    });
  }
  type Event = {
    user_id: number;
    symbol: string | null;
    kind: string;
    qty_delta_atoms: number;
    entry_delta_units: number;
    margin_delta_units: number;
    cash_delta_units: number;
  };
  for (const r of db
    .prepare<[number, number], Event>(
      "SELECT user_id,symbol,kind,qty_delta_atoms,entry_delta_units,margin_delta_units,cash_delta_units FROM perp_events WHERE created_at>=? AND created_at<? ORDER BY created_at,id"
    )
    .iterate(start, start + WEEK)) {
    const a = account(r.user_id);
    const change = BigInt(r.cash_delta_units);
    a.cash += change;
    if (r.kind === "in") a.inFlow += change;
    if (r.kind === "out") a.outFlow -= change;
    if (!r.symbol) continue;
    const p = a.positions.get(r.symbol) ?? {
      quantity: 0n,
      margin: 0n,
      basis: 0n,
    };
    p.quantity += BigInt(r.qty_delta_atoms);
    p.margin += BigInt(r.margin_delta_units);
    p.basis += BigInt(r.entry_delta_units);
    a.positions.set(r.symbol, p);
  }
  return accounts;
}

// The market adapter verifies the candle ends precisely at this boundary.
export function storePerpBoundaryMark(
  db: Db,
  boundary: number,
  symbol: string,
  mark: number
) {
  if (
    perpWeekStart(boundary) !== boundary ||
    !Number.isSafeInteger(mark) ||
    mark <= 0
  )
    throw new Error("无效的合约周界标记价格");
  db.prepare("INSERT OR IGNORE INTO perp_week_marks VALUES(?,?,?)").run(
    boundary,
    symbol,
    mark
  );
}
function publish(db: Db, start: number, now: number) {
  const end = start + WEEK;
  const missingFunding = db
    .prepare(
      "SELECT 1 FROM perp_positions WHERE next_funding_at<? AND quantity_atoms>0 LIMIT 1"
    )
    .get(end);
  if (missingFunding)
    return { reason: "等待历史资金费结算", neededSymbols: [] as string[] };
  const accounts = replay(db, start);
  const prices = new Map(
    db
      .prepare<[number], { symbol: string; mark_units: number }>(
        "SELECT symbol,mark_units FROM perp_week_marks WHERE boundary=?"
      )
      .all(end)
      .map(r => [r.symbol, BigInt(r.mark_units)])
  );
  const neededSymbols = new Set<string>();
  for (const a of accounts.values()) {
    if (a.cash < 0n) throw new Error("合约现金快照异常");
    a.closing = a.cash;
    for (const [symbol, p] of a.positions) {
      if (p.quantity === 0n) {
        if (p.basis !== 0n || p.margin !== 0n)
          throw new Error("合约空仓快照异常");
        continue;
      }
      const mark = prices.get(symbol);
      if (!mark) {
        neededSymbols.add(symbol);
        continue;
      }
      const value = p.margin + (p.quantity * mark) / SCALE - p.basis;
      if (value > 0n) a.closing += value; // loss is limited to the isolated position
    }
    a.pnl = a.closing - a.opening - a.inFlow + a.outFlow;
  }
  if (neededSymbols.size)
    return { reason: "等待周界标记价格", neededSymbols: [...neededSymbols] };
  for (const side of [1, -1]) {
    const sorted = [...accounts.values()]
      .filter(a => (side === 1 ? a.pnl > 0n : a.pnl < 0n))
      .sort((a, b) => (a.pnl === b.pnl ? 0 : a.pnl > b.pnl ? -side : side));
    sorted.forEach((a, i) => {
      a.rank =
        i > 0 && sorted[i - 1].pnl === a.pnl ? sorted[i - 1].rank : i + 1;
    });
  }
  db.prepare("INSERT INTO perp_weeks VALUES(?,?,?,1)").run(start, end, now);
  const name = db.prepare<[number], { name: string }>(
    "SELECT COALESCE(NULLIF(group_name,''),NULLIF(display_name,''),username) AS name FROM users WHERE id=?"
  );
  const result = db.prepare(
    "INSERT INTO perp_week_results VALUES(?,?,?,?,?,?,?,?,?,?)"
  );
  const pos = db.prepare("INSERT INTO perp_week_positions VALUES(?,?,?,?,?,?)");
  for (const [id, a] of accounts) {
    result.run(
      start,
      id,
      name.get(id)?.name ?? "用户 " + id,
      units(a.opening),
      units(a.closing),
      units(a.cash),
      units(a.inFlow),
      units(a.outFlow),
      units(a.pnl),
      a.rank
    );
    for (const [symbol, p] of a.positions)
      if (p.quantity !== 0n)
        pos.run(
          start,
          id,
          symbol,
          units(p.quantity),
          units(p.basis),
          units(p.margin)
        );
  }
  return null;
}

export function settlePerpWeeks(db: Db, now = Date.now()) {
  const state = {
    published: 0,
    pendingWeek: null as number | null,
    reason: null as string | null,
    neededSymbols: [] as string[],
  };
  if (!Number.isSafeInteger(now)) throw new Error("无效结算时间");
  if (!readCursor(db)) {
    const first = db
      .prepare("SELECT min(created_at) FROM perp_events")
      .pluck()
      .get() as number | null;
    db.prepare(
      "INSERT OR IGNORE INTO perp_week_cursor(id,next_week) VALUES(1,?)"
    ).run(perpWeekStart(Math.min(first ?? now, now)));
  }
  const lastDue = perpWeekStart(now - GRACE) - WEEK;
  while (state.published < 4 && readCursor(db)!.next_week <= lastDue) {
    const published = db
      .transaction(() => {
        const start = readCursor(db)!.next_week;
        if (start > lastDue) return false;
        const wait = publish(db, start, now);
        if (wait) {
          state.pendingWeek = start;
          state.reason = wait.reason;
          state.neededSymbols = wait.neededSymbols;
          db.prepare(
            "UPDATE perp_week_cursor SET pending_reason=? WHERE id=1"
          ).run(wait.reason);
          return false;
        }
        db.prepare(
          "UPDATE perp_week_cursor SET next_week=?,pending_reason=NULL WHERE id=1"
        ).run(start + WEEK);
        return true;
      })
      .immediate();
    if (!published) break;
    state.published++;
  }
  return state;
}

type Week = { weekStart: number; weekEnd: number; publishedAt: number };
const weekColumns =
  "week_start AS weekStart,week_end AS weekEnd,published_at AS publishedAt";
function boundedInteger(n: number, min: number, max: number) {
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error("无效的周榜分页参数");
  return n;
}
export function listPerpWeeks(
  db: Db,
  { limit = 52, offset = 0 }: { limit?: number; offset?: number } = {}
) {
  const weeks = db
    .prepare<[number, number], Week>(
      "SELECT " +
        weekColumns +
        " FROM perp_weeks ORDER BY week_start DESC LIMIT ? OFFSET ?"
    )
    .all(
      boundedInteger(limit, 1, 100),
      boundedInteger(offset, 0, Number.MAX_SAFE_INTEGER)
    );
  const total = db
    .prepare("SELECT COUNT(*) FROM perp_weeks")
    .pluck()
    .get() as number;
  const cursor = readCursor(db);
  return {
    weeks,
    total,
    pendingWeek: cursor?.pending_reason ? cursor.next_week : null,
  };
}

type BoardEntry = {
  userId: number;
  displayName: string;
  pnlUnits: number;
  rank: number | null;
};
export function getPerpWeeklyBoard(
  db: Db,
  {
    weekStart,
    side,
    userId,
    page = 1,
    pageSize = 25,
  }: {
    weekStart: number;
    side: "profit" | "loss";
    userId: number;
    page?: number;
    pageSize?: number;
  }
) {
  boundedInteger(pageSize, 1, 100);
  boundedInteger(page, 1, Math.floor(Number.MAX_SAFE_INTEGER / pageSize));
  const week = db
    .prepare<[number], Week>(
      "SELECT " + weekColumns + " FROM perp_weeks WHERE week_start=?"
    )
    .get(weekStart);
  if (!week) return null;
  const select =
    "SELECT user_id AS userId, display_name AS displayName, pnl_units AS pnlUnits, rank FROM perp_week_results";
  const filter =
    side === "profit"
      ? " WHERE week_start=? AND pnl_units>0"
      : " WHERE week_start=? AND pnl_units<0";
  const order =
    side === "profit"
      ? " ORDER BY pnl_units DESC,user_id"
      : " ORDER BY pnl_units,user_id";
  const rows = db
    .prepare<[number, number, number], BoardEntry>(
      select + filter + order + " LIMIT ? OFFSET ?"
    )
    .all(weekStart, pageSize, (page - 1) * pageSize);
  const total = db
    .prepare("SELECT COUNT(*) FROM perp_week_results" + filter)
    .pluck()
    .get(weekStart) as number;
  const mine =
    db
      .prepare<[number, number], BoardEntry>(
        select + " WHERE week_start=? AND user_id=?"
      )
      .get(weekStart, userId) ?? null;
  return { week, rows, total, page, pageSize, mine };
}
