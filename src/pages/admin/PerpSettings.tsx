import { useRef, useState, type FormEvent } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../api/router";
import { trpc } from "@/providers/trpc";
import { Input } from "@/components/ui/input";

type Settings = inferRouterOutputs<AppRouter>["admin"]["perpSettings"]["get"];
type Instrument =
  inferRouterOutputs<AppRouter>["admin"]["perpSettings"]["lookup"];
type DraftSymbol = { symbol: string; openEnabled: boolean };
const maxSymbols = 30;
const panel = "admin-panel p-4 sm:p-6";
const hint = "mt-1 text-xs leading-5 text-muted-foreground";
function draftOf(saved: Settings) {
  return {
    symbols: saved.symbols.map(({ symbol, openEnabled }) => ({
      symbol,
      openEnabled,
    })),
    depositsEnabled: saved.depositsEnabled,
    tradingEnabled: saved.tradingEnabled,
    exchangeRate: String(saved.exchangeRate),
    redemptionFeePercent: (saved.redemptionFeeBps / 100).toFixed(2),
    userLimit: String(saved.userLimitUnits / 1000),
    platformLimit: String(saved.platformLimitUnits / 1000),
  };
}
function parseUnits(text: string) {
  if (!/^[0-9]+(?:[.][0-9]{1,3})?$/.test(text)) return 0;
  const [whole, fractional = ""] = text.split(".");
  const units = Number(whole + fractional.padEnd(3, "0"));
  return Number.isSafeInteger(units) && units > 0 ? units : 0;
}
function SymbolCatalog({
  rows,
  change,
}: {
  rows: DraftSymbol[];
  change: (next: DraftSymbol[]) => void;
}) {
  const utils = trpc.useUtils();
  const [text, setText] = useState("");
  const [spec, setSpec] = useState<Instrument | null>(null);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState("");
  const request = useRef(0);
  const normalized = text.trim().toUpperCase();
  const included = rows.some(s => s.symbol === normalized);
  function editText(value: string) {
    request.current++;
    setText(value);
    setSpec(null);
    setFeedback("");
    setLoading(false);
  }
  async function lookup() {
    const id = ++request.current;
    setText(normalized);
    setSpec(null);
    setFeedback("");
    if (normalized.length > 32 || !/^[A-Z0-9]+USDT$/.test(normalized)) {
      setLoading(false);
      setFeedback("请输入完整 USDT 合约代码，如 NVDAUSDT。");
      document.getElementById("catalog-symbol")?.focus();
      return;
    }
    setLoading(true);
    try {
      const result = await utils.client.admin.perpSettings.lookup.query({
        symbol: normalized,
      });
      if (id !== request.current) return;
      if (!result || result.symbol !== normalized)
        throw new Error("未查到匹配的可交易 USDT 永续合约。");
      setSpec(result);
      setFeedback("已核验 " + normalized + " 的 Bybit 合约规格。");
    } catch (cause) {
      if (id === request.current)
        setFeedback(
          cause instanceof Error ? cause.message : "规格暂不可用，请稍后重试。"
        );
    } finally {
      if (id === request.current) setLoading(false);
    }
  }
  return (
    <section className={panel}>
      <h2 className="font-bold">开放合约品种</h2>
      <label htmlFor="catalog-symbol" className="mt-4 block">
        按完整代码查找 Bybit 合约
      </label>
      <div className="mt-1 flex flex-wrap gap-2">
        <Input
          className="admin-input min-w-40 flex-1"
          id="catalog-symbol"
          placeholder="如 NVDAUSDT"
          value={text}
          maxLength={32}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="catalog-help"
          onChange={e => editText(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!loading) void lookup();
            }
          }}
        />
        <button
          type="button"
          className="admin-secondary px-4 py-2"
          disabled={loading}
          onClick={() => void lookup()}
        >
          {loading ? "正在查询…" : "查询规格"}
        </button>
      </div>
      <p id="catalog-help" className={hint}>
        代码不区分大小写。仅支持服务端核验通过的 Bybit USDT 本位永续合约。
      </p>
      <p role="status" className="mt-1 text-sm">
        {feedback}
      </p>
      {spec && spec.symbol === normalized && (
        <div className="mt-3 rounded-xl border border-border p-3">
          <h3 className="font-semibold">{spec.symbol} · USDT 永续</h3>
          <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
            {[
              ["数量步长", spec.qtyStepUnits / 1e8],
              ["最小数量", spec.minQtyUnits / 1e8],
              ["市价单最大数量", spec.maxQtyUnits / 1e8],
              ["最小名义价值（USDT）", spec.minNotionalUnits / 1000],
              ["报价步长（USDT）", spec.tickSizeUnits / 1000],
              ["资金费周期（分钟）", spec.fundingIntervalMs / 60000],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className={hint}>{label}</dt>
                <dd>
                  {value.toLocaleString("zh-CN", { maximumFractionDigits: 8 })}
                </dd>
              </div>
            ))}
          </dl>
          <button
            type="button"
            disabled={included || rows.length >= maxSymbols}
            className="admin-secondary mt-3 px-4 py-2"
            onClick={() => {
              if (!included && rows.length < maxSymbols) {
                change([...rows, { symbol: spec.symbol, openEnabled: true }]);
                setFeedback(spec.symbol + " 已加入草稿，请保存合约配置。");
              }
            }}
          >
            {included ? "已在名单中" : "加入名单草稿"}
          </button>
        </div>
      )}
      <p className="mt-4 font-semibold">
        品种名单（{rows.length} / {maxSymbols}）
      </p>
      <p className={hint}>
        仅平仓品种仍可查看行情并平仓。有持仓时不能移除。修改名单后请保存。
      </p>
      <ul className="mt-2 space-y-2">
        {rows.map(row => (
          <li
            key={row.symbol}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-2"
          >
            <span className="font-mono">{row.symbol}</span>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label={row.symbol + " 交易模式"}
                className="admin-input rounded border p-1"
                value={row.openEnabled ? "open" : "close"}
                onChange={e =>
                  change(
                    rows.map(s =>
                      s.symbol === row.symbol
                        ? { ...s, openEnabled: e.target.value === "open" }
                        : s
                    )
                  )
                }
              >
                <option value="open">可开仓</option>
                <option value="close">仅平仓</option>
              </select>
              <button
                type="button"
                aria-label={"移除 " + row.symbol}
                className="admin-secondary px-2 py-1"
                onClick={() => {
                  change(rows.filter(s => s.symbol !== row.symbol));
                  setFeedback(row.symbol + " 已从草稿移除，请保存合约配置。");
                }}
              >
                移除
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
function Form({
  saved,
  unavailable,
}: {
  saved: Settings;
  unavailable: boolean;
}) {
  const mutation = trpc.admin.perpSettings.update.useMutation();
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState(() => draftOf(saved));
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const sending = useRef(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(saved));
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!dirty || sending.current || unavailable) return;
    setError("");
    setMessage("");
    const userLimitUnits = parseUnits(draft.userLimit),
      platformLimitUnits = parseUnits(draft.platformLimit);
    if (!draft.symbols.length) {
      setError("请至少选择一个合约。");
      document.getElementById("catalog-symbol")?.focus();
      return;
    }
    if (
      !userLimitUnits ||
      !platformLimitUnits ||
      userLimitUnits > platformLimitUnits
    ) {
      setError("限额须为正数，最多三位小数，单用户限额不得超过平台总限额。");
      document
        .getElementById(platformLimitUnits ? "user-limit" : "platform-limit")
        ?.focus();
      return;
    }
    const exchangeRate = Number(draft.exchangeRate);
    if (
      !/^[0-9]+$/.test(draft.exchangeRate) ||
      !Number.isInteger(exchangeRate) ||
      exchangeRate < 1 ||
      exchangeRate > 1_000_000
    ) {
      setError("兑换比例须为 1 至 1,000,000 的整数。");
      document.getElementById("exchange-rate")?.focus();
      return;
    }
    // Convert decimal text to basis points without floating-point rounding.
    const [whole, fraction = ""] = draft.redemptionFeePercent.split(".");
    const redemptionFeeBps = Number(whole + fraction.padEnd(2, "0"));
    if (
      !/^[0-9]+(?:[.][0-9]{1,2})?$/.test(draft.redemptionFeePercent) ||
      redemptionFeeBps > 9999
    ) {
      setError("兑回手续费须为 0 至 99.99%，最多两位小数。");
      document.getElementById("redemption-fee")?.focus();
      return;
    }
    sending.current = true;
    try {
      const result = await mutation.mutateAsync({
        symbols: draft.symbols.map(s => s.symbol),
        closeOnlySymbols: draft.symbols
          .filter(s => !s.openEnabled)
          .map(s => s.symbol),
        depositsEnabled: draft.depositsEnabled,
        tradingEnabled: draft.tradingEnabled,
        exchangeRate,
        redemptionFeeBps,
        userLimitUnits,
        platformLimitUnits,
      });
      utils.admin.perpSettings.get.setData(undefined, result);
      setDraft(draftOf(result));
      setMessage("合约配置已保存。");
      void utils.perps.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败，请重试。");
    } finally {
      sending.current = false;
    }
  }
  return (
    <form
      onSubmit={submit}
      onChange={() => {
        setMessage("");
        setError("");
      }}
    >
      <fieldset
        className="min-w-0 space-y-5"
        disabled={mutation.isPending || unavailable}
      >
        <section className={panel}>
          <h2 className="font-bold">交易控制</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {(
              [
                [
                  "depositsEnabled",
                  "允许换入模拟金",
                  "暂停换入时，已有可用模拟金仍可兑回。",
                ],
                [
                  "tradingEnabled",
                  "允许开仓",
                  "暂停开仓时，用户仍可平仓，已有仓位继续接受风险检查。",
                ],
              ] as const
            ).map(([key, label, note]) => (
              <div key={key} className="rounded-xl border border-border p-3">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={key}
                    checked={draft[key]}
                    aria-describedby={key + "-help"}
                    onChange={e =>
                      setDraft({ ...draft, [key]: e.target.checked })
                    }
                  />
                  <label className="font-semibold" htmlFor={key}>
                    {label}
                  </label>
                </div>
                <p className={hint} id={key + "-help"}>
                  {note}
                </p>
              </div>
            ))}
          </div>
        </section>
        <SymbolCatalog
          rows={draft.symbols}
          change={symbols => {
            setDraft({ ...draft, symbols });
            setMessage("");
            setError("");
          }}
        />
        <section className={panel}>
          <h2 className="font-bold">模拟金兑换</h2>
          <p className={hint} id="exchange-policy-help">
            修改后，新比例同时适用于后续换入和兑回（包括此前已持有的模拟金），新手续费适用于后续兑回。历史已成交记录不变。
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="exchange-rate">1 单位站内余额可换模拟金</label>
              <Input
                id="exchange-rate"
                className="admin-input mt-1"
                type="number"
                required
                min="1"
                max="1000000"
                step="1"
                aria-describedby="exchange-policy-help exchange-rate-help"
                value={draft.exchangeRate}
                onChange={e =>
                  setDraft({ ...draft, exchangeRate: e.target.value })
                }
              />
              <p className={hint} id="exchange-rate-help">
                1 至 1,000,000 的整数。
              </p>
            </div>
            <div>
              <label htmlFor="redemption-fee">兑回手续费（%）</label>
              <Input
                id="redemption-fee"
                className="admin-input mt-1"
                type="number"
                required
                min="0"
                max="99.99"
                step="0.01"
                aria-describedby="exchange-policy-help redemption-fee-help"
                value={draft.redemptionFeePercent}
                onChange={e =>
                  setDraft({ ...draft, redemptionFeePercent: e.target.value })
                }
              />
              <p className={hint} id="redemption-fee-help">
                0 至 99.99%，最多两位小数；填 0 表示免收。
              </p>
            </div>
          </div>
        </section>
        <section className={panel}>
          <h2 className="font-bold">持仓名义价值上限</h2>
          <p className={hint}>
            按开仓价值合计，金额单位为模拟
            USDT。下调限额后，在持仓降至限额内前限制新开仓。
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {(
              [
                ["userLimit", "user-limit", "单用户合计"],
                ["platformLimit", "platform-limit", "全平台合计"],
              ] as const
            ).map(([key, id, label]) => (
              <div key={key}>
                <label htmlFor={id}>{label}（模拟 USDT）</label>
                <Input
                  id={id}
                  className="admin-input mt-1"
                  type="number"
                  step="0.001"
                  min="0.001"
                  required
                  value={draft[key]}
                  onChange={e => setDraft({ ...draft, [key]: e.target.value })}
                />
              </div>
            ))}
          </div>
        </section>
        <section className={panel}>
          <h2 className="font-bold">行情与模拟交易规则</h2>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            {[
              ["行情来源", "Bybit V5 公共行情 · 服务端直连"],
              ["图表", "15 分钟 K 线"],
              ["仓位模式", "逐仓 · USDT 本位永续"],
              ["杠杆", saved.allowedLeverage.map(n => n + "×").join(" / ")],
              ["模拟 Taker 手续费", (saved.takerFeeBps / 100).toFixed(2) + "%"],
              [
                "维持保证金率",
                (saved.maintenanceMarginBps / 100).toFixed(2) + "%",
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 text-sm font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <div className="flex gap-3">
          <button
            className="admin-primary px-5 py-2"
            disabled={!dirty}
            type="submit"
          >
            {mutation.isPending ? "保存中…" : "保存合约配置"}
          </button>
          <button
            className="admin-secondary px-4 py-2"
            type="button"
            disabled={!dirty}
            onClick={() => {
              setDraft(draftOf(saved));
              setMessage("");
              setError("");
            }}
          >
            撤销修改
          </button>
        </div>
      </fieldset>
      <p className="mt-2 text-sm" role="status">
        {message}
      </p>
      {error && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
export default function PerpSettings() {
  const query = trpc.admin.perpSettings.get.useQuery(undefined, {
    retry: false,
  });
  return (
    <section className="mx-auto max-w-4xl space-y-5">
      <h1 className="text-2xl font-bold">模拟永续合约配置</h1>
      {query.isLoading && <p role="status">加载配置中…</p>}
      {query.error && (
        <p role="alert">
          读取配置失败。
          <button
            className="admin-secondary ml-2 px-3 py-1"
            onClick={() => query.refetch()}
          >
            重试
          </button>
        </p>
      )}
      {query.data && <Form saved={query.data} unavailable={query.isError} />}
    </section>
  );
}
