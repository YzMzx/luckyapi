import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getSevenPickRuntime, setSevenPickRuntime } from "./release";

it("stores independent controls, shares them across connections and audits changes atomically", () => {
  const directory = mkdtempSync(join(tmpdir(), "seven-pick-runtime-"));
  const filename = join(directory, "settings.sqlite");
  const primary = new Database(filename);
  const secondary = new Database(filename);
  try {
    primary.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); " +
      "CREATE TABLE admin_logs (id INTEGER PRIMARY KEY, action TEXT, detail TEXT);");
    expect(getSevenPickRuntime(primary)).toEqual({ paused: false, rfc3161Enabled: false });
    expect(setSevenPickRuntime(primary, "paused", true, 17)).toEqual({ paused: true, rfc3161Enabled: false });
    expect(setSevenPickRuntime(secondary, "rfc3161Enabled", true, 19)).toEqual({ paused: true, rfc3161Enabled: true });
    expect(getSevenPickRuntime(primary)).toEqual({ paused: true, rfc3161Enabled: true });
    expect(setSevenPickRuntime(primary, "paused", true, 17)).toEqual({ paused: true, rfc3161Enabled: true });
    const audits = primary.prepare<[], { action: string; detail: string }>("SELECT action,detail FROM admin_logs ORDER BY id").all();
    expect(audits.map(({ action, detail }) => [action, JSON.parse(detail)])).toEqual([
      ["seven_pick_runtime_changed", { adminSessionId: 17, key: "paused", before: false, after: true }],
      ["seven_pick_runtime_changed", { adminSessionId: 19, key: "rfc3161Enabled", before: false, after: true }],
    ]);
    primary.exec("CREATE TRIGGER reject_runtime_audit BEFORE INSERT ON admin_logs BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
    expect(() => setSevenPickRuntime(secondary, "paused", false, 17)).toThrow("audit unavailable");
    expect(getSevenPickRuntime(primary)).toEqual({ paused: true, rfc3161Enabled: true });
  } finally {
    secondary.close();
    primary.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
