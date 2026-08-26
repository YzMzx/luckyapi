import { createRouter, publicQuery } from "./middleware";
import { authRouter } from "./routers/authRouter";
import { drawRouter } from "./routers/drawRouter";
import { memberRouter } from "./routers/memberRouter";
import { adminRouter } from "./routers/adminRouter";
import { duelRouter } from "./routers/duelRouter";
import { entertainmentRouter } from "./routers/entertainmentRouter";
import { teamBattleRouter } from "./routers/teamBattleRouter";
import { financeRouter } from "./routers/financeRouter";
import { rankingsRouter } from "./routers/rankingsRouter";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  draw: drawRouter,
  member: memberRouter,
  duel: duelRouter,
  entertainment: entertainmentRouter,
  teamBattle: teamBattleRouter,
  finance: financeRouter,
  rankings: rankingsRouter,
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;
