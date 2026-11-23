import type Database from "better-sqlite3";

export type SevenPickRuntime = {
  paused: boolean;
  rfc3161Enabled: boolean;
};

const settingKeys = {
  paused: "seven_pick_runtime_paused",
  rfc3161Enabled: "seven_pick_runtime_rfc3161_enabled",
} as const satisfies Record<keyof SevenPickRuntime, string>;

export function getSevenPickRuntime(db: Database.Database): SevenPickRuntime {
  const rows = db.prepare<[string, string], { key: string; value: string | null }>(
    "SELECT key,value FROM settings WHERE key IN (?,?)"
  ).all(settingKeys.paused, settingKeys.rfc3161Enabled);
  const values = new Map(rows.map(row => [row.key, row.value]));
  return {
    // Scheduling is allowed unless paused, but the separate, versioned daily
    // config still defaults to disabled and is required before any round opens.
    paused: values.has(settingKeys.paused) && values.get(settingKeys.paused) !== "0",
    rfc3161Enabled: values.get(settingKeys.rfc3161Enabled) === "1",
  };
}

export function setSevenPickRuntime(
  db: Database.Database,
  key: keyof SevenPickRuntime,
  value: boolean,
  adminSessionId: number,
): SevenPickRuntime {
  return db.transaction(() => {
    const before = getSevenPickRuntime(db);
    if (before[key] === value) return before;
    db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value=excluded.value")
      .run(settingKeys[key], value ? "1" : "0");
    db.prepare("INSERT INTO admin_logs (action,detail) VALUES (?,?)")
      .run("seven_pick_runtime_changed", JSON.stringify({ adminSessionId, key, before: before[key], after: value }));
    return { ...before, [key]: value };
  }).immediate();
}
