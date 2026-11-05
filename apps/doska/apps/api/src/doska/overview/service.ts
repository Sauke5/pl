import { and, asc, eq, isNull, sql } from "drizzle-orm";
import db from "../../database";
import {
  columnTable,
  projectTable,
  taskTable,
  userTable,
} from "../../database/schema";
import { readProjectCondition } from "../read-project-condition";
import {
  unfinishedTask,
  overdueTask,
  upcomingTask,
} from "../tasks/work-predicates";
import { taskSearchInput } from "../tasks/search-schema";

export async function getOverview(
  actorId: string,
  page: { limit?: number; offset?: number } = {},
) {
  const { limit, offset } = taskSearchInput.parse(page);
  return db.transaction(
    async (tx) => {
      const visible = and(
        readProjectCondition(actorId, taskTable.projectId),
        isNull(taskTable.archivedAt),
        isNull(projectTable.archivedAt),
        unfinishedTask,
      );
      const [totals] = await tx
        .select({
          active:
            sql<number>`count(*) FILTER (WHERE ${columnTable.semanticState} = 'active')`.mapWith(
              Number,
            ),
          overdue: sql<number>`count(*) FILTER (WHERE ${overdueTask})`.mapWith(
            Number,
          ),
          unassigned:
            sql<number>`count(*) FILTER (WHERE ${taskTable.userId} IS NULL)`.mapWith(
              Number,
            ),
          upcoming:
            sql<number>`count(*) FILTER (WHERE ${upcomingTask})`.mapWith(
              Number,
            ),
        })
        .from(taskTable)
        .innerJoin(projectTable, eq(projectTable.id, taskTable.projectId))
        .leftJoin(columnTable, eq(columnTable.id, taskTable.columnId))
        .where(visible);
      if (!totals) throw new Error("Overview aggregate missing");
      const count = sql<number>`count(*)`.mapWith(Number);
      const assignees = await tx
        .select({ userId: userTable.id, name: userTable.name, count })
        .from(taskTable)
        .innerJoin(projectTable, eq(projectTable.id, taskTable.projectId))
        .leftJoin(columnTable, eq(columnTable.id, taskTable.columnId))
        .innerJoin(userTable, eq(userTable.id, taskTable.userId))
        .where(visible)
        .groupBy(userTable.id, userTable.name)
        .orderBy(sql`count(*) DESC`, asc(userTable.id))
        .limit(limit + 1)
        .offset(offset);
      return {
        totals,
        assignees: assignees.slice(0, limit),
        hasMore: assignees.length > limit,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
