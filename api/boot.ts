import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { env } from "./lib/env";
import { oauthApp } from "./routes/oauth";
import { gatewayApp } from "./routes/gateway";
import { sevenPickImagesApp } from "./routes/sevenPickImages";
import { sevenPickProofApp } from "./routes/sevenPickProof";

const app = new Hono<{ Bindings: HttpBindings }>();

app.route("/seven-pick-images", sevenPickImagesApp);
app.route("/api/seven-pick", sevenPickProofApp);
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
  const { PERP_MAINTENANCE_INTERVAL_MS, refreshPerpMaintenance } = await import("./perp/maintenance");
  const { SEVEN_PICK_MAINTENANCE_INTERVAL_MS, tickSevenPickMaintenance } = await import("./seven-pick/maintenance");
  const { sevenPickLaunchReady } = await import("./seven-pick/release");
  const { refreshSevenPickSealTimestamps } = await import("./seven-pick/seal-timestamp");
  const db = getDb();
  function refreshSevenPick() {
    void tickSevenPickMaintenance(db.$client, {
      allowLaunch: sevenPickLaunchReady(),
      onError: (error, roundId) => console.error("Seven Pick maintenance round failed", roundId, error),
    }).catch((error: unknown) => console.error("Seven Pick maintenance failed", error));
  }
  refreshSevenPick();
  setInterval(refreshSevenPick, SEVEN_PICK_MAINTENANCE_INTERVAL_MS).unref();
  const refreshSealTimestamps = () => {
    void refreshSevenPickSealTimestamps(db.$client).catch((error: unknown) => console.error("Seven Pick timestamps failed", error));
  };
  refreshSealTimestamps();
  setInterval(refreshSealTimestamps, 5_000).unref();
  void refreshPerpMaintenance(db.$client);
  setInterval(() => { void refreshPerpMaintenance(db.$client); }, PERP_MAINTENANCE_INTERVAL_MS).unref();
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
