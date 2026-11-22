import type Database from "better-sqlite3";
import { z } from "zod";

const configKey = "bybit_perp_config_v1";
export const PERP_SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const;
export const PERP_LEVERAGES = [1, 2, 5] as const;
export const perpSymbolSchema = z
  .string()
  .max(32)
  .refine(
    value =>
      value.length > 4 && value.endsWith("USDT") && !/[^A-Z0-9]/.test(value),
    "合约代码只能包含大写字母和数字，且必须以 USDT 结尾"
  );
export type PerpSymbol = z.infer<typeof perpSymbolSchema>;
const symbolList = z.array(perpSymbolSchema).max(30, "最多配置 30 个合约");
export const TAKER_FEE_BPS = 6;
export const MAINTENANCE_MARGIN_BPS = 50;
export const DEFAULT_EXCHANGE_RATE = 1000;
export const DEFAULT_REDEMPTION_FEE_BPS = 500;
const positiveUnits = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const perpSettingsInput = z
  .strictObject({
    symbols: symbolList
      .min(1)
      .refine(list => new Set(list).size === list.length, "合约代码不能重复"),
    closeOnlySymbols: symbolList
      .refine(list => new Set(list).size === list.length, "仅平仓代码不能重复")
      .optional(),
    depositsEnabled: z.boolean(),
    tradingEnabled: z.boolean(),
    exchangeRate: z.number().int().min(1).max(1_000_000).optional(),
    redemptionFeeBps: z.number().int().min(0).max(9999).optional(),
    userLimitUnits: positiveUnits,
    platformLimitUnits: positiveUnits,
  })
  .refine(
    value =>
      value.closeOnlySymbols?.every(symbol => value.symbols.includes(symbol)) ??
      true,
    {
      path: ["closeOnlySymbols"],
      message: "仅平仓合约必须在已选品种中",
    }
  )
  .refine(value => value.userLimitUnits <= value.platformLimitUnits, {
    path: ["userLimitUnits"],
    message: "单用户限额不能超过平台总限额",
  });
export type PerpSettingsInput = z.infer<typeof perpSettingsInput>;
function view(input: PerpSettingsInput) {
  return {
    ...input,
    exchangeRate: input.exchangeRate ?? DEFAULT_EXCHANGE_RATE,
    redemptionFeeBps: input.redemptionFeeBps ?? DEFAULT_REDEMPTION_FEE_BPS,
    closeOnlySymbols: input.closeOnlySymbols ?? [],
    symbols: input.symbols.map(symbol => ({
      symbol,
      name: symbol.slice(0, -4) + "/USDT 永续",
      openEnabled: !input.closeOnlySymbols?.includes(symbol),
    })),
    allowedLeverage: [...PERP_LEVERAGES],
    takerFeeBps: TAKER_FEE_BPS,
    maintenanceMarginBps: MAINTENANCE_MARGIN_BPS,
  };
}
export type PerpConfig = ReturnType<typeof view>;
export class PerpConfigError extends Error {}
export function readPerpConfig(db?: Database.Database): PerpConfig {
  const saved = db
    ?.prepare<[string], { value: string }>(
      "SELECT value FROM settings WHERE key=?"
    )
    .get(configKey);
  if (!saved)
    return view({
      symbols: [...PERP_SYMBOLS],
      depositsEnabled: process.env.PERP_DEPOSITS_ENABLED !== "0",
      tradingEnabled: process.env.PERP_TRADING_ENABLED !== "0",
      userLimitUnits: 100_000_000,
      platformLimitUnits: 1_000_000_000,
    });
  try {
    return view(perpSettingsInput.parse(JSON.parse(saved.value)));
  } catch {
    throw new Error("永续合约运营配置损坏，请检查数据库备份");
  }
}
function closeOnly(edit: PerpSettingsInput, previous: PerpConfig) {
  return (
    edit.closeOnlySymbols ??
    previous.closeOnlySymbols.filter(symbol => edit.symbols.includes(symbol))
  );
}
function needsVerification(edit: PerpSettingsInput, previous: PerpConfig) {
  const restricted = new Set(closeOnly(edit, previous));
  const prior = new Map(previous.symbols.map(s => [s.symbol, s.openEnabled]));
  return edit.symbols.filter(
    symbol =>
      !prior.has(symbol) || (!restricted.has(symbol) && !prior.get(symbol))
  );
}

// Ordinary settings changes remain available even when Bybit is unreachable.
export function savePerpConfig(
  db: Database.Database,
  input: PerpSettingsInput
): PerpConfig {
  return commitConfig(db, perpSettingsInput.parse(input), new Set());
}

export async function requireVerifiedPerpInstrument(
  db: Database.Database,
  symbol: string
) {
  const { lookupPerpInstrument, PerpInstrumentLookupError } =
    await import("./market");
  try {
    const spec = await lookupPerpInstrument(db, symbol);
    if (spec.symbol !== symbol)
      throw new PerpConfigError("合约代码与 Bybit 返回不一致");
    return spec;
  } catch (error) {
    if (error instanceof PerpInstrumentLookupError)
      throw new PerpConfigError(symbol + "：" + error.message);
    throw error;
  }
}
export async function verifyAndSavePerpConfig(
  db: Database.Database,
  input: PerpSettingsInput
) {
  const edit = perpSettingsInput.parse(input);
  const previous = readPerpConfig(db);
  const needed = needsVerification(edit, previous);
  const verified = new Set<string>();
  if (needed.length) {
    for (const symbol of needed) {
      await requireVerifiedPerpInstrument(db, symbol);
      verified.add(symbol);
    }
  }
  return commitConfig(db, edit, verified);
}

function commitConfig(
  db: Database.Database,
  edit: PerpSettingsInput,
  verified: ReadonlySet<string>
): PerpConfig {
  return db
    .transaction(() => {
      // Older admin clients omit these fields; preserve the live financial terms.
      const previous = readPerpConfig(db);
      // Re-check against the live catalog under the SQLite write lock. A concurrent
      // change may have removed or set a previously-open symbol to close-only.
      if (
        needsVerification(edit, previous).some(symbol => !verified.has(symbol))
      )
        throw new PerpConfigError("新增或重新开放的合约尚未核验，请刷新后重试");
      const values = {
        ...edit,
        closeOnlySymbols: closeOnly(edit, previous),
        exchangeRate: edit.exchangeRate ?? previous.exchangeRate,
        redemptionFeeBps: edit.redemptionFeeBps ?? previous.redemptionFeeBps,
      };
      const positions = db
        .prepare<[], { symbol: PerpSymbol }>(
          "SELECT DISTINCT symbol FROM perp_positions WHERE quantity_atoms > 0"
        )
        .all();
      const occupied = positions.find(
        row => !values.symbols.includes(row.symbol)
      );
      if (occupied)
        throw new PerpConfigError(
          occupied.symbol + " 仍有持仓，暂时不能移出可选合约。"
        );
      const pending = db
        .prepare<[], { symbol: PerpSymbol }>(
          "SELECT DISTINCT symbol FROM perp_pending_orders WHERE status IN ('pending','triggered')"
        )
        .all();
      const outstanding = pending.find(
        order => !values.symbols.includes(order.symbol)
      );
      if (outstanding)
        throw new PerpConfigError(
          outstanding.symbol + " 仍有待成交委托，请先撤单或等候成交后再移除。"
        );
      db.prepare(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).run(configKey, JSON.stringify(values));
      db.prepare(
        "INSERT INTO admin_logs(action,detail,created_at) VALUES(?,?,?)"
      ).run("更新模拟永续合约配置", JSON.stringify(values), Date.now());
      return view(values);
    })
    .immediate();
}
