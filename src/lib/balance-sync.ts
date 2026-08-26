type BalanceRefreshListener = () => void;

const listeners = new Set<BalanceRefreshListener>();
let scheduled = false;

/**
 * Coalesced process-local balance refresh event. Every successful business mutation may
 * request a refresh, while all requests completed in the same turn result in one auth.me
 * refetch. This also gives room polling a single shared path for remote settlements.
 */
export function requestBalanceRefresh() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    for (const listener of listeners) listener();
  });
}

export function subscribeBalanceRefresh(listener: BalanceRefreshListener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
