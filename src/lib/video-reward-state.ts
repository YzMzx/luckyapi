export type VideoSessionProgress = {
  id: number;
  sessionToken?: string;
  status: string;
  watchedMs: number;
  watchedSeconds: number;
  lastSequence: number;
  ready: boolean;
};

const statusRank = (status: string) => status === "claimed" || status === "expired" ? 3 : status === "ready" ? 2 : status === "active" ? 1 : 0;

/** Accept only the newest heartbeat sequence and never regress confirmed progress. */
export function mergeVideoSession<T extends VideoSessionProgress>(current: T | null, incoming: T): T {
  if (!current || current.id !== incoming.id) return incoming;
  if (incoming.lastSequence < current.lastSequence) return current;
  const watchedMs = Math.max(current.watchedMs, incoming.watchedMs);
  const watchedSeconds = Math.max(current.watchedSeconds, incoming.watchedSeconds, Math.floor(watchedMs / 1_000));
  const status = statusRank(current.status) > statusRank(incoming.status) ? current.status : incoming.status;
  const ready = current.ready || incoming.ready || status === "ready" || status === "claimed";
  const sessionToken = status === "claimed" || status === "expired" ? incoming.sessionToken : incoming.sessionToken ?? current.sessionToken;
  if (
    incoming.lastSequence === current.lastSequence
    && watchedMs === current.watchedMs
    && watchedSeconds === current.watchedSeconds
    && status === current.status
    && ready === current.ready
    && sessionToken === current.sessionToken
  ) return current;
  return {
    ...current,
    ...incoming,
    sessionToken,
    watchedMs,
    watchedSeconds,
    status,
    ready,
  } as T;
}

export function monotonicWatchedSeconds(current: number, serverConfirmed: number, required: number) {
  return Math.min(required, Math.max(0, current, serverConfirmed));
}
