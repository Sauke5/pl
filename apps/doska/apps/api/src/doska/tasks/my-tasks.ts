import { listTaskLabels } from "../labels/task-labels";
import { listFieldValues } from "../fields/task-values";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import db from "../../database";
import {
  columnTable,
  projectTable,
  taskCoexecutorTable,
  taskTable,
  userTable,
} from "../../database/schema";
import { checklistProgress } from "./checklist-progress";
import { readProjectCondition } from "../read-project-condition";

/** Assignment and current content ACL are applied before pagination. */
export async function listMyTasks(
  actorId: string,
  input: { limit: number; offset: number; archived: boolean },
) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        task: taskTable,
        columnName: columnTable.name,
        columnState: columnTable.semanticState,
        projectName: projectTable.name,
        projectSlug: projectTable.slug,
        assigneeName: userTable.name,
      })
      .from(taskTable)
      .innerJoin(projectTable, eq(projectTable.id, taskTable.projectId))
      .leftJoin(columnTable, eq(columnTable.id, taskTable.columnId))
      .leftJoin(userTable, eq(userTable.id, taskTable.userId))
      .where(
        and(
          readProjectCondition(actorId, taskTable.projectId),
          or(
            eq(taskTable.userId, actorId),
            sql`EXISTS (SELECT 1 FROM task_coexecutor AS assignment WHERE assignment.task_id = ${taskTable.id} AND assignment.user_id = ${actorId})`,
          ),
          input.archived
            ? isNotNull(taskTable.archivedAt)
            : and(
                isNull(taskTable.archivedAt),
                isNull(projectTable.archivedAt),
              ),
        ),
      )
      .orderBy(sql`${taskTable.dueDate} ASC NULLS LAST`, asc(taskTable.id))
      .limit(input.limit)
      .offset(input.offset);
    if (!rows.length) return [];
    const ids = rows.map(({ task }) => task.id);
    const progress = await checklistProgress(tx, ids);
    const customValues = await listFieldValues(tx, ids);
    const labels = await listTaskLabels(tx, ids);
    const assignments = await tx
      .select()
      .from(taskCoexecutorTable)
      .where(inArray(taskCoexecutorTable.taskId, ids))
      .orderBy(asc(taskCoexecutorTable.userId));
    const coexecutors = new Map<string, string[]>();
    for (const { taskId, userId } of assignments) {
      const users = coexecutors.get(taskId) ?? [];
      users.push(userId);
      coexecutors.set(taskId, users);
    }
    // Recheck current leases and membership after reading the related rows.
    const visible = await tx
      .select({ id: taskTable.id })
      .from(taskTable)
      .where(
        and(
          inArray(taskTable.id, ids),
          readProjectCondition(actorId, taskTable.projectId),
        ),
      );
    const visibleIds = new Set(visible.map(({ id }) => id));
    return rows
      .filter(({ task }) => visibleIds.has(task.id))
      .map(({ task, ...metadata }) => ({
        ...task,
        ...metadata,
        labels: labels.get(task.id) ?? [],
        customValues: customValues.get(task.id) ?? [],
        coexecutorIds: coexecutors.get(task.id) ?? [],
        checklistProgress: {
          total: progress.get(task.id)?.total ?? 0,
          done: progress.get(task.id)?.done ?? 0,
        },
        checklistPreview: progress.get(task.id)?.preview ?? [],
        checklistGroups: progress.get(task.id)?.groups ?? [],
      }));
  });
}
