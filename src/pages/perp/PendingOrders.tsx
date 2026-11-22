import { useRef, useState } from "react";
import { trpc } from "@/providers/trpc";
import {
  baseCoin,
  button,
  coin,
  orderLabel,
  panel,
  sim,
  stamp,
  type PerpApi,
} from "./format";
import { Table } from "./shared";

type Pending = PerpApi["pendingOrders"][number];
const active = (order: Pending) =>
  order.status === "pending" || order.status === "triggered";
function statusText(order: Pending) {
  if (order.status === "pending")
    return order.orderType === "conditional" ? "等待触发" : "等待成交";
  if (order.status === "triggered") return "已触发，等待成交";
  if (order.status === "filled") return "已成交";
  if (order.status === "cancelled") return "已撤销";
  return "已拒绝";
}
function orderTypeText(order: Pending) {
  return order.orderType === "limit"
    ? "限价"
    : order.limitPriceUnits == null
      ? "条件市价"
      : "条件限价";
}

export function PendingOrderRows({
  orders,
  title,
  cancellingId,
  onCancel,
}: {
  orders: Pending[];
  title: string;
  cancellingId?: number | null;
  onCancel?: (order: Pending) => void;
}) {
  return (
    <Table
      title={title}
      columns={[
        "委托号 / 合约",
        "类型 / 方向",
        "数量",
        "触发条件（标记价）",
        "限价（USDT）",
        "状态",
        "提交时间（北京）",
        ...(onCancel ? ["操作"] : []),
      ]}
    >
      {orders.map(o => (
        <tr key={o.id}>
          <th scope="row" className="sticky left-0 bg-[#101d2b] px-3 py-2">
            #{o.id} · {o.symbol}
          </th>
          <td>
            {orderTypeText(o)} · {orderLabel[o.action]}
            {o.action === "close" ? (o.side === "long" ? "多" : "空") : ""}
            {o.leverage ? " · " + o.leverage + "×" : ""}
          </td>
          <td>
            {coin(o.quantityAtoms)} {baseCoin(o.symbol)}
          </td>
          <td>
            {o.triggerPriceUnits == null
              ? "—"
              : (o.triggerDirection === "above" ? "≥ " : "≤ ") +
                sim(o.triggerPriceUnits) +
                " USDT"}
          </td>
          <td>{o.limitPriceUnits == null ? "市价" : sim(o.limitPriceUnits)}</td>
          <td>
            {statusText(o)}
            {o.status === "rejected" && o.reason && (
              <small className="block max-w-64 whitespace-normal text-muted-foreground">
                {o.reason}
              </small>
            )}
          </td>
          <td>{stamp(o.createdAt)}</td>
          {onCancel && (
            <td>
              {active(o) && (
                <button
                  type="button"
                  aria-label={"撤销 " + o.symbol + " 委托 #" + o.id}
                  disabled={cancellingId != null}
                  className={button}
                  onClick={() => onCancel(o)}
                >
                  {cancellingId === o.id ? "撤单中…" : "撤单"}
                </button>
              )}
            </td>
          )}
        </tr>
      ))}
    </Table>
  );
}

export function PendingOrders() {
  const utils = trpc.useUtils();
  const list = trpc.perps.pendingOrders.useQuery(undefined, {
    refetchInterval: 5000,
    retry: 1,
  });
  const cancel = trpc.perps.cancelPending.useMutation();
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const orders = list.data ?? [];
  const working = orders.filter(active),
    history = orders.filter(o => !active(o));
  async function revoke(o: Pending) {
    if (lock.current) return;
    lock.current = true;
    setMessage("");
    try {
      const latest = await cancel.mutateAsync({ id: o.id });
      setMessage("委托 #" + o.id + "：" + statusText(latest) + "。");
    } catch (error) {
      setMessage(
        "撤单未确认：" +
          (error instanceof Error ? error.message : "请刷新委托列表后重试。")
      );
    } finally {
      try {
        await Promise.all([
          utils.perps.pendingOrders.invalidate(),
          utils.perps.account.invalidate(),
        ]);
      } finally {
        lock.current = false;
      }
    }
  }
  return (
    <section className={panel} aria-labelledby="pending-orders-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-bold" id="pending-orders-title">
          我的委托
        </h2>
        <button
          type="button"
          className={button}
          disabled={list.isFetching}
          onClick={() => void list.refetch()}
        >
          {list.isFetching ? "刷新中…" : "刷新委托"}
        </button>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        限价单及条件单在服务端等待撮合，无需保持页面打开；成交前可撤销。提交时不冻结资金或仓位，成交时重新检查可用额度。
      </p>
      {list.isLoading ? (
        <p className="mt-3 text-sm" role="status">
          正在读取委托…
        </p>
      ) : list.error ? (
        <p className="mt-3 text-sm" role="alert">
          委托读取失败：{list.error.message}
        </p>
      ) : (
        <>
          {working.length ? (
            <PendingOrderRows
              orders={working}
              title="当前有效委托"
              cancellingId={cancel.isPending ? cancel.variables?.id : null}
              onCancel={o => void revoke(o)}
            />
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              当前没有等待成交的委托。
            </p>
          )}
          {history.length > 0 && (
            <details className="mt-4">
              <summary className="w-fit cursor-pointer text-sm font-semibold">
                最近已结束委托（{history.length}）
              </summary>
              <PendingOrderRows orders={history} title="最近已结束委托" />
            </details>
          )}
        </>
      )}
      <p role="status" className="mt-2 text-sm">
        {message}
      </p>
    </section>
  );
}
