import { useRef, useState, type FormEvent } from "react";
import { trpc } from "@/providers/trpc";
import {
  baseCoin,
  button,
  coin,
  decimalUnits,
  input,
  orderLabel,
  panel,
  sim,
  time,
  type PerpApi,
} from "./format";
import {
  estimateReferencePrice,
  maxOrderQuantity,
  percentageQuantity,
  estimateOrder,
  type EstimateInput,
} from "@contracts/perp-estimate";

type Action = "openLong" | "openShort" | "close";
type Leverage = 1 | 2 | 5;
type Mode = "market" | "limit" | "conditionalMarket" | "conditionalLimit";
const modes = {
  market: "市价单",
  limit: "限价单",
  conditionalMarket: "条件市价单",
  conditionalLimit: "条件限价单",
} as const;
type Trigger = {
  triggerPriceUnits: number;
  triggerDirection: "above" | "below";
};
type Terms =
  | { kind: "market" }
  | { kind: "limit"; limitPriceUnits: number }
  | ({ kind: "conditionalMarket" } & Trigger)
  | ({ kind: "conditionalLimit"; limitPriceUnits: number } & Trigger);
type Intent = {
  symbol: string;
  action: Action;
  quantityAtoms: number;
  leverage?: Leverage;
  requestKey: string;
  terms: Terms;
};
const signedSide = (action: Action, short: boolean) =>
  action === "openLong" || (action === "close" && short);

export function TradeForm({
  market,
  account,
}: {
  market: PerpApi["market"];
  account: PerpApi["account"];
}) {
  const pos = account.positions.find(p => p.symbol === market.symbol),
    spec = market.instrument,
    quote = market.quote;
  const [action, setAction] = useState<Action>(pos ? "close" : "openLong"),
    [mode, setMode] = useState<Mode>("market"),
    [lev, setLev] = useState<Leverage>(1);
  const [qty, setQty] = useState(""),
    [limit, setLimit] = useState(""),
    [trigger, setTrigger] = useState("");
  const [direction, setDirection] =
    useState<Trigger["triggerDirection"]>("above");
  const [selectedPct, setPct] = useState<number | null>(null),
    [intent, setIntent] = useState<Intent | null>(null),
    [message, setMessage] = useState("");
  const [calculated, setCalculated] = useState<null | {
    estimate: NonNullable<ReturnType<typeof estimateOrder>>;
    reference: number;
    asOf: number;
    context: string;
  }>(null);
  const sending = useRef(false),
    utils = trpc.useUtils(),
    direct = trpc.perps.placeOrder.useMutation(),
    pending = trpc.perps.createPending.useMutation();
  const busy = direct.isPending || pending.isPending;
  const unit = baseCoin(market.symbol),
    closing = action === "close",
    buying = signedSide(action, pos?.side === "short");
  const conditional =
      mode === "conditionalLimit" || mode === "conditionalMarket",
    priced = mode === "conditionalLimit" || mode === "limit";
  const leverage = (pos?.leverage ?? lev) as Leverage,
    canOpen =
      market.tradingEnabled &&
      account.tradingEnabled &&
      account.config.symbols.some(
        s => s.symbol === market.symbol && s.openEnabled
      );
  const limitUnits = decimalUnits(limit, 3),
    triggerUnits = decimalUnits(trigger, 3),
    atoms = decimalUnits(qty, 8);
  const px =
    estimateReferencePrice({
      orderType: mode,
      action,
      positionSide: pos?.side,
      bidUnits: quote?.bidUnits,
      askUnits: quote?.askUnits,
      limitPriceUnits: limitUnits,
      triggerPriceUnits: triggerUnits,
    }) ?? 0;
  const used = account.positions.reduce((n, p) => n + p.entryNotionalUnits, 0);
  const sizing: EstimateInput = {
    action,
    priceUnits: px,
    leverage,
    position: pos,
    availableCashUnits: account.availableCashUnits,
    qtyStepAtoms: spec?.qtyStepUnits ?? 0,
    minQtyAtoms: spec?.minQtyUnits ?? 0,
    maxQtyAtoms: spec?.maxQtyUnits ?? 0,
    minNotionalUnits: spec?.minNotionalUnits ?? 0,
    takerFeeBps: account.config.takerFeeBps,
    maintenanceMarginBps: account.config.maintenanceMarginBps,
    notionalHeadroomUnits: Math.max(0, account.config.userLimitUnits - used),
  };
  const max = spec && px > 0 ? maxOrderQuantity(sizing) : 0;
  const baseProblem =
    !quote || !spec
      ? market.readOnlyReason || "等待可用盘口和合约规格"
      : !closing && !canOpen
        ? "当前暂停开仓，已有仓位可平仓"
        : closing && !pos
          ? "当前没有可平仓位"
          : !closing && pos && (action === "openLong") !== (pos.side === "long")
            ? "请先平掉反向仓位"
            : !closing && leverage > spec.maxLeverage
              ? "杠杆超过合约允许范围"
              : priced && (!limitUnits || limitUnits % spec.tickSizeUnits !== 0)
                ? "请输入符合报价步长的限价"
                : conditional &&
                    (!triggerUnits || triggerUnits % spec.tickSizeUnits !== 0)
                  ? "请输入符合报价步长的触发价"
                  : conditional &&
                      (direction === "above"
                        ? triggerUnits <= quote.markUnits
                        : triggerUnits >= quote.markUnits)
                    ? "向上触发价须高于标记价，向下触发价须低于标记价"
                    : "";
  const problem =
    baseProblem ||
    (!atoms
      ? "请输入数量或选择比例"
      : spec && atoms % spec.qtyStepUnits !== 0
        ? "数量不符合合约步长"
        : atoms > max
          ? "超出可用余额、持仓或下单上限"
          : !closing &&
              spec &&
              (atoms < spec.minQtyUnits ||
                (BigInt(atoms) * BigInt(px)) / 100000000n <
                  BigInt(spec.minNotionalUnits))
            ? "数量或名义价值低于合约下限"
            : "");
  const percentage =
    selectedPct ??
    (max > 0 ? Math.min(100, Math.round((atoms / max) * 100)) : 0);
  const context = JSON.stringify([
    market.symbol,
    action,
    mode,
    atoms,
    leverage,
    limitUnits,
    triggerUnits,
    direction,
    pos?.quantityAtoms,
    pos?.entryNotionalUnits,
    pos?.marginUnits,
    account.availableCashUnits,
    account.config.takerFeeBps,
    account.config.maintenanceMarginBps,
  ]);
  const result = calculated?.context === context ? calculated : null;
  function edit() {
    setCalculated(null);
    setIntent(null);
    setMessage("");
    setPct(null);
  }
  function size(pct: number) {
    edit();
    setPct(pct);
    const n = percentageQuantity(sizing, pct);
    setQty(n ? (n / 1e8).toFixed(8) : "");
  }
  function calculate() {
    if (problem || !quote) return;
    const estimate = estimateOrder(sizing, atoms);
    if (estimate) {
      setCalculated({ estimate, reference: px, asOf: quote.asOf, context });
      setMessage("");
    } else {
      setCalculated(null);
      setMessage("当前参数无法估算，请检查数量和参考价格。");
    }
  }
  function terms(): Terms {
    if (mode === "market") return { kind: mode };
    if (mode === "limit") return { kind: mode, limitPriceUnits: limitUnits };
    const t = { triggerPriceUnits: triggerUnits, triggerDirection: direction };
    return mode === "conditionalLimit"
      ? { kind: mode, limitPriceUnits: limitUnits, ...t }
      : { kind: mode, ...t };
  }
  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (problem || sending.current) return;
    if (!intent) {
      setMessage("");
      setIntent({
        symbol: market.symbol,
        action,
        quantityAtoms: atoms,
        ...(closing ? {} : { leverage }),
        terms: terms(),
        requestKey: Array.from(crypto.getRandomValues(new Uint8Array(16)), n =>
          n.toString(16).padStart(2, "0")
        ).join(""),
      });
      return;
    }
    sending.current = true;
    try {
      const { terms: t, ...base } = intent;
      if (t.kind === "market") {
        const r = await direct.mutateAsync(base);
        setMessage(
          orderLabel[r.action] +
            "成交 " +
            coin(r.quantityAtoms) +
            " " +
            unit +
            " · 成交价 " +
            sim(r.priceUnits) +
            " USDT · 手续费 " +
            sim(r.feeUnits) +
            " 模拟金。"
        );
      } else {
        const r = await pending.mutateAsync({ ...base, ...t });
        setMessage("委托 #" + r.id + " 已受理，请在「我的委托」查看最新状态。");
      }
      setIntent(null);
      setCalculated(null);
      setQty("");
      setPct(null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "提交失败，请重试。");
    } finally {
      sending.current = false;
      void utils.perps.account.invalidate();
      void utils.perps.pendingOrders.invalidate();
      void utils.perps.market.invalidate({ symbol: market.symbol });
    }
  }
  return (
    <form onSubmit={confirm} className={panel}>
      <h2 className="text-xl font-bold">逐仓委托</h2>
      <fieldset disabled={!!intent || busy} className="mt-4 space-y-3">
        <label className="block">
          委托类型
          <select
            className={input}
            value={mode}
            onChange={e => {
              edit();
              setMode(e.target.value as Mode);
            }}
          >
            {Object.entries(modes).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          方向
          <select
            className={input}
            value={action}
            onChange={e => {
              edit();
              setAction(e.target.value as Action);
            }}
          >
            <option value="openLong" disabled={!canOpen}>
              做多
            </option>
            <option value="openShort" disabled={!canOpen}>
              做空
            </option>
            <option value="close">平仓</option>
          </select>
        </label>
        {!closing && (
          <label className="block">
            杠杆
            <select
              className={input}
              value={leverage}
              disabled={!!pos}
              onChange={e => {
                edit();
                setLev(Number(e.target.value) as Leverage);
              }}
            >
              {account.config.allowedLeverage.map(v => (
                <option
                  key={v}
                  value={v}
                  disabled={!!spec && v > spec.maxLeverage}
                >
                  {v}×
                </option>
              ))}
            </select>
          </label>
        )}
        {conditional && (
          <>
            <p className="text-xs text-muted-foreground">
              当前标记价：{quote ? sim(quote.markUnits) + " USDT" : "待报价"}
            </p>
            <label className="block">
              标记价触发方向
              <select
                className={input}
                value={direction}
                onChange={e => {
                  edit();
                  setDirection(e.target.value as Trigger["triggerDirection"]);
                }}
              >
                <option value="above">上涨至或高于</option>
                <option value="below">下跌至或低于</option>
              </select>
            </label>
            <label className="block">
              触发价（USDT）
              <input
                className={input}
                type="text"
                inputMode="decimal"
                required
                value={trigger}
                onChange={e => {
                  edit();
                  setTrigger(e.target.value);
                }}
              />
            </label>
          </>
        )}
        {priced && (
          <label className="block">
            限价（USDT）
            <input
              className={input}
              type="text"
              inputMode="decimal"
              required
              value={limit}
              onChange={e => {
                edit();
                setLimit(e.target.value);
              }}
            />
          </label>
        )}
        <label className="block">
          委托数量（{unit}）
          <input
            required
            className={input}
            value={qty}
            type="text"
            inputMode="decimal"
            onChange={e => {
              edit();
              setQty(e.target.value);
            }}
          />
        </label>
        <label className="block text-sm">
          {closing ? "可平数量" : "可开数量"}比例 <b>{percentage}%</b>
          <input
            className="mt-2 block h-6 w-full cursor-pointer accent-amber-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
            type="range"
            min="0"
            max="100"
            step="1"
            value={percentage}
            disabled={!max || !!baseProblem}
            aria-valuetext={percentage + "%"}
            onChange={e => size(Number(e.target.value))}
          />
        </label>
        <div className="flex justify-between gap-1">
          {[0, 25, 50, 75, 100].map(n => (
            <button
              key={n}
              type="button"
              className="rounded border border-border px-1 py-1 text-xs disabled:opacity-50"
              disabled={!max || !!baseProblem}
              onClick={() => size(n)}
            >
              {n}%
            </button>
          ))}
        </div>
        {spec && (
          <p className="text-xs text-muted-foreground">
            数量步长 {coin(spec.qtyStepUnits)} {unit} · 报价步长{" "}
            {sim(spec.tickSizeUnits)} USDT
          </p>
        )}
      </fieldset>
      <section
        aria-label="委托预估"
        className="my-4 rounded-lg border border-border p-3"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">委托预估</h3>
          <button
            type="button"
            onClick={calculate}
            className={button}
            disabled={!!problem || busy || !!intent}
          >
            {result ? "重新计算" : "计算"}
          </button>
        </div>
        <dl className="mt-2 space-y-1 text-sm tabular-nums" aria-live="polite">
          <div className="flex justify-between gap-2">
            <dt>数量</dt>
            <dd>
              {result
                ? coin(result.estimate.quantityAtoms) + " " + unit
                : "计算"}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>
              {closing ? "成本（平仓手续费）" : "成本（保证金 + 手续费）"}
            </dt>
            <dd>
              {result ? sim(result.estimate.costUnits) + " 模拟金" : "计算"}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>预估强平价</dt>
            <dd>
              {result
                ? result.estimate.liquidationPriceUnits === null
                  ? "不适用"
                  : sim(result.estimate.liquidationPriceUnits) + " USDT"
                : "计算"}
            </dd>
          </div>
        </dl>
        {result && (
          <p className="mt-2 text-xs text-muted-foreground">
            {time(result.asOf)} 的参考估算：按
            {priced
              ? "限价"
              : conditional
                ? "触发价"
                : buying
                  ? "卖一价"
                  : "买一价"}{" "}
            {sim(result.reference)} USDT 计算，不锁定成交价。
          </p>
        )}
      </section>
      <p className="text-xs text-muted-foreground">
        {mode === "market"
          ? "按受理后的新鲜盘口模拟成交。"
          : mode === "limit"
            ? "买入不高于限价、卖出不低于限价时按盘口模拟成交。"
            : "以标记价格触发，触发后按" +
              (priced ? "限价等待成交。" : "当时的盘口模拟市价成交。")}
        {mode !== "market" && " 挂单不预冻结资金或仓位，成交时重新校验。"}
      </p>
      {problem && (
        <p className="mt-2 text-sm text-muted-foreground">{problem}</p>
      )}
      {intent && (
        <p className="mt-3 rounded border border-border p-2 text-sm text-[#ffd473]">
          确认{modes[intent.terms.kind]} · {orderLabel[intent.action]}{" "}
          {coin(intent.quantityAtoms)} {unit}
          {intent.leverage ? " · " + intent.leverage + "×" : ""}
          {"triggerPriceUnits" in intent.terms
            ? " · 标记价" +
              (intent.terms.triggerDirection === "above" ? " ≥ " : " ≤ ") +
              sim(intent.terms.triggerPriceUnits)
            : ""}
          {"limitPriceUnits" in intent.terms
            ? " · 限价 " + sim(intent.terms.limitPriceUnits)
            : ""}
          ？
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button className={button} disabled={!!problem || busy}>
          {busy ? "提交中…" : intent ? "确认提交" : "核对委托"}
        </button>
        {intent && (
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => {
              setIntent(null);
              setMessage("");
            }}
          >
            返回修改
          </button>
        )}
      </div>
      <p role="status" className="mt-2 text-sm">
        {message}
      </p>
    </form>
  );
}
