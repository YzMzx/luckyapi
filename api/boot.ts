import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { env } from "./lib/env";
import { oauthApp } from "./routes/oauth";
import { gatewayApp } from "./routes/gateway";

const app = new Hono<{ Bindings: HttpBindings }>();

app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));
app.route("/api/oauth", oauthApp);
app.route("/", gatewayApp);
app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
  });
});
app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

if (env.isProduction) {
  // Fail fast on schema or volume problems and run all backward-compatible
  // SQLite migrations before the container starts accepting traffic.
  const { getDb } = await import("./queries/connection");
  const { expireAllCreditGrants } = await import("./queries/credit-grants");
  const { processLoanIncomeInterception } = await import("./routers/financeRouter");
  const db = getDb();
  db.transaction((tx) => expireAllCreditGrants(tx));
  processLoanIncomeInterception();
  setInterval(() => {
    try { db.transaction((tx) => expireAllCreditGrants(tx)); }
    catch (error) { console.error("Timed credit expiration failed", error); }
  }, 60_000).unref();
  setInterval(() => {
    try { processLoanIncomeInterception(); }
    catch (error) { console.error("Peer-loan collection failed", error); }
  }, 10_000).unref();

  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}
