import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  perpSettingsInput,
  readPerpConfig,
  savePerpConfig,
  verifyAndSavePerpConfig,
} from "./config";
import type { PerpInstrument } from "./market";
const marketLook = vi.hoisted(() =>
  vi.fn<(db: Database.Database, symbol: string) => Promise<PerpInstrument>>()
);
vi.mock("./market", () => ({
  lookupPerpInstrument: marketLook,
  PerpInstrumentLookupError: class extends Error {},
}));
const spec = (symbol: string): PerpInstrument => ({
  symbol,
  tickSizeUnits: 10,
  qtyStepUnits: 1000,
  minQtyUnits: 1000,
  maxQtyUnits: 1e8,
  minNotionalUnits: 5000,
  maxLeverage: 10,
  fundingIntervalMs: 28800000,
});

let db: Database.Database;
const edit = {
  symbols: ["ETHUSDT" as const],
  depositsEnabled: false,
  tradingEnabled: true,
  userLimitUnits: 12345,
  platformLimitUnits: 123456,
};
const ddl =
  "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE admin_logs(action TEXT,detail TEXT,created_at INTEGER); CREATE TABLE perp_positions(symbol TEXT,quantity_atoms INTEGER);";
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(ddl);
  marketLook
    .mockReset()
    .mockImplementation(async (_db, symbol) => spec(symbol));
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});
it("enables both Bybit public instruments without credentials and uses independent environment defaults", () => {
  vi.stubEnv("PERP_TRADING_ENABLED", "0");
  vi.stubEnv("PERP_DEPOSITS_ENABLED", "1");
  expect(readPerpConfig(db)).toMatchObject({
    depositsEnabled: true,
    tradingEnabled: false,
    symbols: [{ symbol: "BTCUSDT" }, { symbol: "ETHUSDT" }],
    exchangeRate: 1000,
    redemptionFeeBps: 500,
    allowedLeverage: [1, 2, 5],
    takerFeeBps: 6,
    maintenanceMarginBps: 50,
  });
  expect(savePerpConfig(db, edit)).toEqual(readPerpConfig(db));
  expect(readPerpConfig(db)).toMatchObject({
    symbols: [{ symbol: "ETHUSDT" }],
    tradingEnabled: true,
    depositsEnabled: false,
  });
});
it("upgrades missing financial terms and does not reset them on partial or old updates", () => {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(
    "bybit_perp_config_v1",
    JSON.stringify(edit)
  );
  expect(readPerpConfig(db)).toMatchObject({
    exchangeRate: 1000,
    redemptionFeeBps: 500,
  });
  for (const [exchangeRate, redemptionFeeBps] of [
    [1, 0],
    [1_000_000, 9999],
    [1234, 123],
  ]) {
    expect(
      savePerpConfig(db, { ...edit, exchangeRate, redemptionFeeBps })
    ).toMatchObject({ exchangeRate, redemptionFeeBps });
    expect(readPerpConfig(db)).toMatchObject({
      exchangeRate,
      redemptionFeeBps,
    });
    const detail = db
      .prepare("SELECT detail FROM admin_logs ORDER BY rowid DESC LIMIT 1")
      .pluck()
      .get() as string;
    expect(JSON.parse(detail)).toMatchObject({
      exchangeRate,
      redemptionFeeBps,
    });
  }
  expect(savePerpConfig(db, { ...edit, redemptionFeeBps: 0 })).toMatchObject({
    exchangeRate: 1234,
    redemptionFeeBps: 0,
  });
  expect(savePerpConfig(db, edit)).toMatchObject({
    exchangeRate: 1234,
    redemptionFeeBps: 0,
  });
});
it.each([
  { exchangeRate: 0 },
  { exchangeRate: 1_000_001 },
  { exchangeRate: 1.5 },
  { exchangeRate: "1000" },
  { redemptionFeeBps: -1 },
  { redemptionFeeBps: 10_000 },
  { redemptionFeeBps: 1.5 },
  { redemptionFeeBps: null },
  { symbols: [] },
  { symbols: ["BTCUSDT", "BTCUSDT"] },
  { symbols: ["BTCUSD"] },
  { symbols: ["USDT"] },
  { symbols: ["NVDAUSDT", "ethUSDT"] },
  { symbols: ["A".repeat(29) + "USDT"] },
  { symbols: ["NY:NVDAUSDT"] },
  { symbols: Array.from({ length: 31 }, (_, i) => i + "USDT") },
  { closeOnlySymbols: ["NVDAUSDT"] },
  { closeOnlySymbols: ["ETHUSDT", "ETHUSDT"] },
  { symbols: ["000001.SZ"] },
  { feedUrl: "https://bridge.example" },
  { feedToken: "token" },
  { chartSource: "sina" },
  { allowedLeverage: [100] },
  { takerFeeBps: 0 },
  { maintenanceMarginBps: 0 },
  { userLimitUnits: 3.1 },
  { platformLimitUnits: 0 },
  { userLimitUnits: 123457 },
  { platformLimitUnits: Number.MAX_SAFE_INTEGER + 1 },
])(
  "rejects unsupported instruments, insecure legacy fields and invalid limits: %o",
  bad => {
    expect(perpSettingsInput.safeParse({ ...edit, ...bad }).success).toBe(
      false
    );
  }
);
it("protects open positions and updates its audit trail atomically", () => {
  db.prepare("INSERT INTO perp_positions VALUES(?,?)").run("BTCUSDT", 1000);
  expect(() => savePerpConfig(db, edit)).toThrow("仍有持仓");
  expect(db.prepare("SELECT count(*) FROM settings").pluck().get()).toBe(0);
  db.exec(
    "DELETE FROM perp_positions; CREATE TRIGGER fail_audit BEFORE INSERT ON admin_logs BEGIN SELECT RAISE(ABORT,'fixture'); END;"
  );
  expect(() => savePerpConfig(db, edit)).toThrow("fixture");
  expect(db.prepare("SELECT count(*) FROM settings").pluck().get()).toBe(0);
});
it("verifies additions and reopenings, keeps existing modes on old updates and permits close-only while held", async () => {
  const added = { ...edit, symbols: ["BTCUSDT", "ETHUSDT", "NVDAUSDT"] };
  expect(() => savePerpConfig(db, added)).toThrow("尚未核验");
  expect((await verifyAndSavePerpConfig(db, added)).symbols.at(-1)).toEqual({
    symbol: "NVDAUSDT",
    name: "NVDA/USDT 永续",
    openEnabled: true,
  });
  expect(marketLook.mock.calls.map(([, s]) => s)).toEqual(["NVDAUSDT"]);
  db.prepare("INSERT INTO perp_positions VALUES('NVDAUSDT',123)").run();
  const restricted = { ...added, closeOnlySymbols: ["NVDAUSDT"] };
  expect(
    (await verifyAndSavePerpConfig(db, restricted)).symbols.at(-1)?.openEnabled
  ).toBe(false);
  expect(
    (await verifyAndSavePerpConfig(db, added)).symbols.at(-1)?.openEnabled
  ).toBe(false);
  expect(marketLook).toHaveBeenCalledTimes(1);
  await expect(verifyAndSavePerpConfig(db, edit)).rejects.toThrow("仍有持仓");
  marketLook.mockRejectedValueOnce(new Error("offline"));
  await expect(
    verifyAndSavePerpConfig(db, { ...added, closeOnlySymbols: [] })
  ).rejects.toThrow("offline");
  expect(readPerpConfig(db).symbols.at(-1)?.openEnabled).toBe(false);
  await verifyAndSavePerpConfig(db, { ...added, closeOnlySymbols: [] });
  expect(marketLook).toHaveBeenCalledTimes(3);
  expect(readPerpConfig(db).symbols.at(-1)?.openEnabled).toBe(true);
});
it("rechecks concurrently changed symbol modes under the commit lock", async () => {
  const initial = { ...edit, symbols: ["BTCUSDT", "ETHUSDT"] };
  const added = {
    ...initial,
    symbols: [...initial.symbols, "NVDAUSDT"],
    closeOnlySymbols: [],
  };
  marketLook.mockImplementationOnce(async (_db, symbol) => {
    savePerpConfig(db, { ...initial, closeOnlySymbols: ["ETHUSDT"] });
    return spec(symbol);
  });
  await expect(verifyAndSavePerpConfig(db, added)).rejects.toThrow("尚未核验");
  expect(
    readPerpConfig(db).symbols.map(s => [s.symbol, s.openEnabled])
  ).toEqual([
    ["BTCUSDT", true],
    ["ETHUSDT", false],
  ]);
  expect(db.prepare("SELECT count(*) FROM admin_logs").pluck().get()).toBe(1);
});
it("retains a change after reopening the SQLite file", () => {
  const dir = mkdtempSync(join(tmpdir(), "perp-config-"));
  const path = join(dir, "config.sqlite");
  try {
    const writer = new Database(path);
    try {
      writer.exec(ddl);
      savePerpConfig(writer, {
        ...edit,
        exchangeRate: 4321,
        redemptionFeeBps: 456,
      });
    } finally {
      writer.close();
    }
    const reader = new Database(path, { readonly: true });
    try {
      expect(readPerpConfig(reader)).toMatchObject({
        exchangeRate: 4321,
        redemptionFeeBps: 456,
        userLimitUnits: 12345,
        platformLimitUnits: 123456,
        depositsEnabled: false,
        symbols: [{ symbol: "ETHUSDT" }],
      });
    } finally {
      reader.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
