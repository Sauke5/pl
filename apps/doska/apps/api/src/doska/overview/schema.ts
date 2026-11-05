import { z } from "../../openapi";
const count = z.number().int().nonnegative();
export const overviewSchema = z.object({
  totals: z.object({
    active: count,
    overdue: count,
    unassigned: count,
    upcoming: count,
  }),
  assignees: z.array(z.object({ userId: z.string(), name: z.string(), count })),
  hasMore: z.boolean(),
});
