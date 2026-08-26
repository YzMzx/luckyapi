/* eslint-disable react-refresh/only-export-components */
import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import superjson from "superjson";
import type { AppRouter } from "../../api/router";
import type { ReactNode } from "react";
import { requestBalanceRefresh } from "@/lib/balance-sync";

export const trpc = createTRPCReact<AppRouter>();

const balanceRefreshLink: TRPCLink<AppRouter> = () => ({ op, next }) => observable((observer) => {
  let succeeded = false;
  const subscription = next(op).subscribe({
    next(value) {
      succeeded = true;
      observer.next(value);
    },
    error(error) { observer.error(error); },
    complete() {
      // Heartbeats run every second and never change balance; all other successful mutations
      // share one coalesced refresh path. Non-balance mutations are intentionally harmless.
      if (succeeded && op.type === "mutation" && op.path !== "entertainment.heartbeatVideoReward")
        requestBalanceRefresh();
      observer.complete();
    },
  });
  return () => subscription.unsubscribe();
});

const queryClient = new QueryClient();
const trpcClient = trpc.createClient({
  links: [
    balanceRefreshLink,
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

export function TRPCProvider({ children }: { children: ReactNode }) {
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </trpc.Provider>
  );
}
