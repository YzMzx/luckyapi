import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { subscribeBalanceRefresh } from "@/lib/balance-sync";

/** 获取当前登录用户；requireAuth/requireOnboarded 控制自动跳转 */
export function useMe(opts?: { requireAuth?: boolean; requireOnboarded?: boolean }) {
  const navigate = useNavigate();
  const query = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    // Covers gateway/API usage and balance changes that happen outside the current tab.
    refetchInterval: 15_000,
  });
  const user = query.data ?? null;
  const refetchRef = useRef(query.refetch);
  useEffect(() => { refetchRef.current = query.refetch; }, [query.refetch]);

  useEffect(() => subscribeBalanceRefresh(() => {
    // cancelRefetch prevents an older in-flight auth.me response from overwriting the newest one.
    void refetchRef.current({ cancelRefetch: true });
  }), []);

  useEffect(() => {
    if (query.isLoading) return;
    if (opts?.requireAuth && !user) navigate("/", { replace: true });
    else if (opts?.requireOnboarded && user && !user.onboarded) navigate("/onboarding", { replace: true });
  }, [query.isLoading, user, navigate, opts?.requireAuth, opts?.requireOnboarded]);

  return { user, isLoading: query.isLoading, refetch: query.refetch };
}
