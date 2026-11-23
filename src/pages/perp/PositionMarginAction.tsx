import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { trpc } from "@/providers/trpc";
import { button, input, sim, type PerpApi } from "./format";
import {
  createMarginAttempt,
  isDefiniteMarginRejection,
  marginAmount,
  matchingMarginReview,
  type MarginAttempt,
  type MarginReview,
} from "./positionMarginReview";
import "./PositionMarginAction.css";

type Position = Pick<
  PerpApi["account"]["positions"][number],
  | "symbol"
  | "openedAt"
  | "side"
  | "quantityAtoms"
  | "marginUnits"
  | "liquidationPriceUnits"
> & { liquidationTriggeredAt?: number | null };

const price = (units: number) => (units === 0 ? "—" : sim(units));
const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export function PositionMarginAction({
  position,
  availableCashUnits,
}: {
  position: Position;
  availableCashUnits: number;
}) {
  const { symbol, openedAt, side, liquidationTriggeredAt, marginUnits } =
    position;
  const context = symbol + (side === "long" ? " 多仓" : " 空仓");
  const liquidating = liquidationTriggeredAt != null;
  const basis = [
    position.quantityAtoms,
    marginUnits,
    position.liquidationPriceUnits,
    availableCashUnits,
  ].join(":");
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const amountField = useRef<HTMLInputElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const pendingPreview = useRef<AbortController | null>(null);
  const sending = useRef(false);
  const [amount, setAmount] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [notice, setNotice] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [review, setReview] = useState<MarginReview | null>(null);
  const [attempt, setAttempt] = useState<MarginAttempt | null>(null);
  const utils = trpc.useUtils();
  const addMargin = trpc.perps.addMargin.useMutation({
    retry: false,
    // Never queue a confirmation to run automatically after reconnecting.
    networkMode: "always",
  });
  const amountResult = marginAmount(amount, availableCashUnits);
  const payload = {
    symbol,
    openedAt,
    amountUnits: amountResult.amountUnits ?? 0,
  };
  const freshReview = liquidating
    ? null
    : matchingMarginReview(review, payload, basis);
  const quote = attempt?.quote ?? freshReview?.quote;

  useEffect(() => {
    if (freshReview && !attempt && dialog.current?.open)
      reviewHeading.current?.focus();
  }, [freshReview, attempt]);
  useEffect(() => () => pendingPreview.current?.abort(), []);

  function cancelPreview() {
    pendingPreview.current?.abort();
    pendingPreview.current = null;
    setPreviewing(false);
    setReview(null);
  }

  function reset() {
    cancelPreview();
    setFieldError("");
    // After an ambiguous result, keep the original intent for idempotent retry on reopen.
    if (!attempt) {
      setAmount("");
      setNotice("");
    }
  }

  async function preview(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (
      !dialog.current?.open ||
      attempt ||
      sending.current ||
      pendingPreview.current ||
      liquidating ||
      freshReview
    )
      return;
    if (amountResult.error) {
      setFieldError(amountResult.error);
      amountField.current?.focus();
      return;
    }
    const controller = new AbortController();
    pendingPreview.current = controller;
    setPreviewing(true);
    setNotice("");
    setReview(null);
    try {
      const quote = await utils.client.perps.previewMargin.query(payload, {
        signal: controller.signal,
      });
      if (pendingPreview.current === controller && dialog.current?.open)
        setReview({ input: payload, basis, quote });
    } catch (error) {
      if (pendingPreview.current === controller && dialog.current?.open)
        setNotice(messageOf(error, "无法预览保证金，请重试。"));
    } finally {
      if (pendingPreview.current === controller) {
        pendingPreview.current = null;
        setPreviewing(false);
      }
    }
  }

  async function confirm() {
    if (!dialog.current?.open || sending.current || pendingPreview.current)
      return;
    const intent = createMarginAttempt(attempt, freshReview, () =>
      Array.from(crypto.getRandomValues(new Uint8Array(16)), n =>
        n.toString(16).padStart(2, "0")
      ).join("")
    );
    if (!intent) return;
    sending.current = true;
    setAttempt(intent);
    setNotice("");
    try {
      const result = await addMargin.mutateAsync(intent.request);
      setAttempt(null);
      cancelPreview();
      setAmount("");
      dialog.current?.close();
      toast.success(
        "保证金追加成功，当前保证金 " + sim(result.marginUnits) + " 模拟金。"
      );
    } catch (error) {
      if (isDefiniteMarginRejection(error)) {
        setAttempt(null);
        setReview(null);
        setNotice(messageOf(error, "无法追加保证金，请重新预览。"));
      } else {
        setNotice("未能确认追加结果。重试将使用同一请求，不会重复追加。");
      }
    } finally {
      sending.current = false;
      // Refresh position, cash and chart even after a rejection or lost response.
      void utils.perps.account.invalidate();
    }
  }

  return (
    <>
      <button
        type="button"
        className={button}
        aria-haspopup="dialog"
        onClick={() => {
          dialog.current?.showModal();
          if (!liquidating && !attempt) amountField.current?.focus();
        }}
      >
        追加保证金<span className="sr-only"> {context}</span>
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={id + "-title"}
        aria-describedby={id + "-risk"}
        className="perp-margin-dialog m-auto max-h-[90dvh] w-[min(28rem,calc(100%-2rem))] overflow-y-auto rounded-2xl border border-border bg-[#101d2b] p-5 text-foreground"
        onClose={reset}
        onCancel={e => {
          if (sending.current) e.preventDefault();
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 id={id + "-title"} className="text-xl font-bold">
            追加保证金 · {context}
          </h2>
          <form method="dialog">
            <button
              type="submit"
              className={button}
              disabled={addMargin.isPending}
            >
              关闭
            </button>
          </form>
        </div>
        <p id={id + "-risk"} className="my-3 text-sm text-muted-foreground">
          从可用模拟金转入此逐仓仓位。不下单、不收手续费，也不会自动追加。追加后仍可能强平，投入的模拟金可能全部损失。
        </p>
        {liquidating && (
          <p role="status" className="my-3 text-sm text-[#ffce68]">
            此仓位已触发强平，不可发起新的保证金追加。
          </p>
        )}
        <form onSubmit={preview} noValidate aria-labelledby={id + "-title"}>
          <label
            className="block text-sm font-semibold"
            htmlFor={id + "-amount"}
          >
            追加金额（模拟金）
          </label>
          <p id={id + "-hint"} className="my-1 text-sm text-muted-foreground">
            当前可用：{sim(availableCashUnits)} 模拟金。请输入最多三位小数，例如
            1.250。
          </p>
          <input
            ref={amountField}
            className={input + " perp-margin-amount"}
            id={id + "-amount"}
            name="amount"
            type="text"
            inputMode="decimal"
            required
            value={amount}
            readOnly={!!attempt || liquidating}
            aria-invalid={!!fieldError}
            aria-describedby={
              id + "-hint" + (fieldError ? " " + id + "-amount-error" : "")
            }
            onChange={e => {
              if (attempt || sending.current) return;
              cancelPreview();
              setAmount(e.target.value);
              setFieldError("");
              setNotice("");
            }}
          />
          <p
            id={id + "-amount-error"}
            className="text-sm text-[#ffce68]"
            aria-live="polite"
          >
            {fieldError}
          </p>
          <div className="my-3">
            {quote && (
              <h3
                tabIndex={-1}
                ref={reviewHeading}
                className="mb-2 font-semibold"
              >
                {attempt ? "已确认的追加预览" : "核对追加预览"}
              </h3>
            )}
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1 text-sm tabular-nums">
              <dt>当前保证金</dt>
              <dd>{sim(quote?.previousMarginUnits ?? marginUnits)} 模拟金</dd>
              <dt>追加后保证金</dt>
              <dd>{quote ? sim(quote.marginUnits) + " 模拟金" : "—"}</dd>
              <dt>当前预估强平价</dt>
              <dd>
                {price(
                  quote?.previousLiquidationPriceUnits ??
                    position.liquidationPriceUnits
                )}
              </dd>
              <dt>追加后预估强平价</dt>
              <dd>{quote ? price(quote.liquidationPriceUnits) : "—"}</dd>
              <dt>追加后可用模拟金</dt>
              <dd>{quote ? sim(quote.availableCashUnits) + " 模拟金" : "—"}</dd>
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">
              强平价单位为 USDT；预览仅供参考，以系统实际处理结果为准。
            </p>
          </div>
          <p role="status" className="my-2 text-sm text-[#ffce68]">
            {notice ||
              (review && !freshReview && !attempt && !liquidating
                ? "持仓或可用模拟金已变更，请重新预览。"
                : "")}
          </p>
          {attempt || freshReview ? (
            <button
              type="button"
              className={button}
              onClick={() => void confirm()}
              disabled={addMargin.isPending}
            >
              {addMargin.isPending
                ? "正在追加，请稍候…"
                : attempt
                  ? "重试同一笔追加"
                  : "确认追加保证金"}
            </button>
          ) : (
            <button
              type="submit"
              className={button}
              disabled={previewing || liquidating}
            >
              {previewing ? "正在预览…" : "预览追加保证金"}
            </button>
          )}
        </form>
      </dialog>
    </>
  );
}
