import type Database from "better-sqlite3";

export const LEVEL_SCHEMA = `CREATE TABLE IF NOT EXISTS level_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  total_exp INTEGER NOT NULL DEFAULT 0,
  exp_remainder INTEGER NOT NULL DEFAULT 0,
  equipped_level INTEGER
);
CREATE TABLE IF NOT EXISTS experience_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  event_key TEXT NOT NULL,
  usd_units INTEGER,
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS experience_events_user_key ON experience_events(user_id, event_key);
CREATE TABLE IF NOT EXISTS level_badges (
  level INTEGER NOT NULL,
  rank INTEGER NOT NULL CONSTRAINT level_badges_rank CHECK(rank BETWEEN 1 AND 3),
  user_id INTEGER NOT NULL REFERENCES users(id),
  event_id INTEGER NOT NULL REFERENCES experience_events(id),
  awarded_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS level_badges_seat ON level_badges(level, rank);
CREATE UNIQUE INDEX IF NOT EXISTS level_badges_owner ON level_badges(user_id, level);`;

export function migrateLevelColumns(sqlite: Database.Database) {
  const profileCols = sqlite
    .prepare("PRAGMA table_info(level_profiles)")
    .all() as { name: string }[];
  if (!profileCols.some(c => c.name === "exp_remainder"))
    sqlite.exec(
      "ALTER TABLE level_profiles ADD COLUMN exp_remainder INTEGER NOT NULL DEFAULT 0"
    );
  const eventCols = sqlite
    .prepare("PRAGMA table_info(experience_events)")
    .all() as { name: string }[];
  if (!eventCols.some(c => c.name === "usd_units"))
    sqlite.exec("ALTER TABLE experience_events ADD COLUMN usd_units INTEGER");
}
