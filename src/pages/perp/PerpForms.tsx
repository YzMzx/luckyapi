import { confirmQuote, formatExchange, reviewReducer } from "./exchangeReview";
import { useReducer, useRef, useState } from "react";
import type { FormEvent } from "react";
import { trpc } from "@/providers/trpc";
import { button, credit, decimalUnits, input, panel, sim } from "./format";
import type { PerpApi } from "./format";

// One key per confirmed intent, including retries after an interrupted response.
function requestKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b =>
    b.toString(16).padStart(2, "0")
  ).join("");
}
export { TradeForm } from "./TradeForm";

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
          {display && quote ? (
            <>
              <p>扣除 {display.debit}</p>
              <p>手续费 {display.fee}</p>
              <p>
                <strong>实际到账 {display.received}</strong>
              </p>
              {quote.direction === "out" && (
                <>
                  <p className="mt-1 font-semibold">
                    预计获得经验 {quote.estimatedExp.toLocaleString("zh-CN")}{" "}
                    EXP
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    扣除手续费并抵扣尚未收回的本金后，仅净盈利计经验。不足 1 EXP
                    的部分会累计，实际以入账为准。
                  </p>
                </>
              )}
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
