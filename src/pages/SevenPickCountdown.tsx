import { useEffect, useId, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";

type Round = Pick<
  NonNullable<inferRouterOutputs<AppRouter>["sevenPick"]["overview"]["round"]>,
  "status" | "opensAt" | "closesAt" | "drawAt"
>;

function remainingTime(deadline: number, now: number) {
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1_000));
  return [
    Math.floor(seconds / 3_600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map(value => String(value).padStart(2, "0"))
    .join(":");
}

export function SevenPickCountdown({
  round,
  serverOffset,
}: {
  round: Round;
  serverOffset: number;
}) {
  if (
    round.status !== "scheduled" &&
    round.status !== "open" &&
    round.status !== "sealed" &&
    round.status !== "ots_waiting"
  )
    return null;
  return <RoundTimers round={round} serverOffset={serverOffset} />;
}

function RoundTimers({
  round,
  serverOffset,
}: {
  round: Round;
  serverOffset: number;
}) {
  const labelId = useId();
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setClock(Date.now());
    const id = window.setInterval(tick, 1_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  const now = clock + serverOffset;
  const open = round.status === "scheduled";
  const showPhase =
    (open && now < round.opensAt) ||
    (round.status === "open" && now < round.closesAt);
  const duration = Math.max(1, round.drawAt - round.opensAt);
  const elapsed = Math.min(duration, Math.max(0, now - round.opensAt));
  const reachedDrawTime = now >= round.drawAt;

  return (
    <>
      {showPhase && (
        <p className="font-num tabular-nums">
          {open ? "距离开盘" : "距离封盘"}{" "}
          <span role="timer">
            {remainingTime(open ? round.opensAt : round.closesAt, now)}
          </span>
        </p>
      )}
      <div className="space-y-2 rounded-xl border border-border bg-background/50 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span id={labelId} className="text-sm font-semibold">
            开奖倒计时
          </span>
          {!reachedDrawTime && (
            <span
              role="timer"
              aria-labelledby={labelId}
              className="font-num font-bold tabular-nums text-[#FFB700]"
            >
              {remainingTime(round.drawAt, now)}
            </span>
          )}
        </div>
        <progress
          aria-labelledby={labelId}
          className="block w-full accent-[#FFB700]"
          value={elapsed}
          max={duration}
        />
        <p role="status" className="text-xs text-muted-foreground">
          {reachedDrawTime
            ? "已到目标开奖时间，等待验签及开奖结果。"
            : "倒计时以目标开奖时间为准，实际结果在验签通过后公布。"}
        </p>
      </div>
    </>
  );
}
