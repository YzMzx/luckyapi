import { createRouter, publicQuery } from "./middleware";
import { authRouter } from "./routers/authRouter";
import { drawRouter } from "./routers/drawRouter";
import { memberRouter } from "./routers/memberRouter";
import { adminRouter } from "./routers/adminRouter";
import { duelRouter } from "./routers/duelRouter";
import { entertainmentRouter } from "./routers/entertainmentRouter";
import { financeRouter } from "./routers/financeRouter";
import { rankingsRouter } from "./routers/rankingsRouter";
import { levelsRouter } from "./routers/levelsRouter";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  draw: drawRouter,
  member: memberRouter,
  levels: levelsRouter,
  duel: duelRouter,
  entertainment: entertainmentRouter,
  finance: financeRouter,
  rankings: rankingsRouter,
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;
