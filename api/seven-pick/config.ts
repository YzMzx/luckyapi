import type Database from "better-sqlite3";
import { z } from "zod";

export const SEVEN_PICK_NAME = "七星寻宝";
export const SEVEN_PICK_ITEMS = 32;
export const SEVEN_PICK_SIZE = 7;
export const SEVEN_PICK_MAX_BETS = 5;
export const SEVEN_PICK_MIN_STAKE_UNITS = 1_000;
export const SEVEN_PICK_MAX_STAKE_UNITS = 100_000;
export const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const BEIJING_OFFSET = 8 * 60 * MINUTE_MS;

function assertSevenPickTime(ms: number) {
  if (
    !Number.isSafeInteger(ms) ||
    ms < 0 ||
    ms > 8_640_000_000_000_000 - DAY_MS
  ) {
    throw new RangeError("无效时间");
  }
}

export function beijingDayStart(ms: number) {
  assertSevenPickTime(ms);
  return Math.floor((ms + BEIJING_OFFSET) / DAY_MS) * DAY_MS - BEIJING_OFFSET;
}

function isSafeImageReference(value: string) {
  if (value !== value.trim()) return false;
  // Only generated names in the game's local image route or HTTPS links.
  if (/^\/seven-pick-images\/[a-f0-9-]{32,36}\.(?:jpe?g|png|webp)$/.test(value))
    return true;
  if (!value.startsWith("https://") || value.includes("\\")) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

const itemIndex = z.number().int().min(1).max(SEVEN_PICK_ITEMS);
const stakeUnits = z
  .number()
  .int()
  .min(SEVEN_PICK_MIN_STAKE_UNITS)
  .max(SEVEN_PICK_MAX_STAKE_UNITS);
const multiplier = z.number().int().min(0).max(1_000_000);
export const sevenPickItemInput = z.strictObject({
  id: itemIndex,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1000),
  position: itemIndex,
  imageUrl: z
    .string()
    .max(2048)
    .refine(isSafeImageReference, "只能使用 HTTPS 外链或本地上传图片")
    .nullable(),
});

export const sevenPickConfigInput = z
  .strictObject({
    enabled: z.boolean(),
    openMinutes: z.array(z.number().int().min(0).max(1439)).min(1).max(24),
    closeAfterMinutes: z.number().int().min(1).max(120),
    drawAfterMinutes: z.number().int().min(2).max(240),
    minStakeUnits: stakeUnits,
    maxStakeUnits: stakeUnits,
    multipliers: z.array(multiplier).length(8),
    items: z.array(sevenPickItemInput).length(SEVEN_PICK_ITEMS),
  })
  .refine(c => c.drawAfterMinutes > c.closeAfterMinutes, {
    path: ["drawAfterMinutes"],
    message: "开奖时间须晚于封盘",
  })
  .refine(c => c.minStakeUnits <= c.maxStakeUnits, {
    path: ["maxStakeUnits"],
    message: "最高金额不能低于最低金额",
  })
  .refine(
    c =>
      c.multipliers.slice(0, 3).every(x => x === 0) &&
      c.multipliers.slice(3).every(x => x > 0),
    {
      path: ["multipliers"],
      message: "0–2 命中无返还，3–7 命中须配置正倍率",
    }
  )
  .refine(
    c =>
      new Set(c.items.map(x => x.id)).size === SEVEN_PICK_ITEMS &&
      new Set(c.items.map(x => x.position)).size === SEVEN_PICK_ITEMS,
    {
      path: ["items"],
      message: "物品 ID 和排序位置必须分别覆盖 1–32，且不能重复",
    }
  )
  .refine(
    c => {
      const slots = [...c.openMinutes].sort((a, b) => a - b);
      return slots.every(
        (start, i) =>
          start + c.drawAfterMinutes < 1440 &&
          (i === 0 || start >= slots[i - 1] + c.closeAfterMinutes)
      );
    },
    {
      path: ["openMinutes"],
      message: "封盘前不得重叠开盘，且开奖须在同一北京时间自然日内",
    }
  );

export type SevenPickConfigInput = z.infer<typeof sevenPickConfigInput>;
export type SevenPickItem = z.infer<typeof sevenPickItemInput>;
export type SevenPickConfig = SevenPickConfigInput & {
  id: number | null;
  effectiveAt: number;
  createdAt: number;
  canceledAt: number | null;
};

function defaultConfig(): SevenPickConfig {
  return {
    id: null,
    effectiveAt: 0,
    createdAt: 0,
    canceledAt: null,
    enabled: false,
    openMinutes: Array.from({ length: 9 }, (_, i) => (13 + i) * 60),
    closeAfterMinutes: 10,
    drawAfterMinutes: 20,
    minStakeUnits: SEVEN_PICK_MIN_STAKE_UNITS,
    maxStakeUnits: SEVEN_PICK_MAX_STAKE_UNITS,
    multipliers: [0, 0, 0, 3, 12, 100, 1_000, 50_000],
    items: Array.from({ length: SEVEN_PICK_ITEMS }, (_, i) => ({
      id: i + 1,
      position: i + 1,
      name: "宝物 " + (i + 1),
      description: "",
      imageUrl: null,
    })),
  };
}

type ConfigRow = {
  id: number;
  effectiveAt: number;
  createdAt: number;
  canceledAt: number | null;
  enabled: 0 | 1;
  openMinutesJson: string;
  closeAfterMinutes: number;
  drawAfterMinutes: number;
  minStakeUnits: number;
  maxStakeUnits: number;
  multipliersJson: string;
};

const SELECT_CONFIG =
  "SELECT v.id, v.effective_at AS effectiveAt, v.created_at AS createdAt, " +
  "c.canceled_at AS canceledAt, v.enabled, " +
  "v.open_minutes_json AS openMinutesJson, v.close_after_minutes AS closeAfterMinutes, " +
  "v.draw_after_minutes AS drawAfterMinutes, v.min_stake_units AS minStakeUnits, " +
  "v.max_stake_units AS maxStakeUnits, v.multipliers_json AS multipliersJson " +
  "FROM seven_pick_config_versions v LEFT JOIN seven_pick_config_cancellations c ON c.config_version_id=v.id";

function readVersion(db: Database.Database, row: ConfigRow): SevenPickConfig {
  const {
    id,
    effectiveAt,
    createdAt,
    canceledAt,
    enabled,
    openMinutesJson,
    multipliersJson,
    ...rest
  } = row;
  const items = db
    .prepare<[number], SevenPickItem>(
      "SELECT item_id AS id, name, description, position, image_url AS imageUrl " +
        "FROM seven_pick_items WHERE config_version_id=? ORDER BY position"
    )
    .all(id);
  return {
    id,
    effectiveAt,
    createdAt,
    canceledAt,
    ...sevenPickConfigInput.parse({
      ...rest,
      enabled: enabled === 1,
      openMinutes: JSON.parse(openMinutesJson),
      multipliers: JSON.parse(multipliersJson),
      items,
    }),
  };
}

export function getSevenPickConfig(
  db: Database.Database,
  atMs = Date.now()
): SevenPickConfig {
  const row = db
    .prepare<[number], ConfigRow>(
      SELECT_CONFIG +
        " WHERE v.effective_at<=? AND c.config_version_id IS NULL ORDER BY v.effective_at DESC,v.id DESC LIMIT 1"
    )
    .get(atMs);
  return row ? readVersion(db, row) : defaultConfig();
}

export function getLatestSevenPickConfig(
  db: Database.Database
): SevenPickConfig {
  const row = db
    .prepare<[], ConfigRow>(SELECT_CONFIG + " ORDER BY v.id DESC LIMIT 1")
    .get();
  return row ? readVersion(db, row) : defaultConfig();
}

export function getNextSevenPickConfig(
  db: Database.Database,
  nowMs = Date.now()
): SevenPickConfig | null {
  const row = db
    .prepare<[number], ConfigRow>(
      SELECT_CONFIG +
        " WHERE v.effective_at>? AND c.config_version_id IS NULL ORDER BY v.effective_at ASC,v.id DESC LIMIT 1"
    )
    .get(nowMs);
  return row ? readVersion(db, row) : null;
}

export function listSevenPickConfigVersions(
  db: Database.Database,
  limit = 20,
  beforeId?: number
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError("无效页大小");
  if (
    beforeId !== undefined &&
    (!Number.isSafeInteger(beforeId) || beforeId < 1)
  )
    throw new RangeError("无效版本游标");
  const rows =
    beforeId === undefined
      ? db
          .prepare<[number], ConfigRow>(SELECT_CONFIG + " ORDER BY v.id DESC LIMIT ?")
          .all(limit)
      : db
          .prepare<[number, number], ConfigRow>(
            SELECT_CONFIG + " WHERE v.id<? ORDER BY v.id DESC LIMIT ?"
          )
          .all(beforeId, limit);
  return rows.map(row => readVersion(db, row));
}

function insertSevenPickConfig(
  db: Database.Database,
  config: SevenPickConfigInput,
  effectiveAt: number,
  nowMs: number
): SevenPickConfig {
  const openMinutes = [...config.openMinutes].sort((a, b) => a - b);
  const items = [...config.items].sort((a, b) => a.position - b.position);
  const id = Number(
    db
      .prepare(
        "INSERT INTO seven_pick_config_versions " +
          "(effective_at,created_at,enabled,open_minutes_json,close_after_minutes,draw_after_minutes,min_stake_units,max_stake_units,multipliers_json) " +
          "VALUES (?,?,?,?,?,?,?,?,?)"
      )
      .run(
        effectiveAt,
        nowMs,
        Number(config.enabled),
        JSON.stringify(openMinutes),
        config.closeAfterMinutes,
        config.drawAfterMinutes,
        config.minStakeUnits,
        config.maxStakeUnits,
        JSON.stringify(config.multipliers)
      ).lastInsertRowid
  );
  const insertItem = db.prepare(
    "INSERT INTO seven_pick_items (config_version_id,item_id,name,description,position,image_url) VALUES (?,?,?,?,?,?)"
  );
  for (const item of items)
    insertItem.run(
      id,
      item.id,
      item.name,
      item.description,
      item.position,
      item.imageUrl
    );
  return {
    ...config,
    id,
    effectiveAt,
    createdAt: nowMs,
    canceledAt: null,
    openMinutes,
    items,
  };
}

export function saveSevenPickConfig(
  db: Database.Database,
  input: unknown,
  nowMs = Date.now()
): SevenPickConfig {
  const config = sevenPickConfigInput.parse(input);
  const effectiveAt = beijingDayStart(nowMs) + DAY_MS;
  return db
    .transaction(() => insertSevenPickConfig(db, config, effectiveAt, nowMs))
    .immediate();
}

export function activateSevenPickConfig(
  db: Database.Database,
  versionId: number,
  nowMs = Date.now()
): SevenPickConfig | null {
  if (!Number.isSafeInteger(versionId) || versionId < 1) return null;
  assertSevenPickTime(nowMs);
  return db
    .transaction(() => {
      const row = db
        .prepare<[number], ConfigRow>(SELECT_CONFIG + " WHERE v.id=?")
        .get(versionId);
      if (!row) return null;
      const active = insertSevenPickConfig(
        db,
        { ...readVersion(db, row), enabled: true },
        nowMs,
        nowMs
      );
      db.prepare(
        "INSERT INTO seven_pick_config_cancellations (config_version_id,canceled_at) " +
          "SELECT v.id,? FROM seven_pick_config_versions v WHERE v.effective_at>? AND NOT EXISTS " +
          "(SELECT 1 FROM seven_pick_config_cancellations c WHERE c.config_version_id=v.id)"
      ).run(nowMs, nowMs);
      return active;
    })
    .immediate();
}
