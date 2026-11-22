import { confirmQuote, formatExchange, reviewReducer } from "./exchangeReview";
import { useReducer, useRef, useState } from "react";
import type { FormEvent } from "react";
import { trpc } from "@/providers/trpc";
import {
  button,
  credit,
  decimalUnits,
  input,
  panel,
  sim,
  coin,
  baseCoin,
  orderLabel,
  notionalUnits,
} from "./format";
import type { PerpApi } from "./format";

// One key per confirmed intent, including retries after an interrupted response.
function requestKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b =>
    b.toString(16).padStart(2, "0")
  ).join("");
}
type Action = "openLong" | "openShort" | "close";
type Leverage = 1 | 2 | 5;
export function TradeForm({
  market,
  account,
}: {
  market: PerpApi["market"];
  account: PerpApi["account"];
}) {
  const position = account.positions.find(p => p.symbol === market.symbol);
  const [action, setAction] = useState<Action>(position ? "close" : "openLong");
  const [leverage, setLeverage] = useState<Leverage>(1);
  const [quantity, setQuantity] = useState("");
  const [intent, setIntent] = useState<{
    symbol: PerpApi["market"]["symbol"];
    action: Action;
    quantityAtoms: number;
    leverage?: Leverage;
    requestKey: string;
  } | null>(null);
  const [message, setMessage] = useState("");
  const sending = useRef(false),
    utils = trpc.useUtils(),
    submit = trpc.perps.placeOrder.useMutation();
  const q = decimalUnits(quantity, 8),
    unit = baseCoin(market.symbol),
    quote = market.quote,
    spec = market.instrument;
  const canOpen =
    !!account.config.symbols.find(s => s.symbol === market.symbol)
      ?.openEnabled &&
    account.tradingEnabled &&
    market.tradingEnabled;
  const closing = action === "close",
    buying = action === "openLong" || (closing && position?.side === "short");
  const price = quote ? (buying ? quote.askUnits : quote.bidUnits) : 0;
  const notional = notionalUnits(q, price);
  const fee = Math.ceil((notional * account.config.takerFeeBps) / 10000);
  const effectiveLev = position?.leverage ?? leverage;
  const margin = closing ? 0 : Math.ceil(notional / effectiveLev);
  const conflict =
    position &&
    !closing &&
    (action === "openLong") !== (position.side === "long");
  const reason =
    !quote || !spec
      ? market.readOnlyReason || "等待新鲜的 Bybit 盘口和合约规格"
      : !closing && !canOpen
        ? "当前暂停开仓，已有仓位可平仓"
        : closing && !position
          ? "当前合约没有仓位可平"
          : conflict
            ? "单向持仓，请先平掉反向仓位"
            : !q
              ? "请输入大于零的数量，最多八位小数"
              : q % spec.qtyStepUnits !== 0 || q > spec.maxQtyUnits
                ? "数量不符合合约的交易步长或单笔上限"
                : closing && position && q > position.quantityAtoms
                  ? "平仓数量超过当前持仓"
                  : !closing &&
                      (q < spec.minQtyUnits || notional < spec.minNotionalUnits)
                    ? "数量或名义价值低于合约下限"
                    : !Number.isSafeInteger(notional)
                      ? "名义价值超出允许范围"
                      : !closing && margin + fee > account.availableCashUnits
                        ? "可用模拟金不足以支付保证金和手续费"
                        : "";
  function reset() {
    setIntent(null);
    setMessage("");
  }
  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (reason || sending.current) return;
    if (!intent) {
      setIntent({
        symbol: market.symbol,
        action,
        quantityAtoms: q,
        ...(closing ? {} : { leverage: effectiveLev as Leverage }),
        requestKey: requestKey(),
      });
      return;
    }
    sending.current = true;
    try {
      const order = await submit.mutateAsync(intent);
      setMessage(
        orderLabel[order.action] +
          "成交 " +
          coin(order.quantityAtoms) +
          " " +
          unit +
          "，成交价 " +
          sim(order.priceUnits) +
          " USDT，手续费 " +
          sim(order.feeUnits) +
          " 模拟金。"
      );
      setIntent(null);
      setQuantity("");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "提交失败，请重试。");
    } finally {
      sending.current = false;
      void utils.perps.account.invalidate();
      void utils.perps.market.invalidate({ symbol: market.symbol });
    }
  }
  return (
    <form onSubmit={confirm} className={panel}>
      <h2 className="text-xl font-bold">逐仓市价委托</h2>
      {!canOpen && (
        <p className="mt-2 text-sm text-muted-foreground">
          该合约暂时仅支持平仓。
        </p>
      )}
      <fieldset
        disabled={!!intent || submit.isPending}
        className="mt-4 space-y-3"
      >
        <label className="block">
          方向
          <select
            className={input}
            value={action}
            onChange={e => {
              setAction(e.target.value as Action);
              reset();
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
              value={effectiveLev}
              disabled={!!position}
              onChange={e => {
                setLeverage(Number(e.target.value) as Leverage);
                reset();
              }}
            >
              {account.config.allowedLeverage.map(v => (
                <option key={v} value={v}>
                  {v}×
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          数量（{unit}）
          <input
            className={input}
            value={quantity}
            required
            type="text"
            inputMode="decimal"
            onChange={e => {
              setQuantity(e.target.value);
              reset();
            }}
          />
        </label>
        {spec && (
          <p className="text-xs text-muted-foreground">
            步长 {coin(spec.qtyStepUnits)} {unit} · 最低开仓价值{" "}
            {sim(spec.minNotionalUnits)} USDT
          </p>
        )}
        {closing && position && (
          <button
            className={button}
            type="button"
            onClick={() => {
              setQuantity((position.quantityAtoms / 1e8).toFixed(8));
              reset();
            }}
          >
            全部平仓（{coin(position.quantityAtoms)} {unit}）
          </button>
        )}
      </fieldset>
      <dl className="mt-4 space-y-1 text-sm">
        <div>
          参考{buying ? "卖一" : "买一"}价 {price ? sim(price) : "—"} USDT
        </div>
        <div>名义价值 {sim(notional)} USDT</div>
        {!closing && <div>预估逐仓保证金 {sim(margin)} 模拟金</div>}
        <div>
          预估成交手续费 {sim(fee)} 模拟金（{account.config.takerFeeBps / 100}
          %）
        </div>
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        {reason || "按受理后的盘口模拟成交，实际价格和费用见回执。"}
      </p>
      {intent && (
        <p className="mt-3 text-sm text-[#ffd473]">
          确认{orderLabel[action]} {coin(q)} {unit}
          {!closing ? "，" + effectiveLev + "× 逐仓" : ""}？
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <button className={button} disabled={!!reason || submit.isPending}>
          {submit.isPending ? "提交中…" : intent ? "确认市价委托" : "核对委托"}
        </button>
        {intent && (
          <button
            type="button"
            className={button}
            disabled={submit.isPending}
            onClick={reset}
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

export function ExchangeForm({ account }: { account: PerpApi["account"] }) {
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [amount, setAmount] = useState("");
  const [review, dispatch] = useReducer(reviewReducer, null);
  const [message, setMessage] = useState("");
  const pendingPreview = useRef<string | null>(null);
  const sending = useRef(false);
  const utils = trpc.useUtils();
  const exchange = trpc.perps.exchange.useMutation();
  const toSim = direction === "in";
  const units = decimalUnits(amount, toSim ? 6 : 3);
  const enough =
    (!toSim || account.depositsEnabled) &&
    units > 0 &&
    units <=
      (toSim ? account.permanentCreditUnits : account.availableCashUnits);
  const quote = review?.quote;
  const display = quote && formatExchange(quote);
  function clear() {
    pendingPreview.current = null;
    dispatch({ type: "clear" });
    setMessage("");
  }
  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (!enough || sending.current || pendingPreview.current) return;
    if (!review) {
      const key = requestKey();
      pendingPreview.current = key;
      setMessage("");
      dispatch({ type: "start", key });
      try {
        // A fresh, explicit preview per intent; never confirm a refetched cache value.
        const quote = await utils.client.perps.exchangePreview.query({
          direction,
          amountUnits: units,
        });
        dispatch({ type: "finish", key, quote });
      } catch (err) {
        if (pendingPreview.current === key) {
          dispatch({ type: "clear" });
          setMessage(
            err instanceof Error ? err.message : "读取预览失败，请重试。"
          );
        }
      } finally {
        if (pendingPreview.current === key) pendingPreview.current = null;
      }
      return;
    }
    if (!quote) return;
    sending.current = true;
    try {
      const entry = await exchange.mutateAsync(confirmQuote(review));
      setMessage("兑换成功，实际到账 " + formatExchange(entry).received + "。");
      dispatch({ type: "clear" });
      setAmount("");
    } catch (err) {
      const problem = err instanceof Error ? err.message : "兑换失败，请重试。";
      // A rules conflict requires a fresh user-initiated preview. Network retries keep the original key.
      if (
        (err &&
          typeof err === "object" &&
          "data" in err &&
          (err.data as { code?: string } | null)?.code === "CONFLICT") ||
        /重新预览/.test(problem)
      ) {
        dispatch({ type: "clear" });
        setMessage("兑换规则已变更，请重新预览并核对到账金额。");
      } else setMessage(problem);
    } finally {
      sending.current = false;
      void utils.perps.account.invalidate();
      void utils.auth.me.invalidate();
    }
  }
  return (
    <form onSubmit={confirm} className={panel}>
      <h2 className="text-xl font-bold">余额兑换</h2>
      <p className="my-3 text-sm text-muted-foreground">
        {quote ? "本次预览" : "当前规则"}：1 余额 ={" "}
        {(quote?.exchangeRate ?? account.config.exchangeRate).toLocaleString(
          "zh-CN"
        )}{" "}
        模拟金。换入免费，兑回按总额收{" "}
        {(quote?.redemptionFeeBps ?? account.config.redemptionFeeBps) / 100}%
        手续费。
      </p>
      {!account.depositsEnabled && (
        <p role="status" className="my-2 text-sm">
          管理员已暂停换入，仍可兑回可用模拟金。
        </p>
      )}
      <fieldset disabled={!!review || exchange.isPending} className="space-y-3">
        <div>
          <label htmlFor="exchange-direction">兑换方向</label>
          <select
            id="exchange-direction"
            className={input}
            value={direction}
            onChange={e => {
              setDirection(e.target.value === "out" ? "out" : "in");
              setAmount("");
              clear();
            }}
          >
            <option value="in">余额 → 模拟金</option>
            <option value="out">模拟金 → 余额</option>
          </select>
        </div>
        <div>
          <label htmlFor="exchange-amount">
            {toSim ? "扣除站内余额" : "兑回模拟金"}
          </label>
          <input
            required
            id="exchange-amount"
            className={input}
            type="number"
            step={toSim ? "0.000001" : "0.001"}
            min={toSim ? "0.000001" : "0.001"}
            value={amount}
            onChange={e => {
              setAmount(e.target.value);
              clear();
            }}
          />
        </div>
      </fieldset>
      <p className="mt-2 text-xs text-muted-foreground">
        {toSim
          ? "可换入永久余额 " + credit(account.permanentCreditUnits)
          : "可兑回模拟金 " + sim(account.availableCashUnits)}
      </p>
      {review && (
        <div role="status" className="mt-3 rounded-lg bg-[#182b3c] p-3 text-sm">
          {display ? (
            <>
              <p>扣除 {display.debit}</p>
              <p>手续费 {display.fee}</p>
              <strong>实际到账 {display.received}</strong>
            </>
          ) : (
            "正在计算兑换金额…"
          )}
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <button
          className={button}
          disabled={!enough || exchange.isPending || (!!review && !quote)}
        >
          {exchange.isPending ? "提交中…" : quote ? "确认兑换" : "预览兑换"}
        </button>
        {review && (
          <button
            type="button"
            className={button}
            disabled={exchange.isPending}
            onClick={clear}
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
