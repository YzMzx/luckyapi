import { z } from "zod";
import { LEVEL_STAGES } from "../../contracts/levels";
import { memberQuery } from "../auth";
import { createRouter } from "../middleware";
import {
  equipLevelBadge,
  getLevelHall,
  getLevelProfile,
} from "../queries/levels";

export const levelsRouter = createRouter({
  profile: memberQuery.query(({ ctx }) => getLevelProfile(ctx.user.id)),
  hall: memberQuery.query(() => getLevelHall()),
  equip: memberQuery
    .input(
      z.object({
        level: z
          .number()
          .int()
          .refine(level => LEVEL_STAGES.some(stage => stage.level === level))
          .nullable(),
      })
    )
    .mutation(({ ctx, input }) => equipLevelBadge(ctx.user.id, input.level)),
});
