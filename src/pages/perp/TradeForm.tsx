import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { PnlAmount } from "./PnlAmount";
import { trpc } from "@/providers/trpc";
import { getPerpLeverageRange } from "@contracts/perp-leverage";
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

const commonLeverages = [1, 2, 3, 5, 10, 20, 25, 50, 75, 100];
const rangeInput =
  "mt-2 block h-8 w-full cursor-pointer accent-amber-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 disabled:cursor-not-allowed";

type OpenAction = "openLong" | "openShort";
type Action = OpenAction | "close";
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
  leverage?: number;
  slippageBps?: number;
  requestKey: string;
  terms: Terms;
};

export function TradeForm({
  market,
  account,
  variant = "open",
  onSubmitted,
}: {
  market: PerpApi["market"];
  account: PerpApi["account"];
  variant?: "open" | "close";
  onSubmitted?: (message: string) => void;
}) {
  const pos = account.positions.find(p => p.symbol === market.symbol),
    spec = market.instrument,
    quote = market.quote;
  const [openAction, setOpenAction] = useState<OpenAction>(
      pos?.side === "short" ? "openShort" : "openLong"
    ),
    [mode, setMode] = useState<Mode>("market"),
    [leverageText, setLeverageText] = useState<string | null>(null),
    [leverageChecked, setLeverageChecked] = useState(false);
  const [slippage, setSlippage] = useState("0.5");
  const [calculating, setCalculating] = useState(false);
  const previewRequest = useRef(0);
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
    worst?: number;
    context: string;
  }>(null);
  const sending = useRef(false),
    utils = trpc.useUtils(),
    direct = trpc.perps.placeOrder.useMutation(),
    pending = trpc.perps.createPending.useMutation();
  const busy = direct.isPending || pending.isPending;
  const blockedReasonId = useId(),
    leverageId = useId(),
    leverageSliderId = useId(),
    leverageHelpId = useId(),
    slippageHelpId = useId();
  const unit = baseCoin(market.symbol),
    closing = variant === "close",
    action: Action = closing ? "close" : openAction;
  const conditional =
      mode === "conditionalLimit" || mode === "conditionalMarket",
    priced = mode === "conditionalLimit" || mode === "limit";
  const range = spec
    ? getPerpLeverageRange(account.config, spec.maxLeverage)
    : null;
  const rangeAvailable = !!range && range.max >= range.min;
  // Follow the configured minimum until the player explicitly enters a value.
  // Preserve that value across market/config refreshes rather than silently changing risk.
  const leverageValue = pos
    ? String(pos.leverage)
    : (leverageText ?? (rangeAvailable ? String(range.min) : ""));
  const leverage = Number(leverageValue);
  const leverageProblem =
    closing || !range
      ? ""
      : !rangeAvailable
        ? `Bybit 合约杠杆上限 ${range.max}× 低于站内最低杠杆 ${range.min}×，不支持开仓或加仓。`
        : !Number.isInteger(leverage) ||
            leverage < range.min ||
            leverage > range.max
          ? pos
            ? `当前持仓杠杆 ${leverage}× 不在允许范围 ${range.min}×–${range.max}× 内，只能平仓，不能加仓。`
            : `请输入 ${range.min} 至 ${range.max} 的整数杠杆。`
          : "";
  const canOpen =
    market.tradingEnabled &&
    account.tradingEnabled &&
    account.config.symbols.some(
      s => s.symbol === market.symbol && s.openEnabled
    );
  const leverageDisabled = !!pos || !rangeAvailable || !canOpen || !quote;
  const useSlippage = mode === "market" || mode === "conditionalMarket";
  const slippageBps = decimalUnits(slippage, 2);
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
      : leverageProblem
        ? leverageProblem
        : !closing && !canOpen
          ? "当前暂停开仓，已有仓位可平仓"
          : closing && !pos
            ? "当前没有可平仓位"
            : !closing &&
                pos &&
                (action === "openLong") !== (pos.side === "long")
              ? "请先平掉反向仓位"
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
    (useSlippage && (!slippageBps || slippageBps > 1000)
      ? "滑点上限须为 0.01%–10%"
      : "") ||
    (intent && !closing && intent.leverage !== leverage
      ? "杠杆已变化，请返回修改并重新核对委托。"
      : "") ||
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
  const showLeverageError =
    rangeAvailable && !pos && !!leverageProblem && leverageChecked;
  const visibleProblem =
    rangeAvailable && !pos && problem === leverageProblem && !showLeverageError
      ? ""
      : problem;
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
    slippageBps,
    direction,
    pos?.quantityAtoms,
    pos?.entryNotionalUnits,
    pos?.marginUnits,
    account.availableCashUnits,
    account.config.takerFeeBps,
    account.config.maintenanceMarginBps,
  ]);
  const result =
    !leverageProblem && calculated?.context === context ? calculated : null;
  const closeEstimate = result?.estimate.close;
  const estimateTitle = closing ? "平仓预估" : "委托预估";
  const estimateRows: [string, ReactNode][] = closing
    ? [
        [
          "平仓数量",
          result ? coin(result.estimate.quantityAtoms) + " " + unit : null,
        ],
        ["参考平仓价", result ? sim(result.reference) + " USDT" : null],
        [
          "释放保证金",
          closeEstimate
            ? sim(closeEstimate.releasedMarginUnits) + " 模拟金"
            : null,
        ],
        [
          "平仓手续费",
          result ? sim(result.estimate.feeUnits) + " 模拟金" : null,
        ],
        [
          "平仓净盈亏",
          closeEstimate ? (
            <PnlAmount units={closeEstimate.netPnlUnits} showUnit />
          ) : null,
        ],
        [
          "预计到账",
          closeEstimate ? sim(closeEstimate.payoutUnits) + " 模拟金" : null,
        ],
      ]
    : [
        [
          "数量",
          result ? coin(result.estimate.quantityAtoms) + " " + unit : null,
        ],
        [
          "成本（保证金 + 手续费）",
          result ? sim(result.estimate.costUnits) + " 模拟金" : null,
        ],
        [
          "预估强平价",
          result
            ? result.estimate.liquidationPriceUnits === null
              ? "不适用"
              : sim(result.estimate.liquidationPriceUnits) + " USDT"
            : null,
        ],
      ];
  function edit() {
    previewRequest.current++;
    setCalculating(false);
    setCalculated(null);
    setIntent(null);
    setMessage("");
    setPct(null);
  }
  function changeLeverage(value: string) {
    edit();
    setLeverageText(value);
  }
  function size(pct: number) {
    edit();
    setPct(pct);
    const n = percentageQuantity(sizing, pct);
    setQty(n ? (n / 1e8).toFixed(8) : "");
  }
  async function calculate() {
    if (problem || !quote || calculating) return;
    const request = ++previewRequest.current;
    setCalculating(true);
    try {
      let reference = px,
        asOf = quote.asOf,
        quantity = atoms,
        notional: number | undefined,
        worst: number | undefined;
      if (mode === "market") {
        const depth = await utils.client.perps.previewDepth.query({
          symbol: market.symbol,
          action,
          quantityAtoms: atoms,
          slippageBps,
        });
        if (request !== previewRequest.current) return;
        if (
          !depth.quantityAtoms ||
          depth.priceUnits === null ||
          (!closing && depth.quantityAtoms < atoms)
        )
          throw new Error("滑点保护范围内的深度不足，无法按所选数量成交");
        reference = depth.priceUnits;
        asOf = depth.asOf;
        quantity = depth.quantityAtoms;
        notional = depth.notionalUnits;
        worst = depth.worstPriceUnits ?? undefined;
      }
      const estimate = estimateOrder(sizing, quantity, notional);
      if (!estimate)
        throw new Error("当前参数或订单簿成交额超出可用额度，请调整数量后重试");
      setCalculated({ estimate, reference, asOf, context, worst });
      setMessage("");
    } catch (error) {
      if (request !== previewRequest.current) return;
      setCalculated(null);
      setMessage(
        error instanceof Error ? error.message : "行情预估失败，请重试"
      );
    } finally {
      if (request === previewRequest.current) setCalculating(false);
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
    if (problem || sending.current || calculating) return;
    if (!intent) {
      setMessage("");
      setIntent({
        symbol: market.symbol,
        action,
        quantityAtoms: atoms,
        ...(closing ? {} : { leverage }),
        ...(useSlippage ? { slippageBps } : {}),
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
      let notice: string;
      if (t.kind === "market") {
        const r = await direct.mutateAsync(base);
        notice =
          orderLabel[r.action] +
          "成交 " +
          coin(r.quantityAtoms) +
          " " +
          unit +
          " · 成交均价 " +
          sim(r.priceUnits) +
          " USDT · 手续费 " +
          sim(r.feeUnits) +
          " 模拟金。";
        if (r.quantityAtoms < intent.quantityAtoms)
          notice +=
            " 未成交 " +
            coin(intent.quantityAtoms - r.quantityAtoms) +
            " " +
            unit +
            " 已保留在原仓位，可重新提交平仓。";
      } else {
        const r = await pending.mutateAsync({ ...base, ...t });
        notice = "委托 #" + r.id + " 已受理，请在「我的委托」查看最新状态。";
      }
      setIntent(null);
      setCalculated(null);
      setQty("");
      setPct(null);
      if (onSubmitted) onSubmitted(notice);
      else setMessage(notice);
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
    <form onSubmit={confirm} className={closing ? undefined : panel}>
      {!closing && <h2 className="text-xl font-bold">逐仓委托</h2>}
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
        {useSlippage && (
          <label className="block">
            滑点上限（%）
            <input
              className={input}
              type="number"
              inputMode="decimal"
              min="0.01"
              max="10"
              step="0.01"
              aria-describedby={slippageHelpId}
              value={slippage}
              onChange={e => {
                edit();
                setSlippage(e.target.value);
              }}
            />
            <span id={slippageHelpId} className="text-xs text-muted-foreground">
              以成交时订单簿的最优价为基准，最多偏离所选比例。
            </span>
          </label>
        )}
        {!closing && (
          <label className="block">
            方向
            <select
              className={input}
              value={openAction}
              onChange={e => {
                edit();
                setOpenAction(e.target.value as OpenAction);
              }}
            >
              <option value="openLong" disabled={!canOpen}>
                做多
              </option>
              <option value="openShort" disabled={!canOpen}>
                做空
              </option>
            </select>
          </label>
        )}
        {!closing && (
          <div>
            <label htmlFor={leverageId}>杠杆（倍）</label>
            <input
              id={leverageId}
              name="leverage"
              className={input}
              type="number"
              inputMode="numeric"
              required
              min={rangeAvailable ? range.min : undefined}
              max={rangeAvailable ? range.max : undefined}
              step={1}
              value={leverageValue}
              disabled={leverageDisabled}
              aria-describedby={
                leverageProblem && visibleProblem === leverageProblem
                  ? leverageHelpId + " " + blockedReasonId
                  : leverageHelpId
              }
              aria-invalid={showLeverageError}
              onBlur={() => setLeverageChecked(true)}
              onChange={e => changeLeverage(e.target.value)}
            />
            <p
              id={leverageHelpId}
              className="mt-1 text-xs text-muted-foreground"
            >
              {pos && "已有持仓的杠杆不可修改。"}
              {rangeAvailable
                ? `本品种允许 ${range.min}×–${range.max}× 的整数杠杆。`
                : !range
                  ? "等待合约规格，暂不可选择杠杆。"
                  : "本品种暂无可用杠杆。"}
            </p>
            {!pos && rangeAvailable && range.min < range.max && (
              <div className="mt-2">
                <label htmlFor={leverageSliderId} className="text-sm">
                  滑动选择杠杆
                </label>
                <input
                  id={leverageSliderId}
                  className={rangeInput}
                  type="range"
                  min={range.min}
                  max={range.max}
                  step={1}
                  value={leverageProblem ? range.min : leverage}
                  disabled={leverageDisabled}
                  aria-describedby={leverageHelpId}
                  aria-valuetext={`${leverageProblem ? range.min : leverage} 倍`}
                  onChange={e => changeLeverage(e.target.value)}
                />
                <div
                  role="group"
                  aria-label="常用杠杆"
                  className="flex flex-wrap gap-1.5"
                >
                  {[
                    range.min,
                    ...commonLeverages.filter(
                      n => n > range.min && n < range.max
                    ),
                    range.max,
                  ].map(n => (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={leverage === n}
                      disabled={leverageDisabled}
                      className={`min-h-9 min-w-10 rounded-md border px-1.5 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 disabled:opacity-50 ${leverage === n ? "border-amber-300 bg-amber-400/15 font-bold text-amber-200" : "border-border hover:border-amber-300/70"}`}
                      onClick={() => changeLeverage(String(n))}
                    >
                      {n}×
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
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
        aria-label={estimateTitle}
        className="my-4 rounded-lg border border-border p-3"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">{estimateTitle}</h3>
          <button
            type="button"
            onClick={calculate}
            className={button}
            disabled={!!problem || busy || !!intent || calculating}
          >
            {calculating
              ? "估算中…"
              : result
                ? "重新计算"
                : closing
                  ? "计算收益"
                  : "计算"}
          </button>
        </div>
        <dl
          className="mt-2 space-y-1 text-sm tabular-nums"
          aria-live="polite"
          aria-atomic="true"
        >
          {estimateRows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-2">
              <dt>{label}</dt>
              <dd>{value ?? "计算"}</dd>
            </div>
          ))}
        </dl>
        {result && (
          <p className="mt-2 text-xs text-muted-foreground">
            {time(result.asOf)} 的参考估算：按
            {priced ? "限价" : conditional ? "触发价" : "订单簿预计均价"}{" "}
            {sim(result.reference)} USDT 计算，不锁定成交价。
            {result.worst !== undefined &&
              " 最差成交价 " + sim(result.worst) + " USDT。"}
            {result.estimate.quantityAtoms < atoms && " 当前深度仅能部分平仓。"}
            {closing &&
              " 净盈亏已扣本次平仓费，不重复计入已结算的开仓费或资金费。"}
          </p>
        )}
      </section>
      <p className="text-xs text-muted-foreground">
        {mode === "market"
          ? closing
            ? "按受理后的订单簿逐档成交，深度不足时可部分平仓。"
            : "按受理后的订单簿逐档成交，滑点范围内不足全额时拒单。"
          : mode === "limit"
            ? "买入不高于限价、卖出不低于限价时按盘口模拟成交。"
            : "以标记价格触发，触发后按" +
              (priced ? "限价等待成交。" : "当时的盘口模拟市价成交。")}
        {mode !== "market" && " 挂单不预冻结资金或仓位，成交时重新校验。"}
      </p>
      {visibleProblem && (
        <p id={blockedReasonId} className="mt-2 text-sm text-muted-foreground">
          {visibleProblem}
        </p>
      )}
      {intent && (
        <p className="mt-3 rounded border border-border p-2 text-sm text-[#ffd473]">
          确认{modes[intent.terms.kind]} · {orderLabel[intent.action]}{" "}
          {coin(intent.quantityAtoms)} {unit}
          {intent.leverage ? " · " + intent.leverage + "×" : ""}
          {intent.slippageBps
            ? " · 滑点上限 " + intent.slippageBps / 100 + "%"
            : ""}
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
        <button
          className={button}
          disabled={!!problem || busy || calculating}
          aria-describedby={
            visibleProblem
              ? blockedReasonId
              : problem
                ? leverageHelpId
                : undefined
          }
          type="submit"
        >
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
