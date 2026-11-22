import { useEffect } from "react";
import { trpc } from "@/providers/trpc";

/** Only a visible contracts tab signals presence. Closed and background tabs expire server-side. */
export function usePerpPresence(enabled: boolean) {
  const client = trpc.useUtils().client;
  useEffect(() => {
    if (!enabled) return;
    let pending = false;
    const pulse = () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      void client.perps.heartbeat
        .mutate()
        .catch(() => {})
        .finally(() => {
          pending = false;
        });
    };
    pulse();
    const timer = window.setInterval(pulse, 30000);
    document.addEventListener("visibilitychange", pulse);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", pulse);
    };
  }, [client, enabled]);
}
