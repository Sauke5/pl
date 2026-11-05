import { listTaskLabels } from "../labels/task-labels";
import { listFieldValues } from "../fields/task-values";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  sql,
} from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  activityTable,
  columnTable,
  taskCoexecutorTable,
  taskTable,
  userTable,
} from "../../database/schema";
import { checklistProgress } from "./checklist-progress";
import { readProjectCondition } from "../read-project-condition";
import { historyReferences } from "./history-references";
import { authorizeTaskProject, lockTaskContext, taskDTO } from "./transaction";

type Page = { limit: number; offset: number };
function validatePage(page: Page) {
  if (
    !Number.isInteger(page.limit) ||
    page.limit < 1 ||
    page.limit > 100 ||
    !Number.isInteger(page.offset) ||
    page.offset < 0
  )
    throw new HTTPException(400, { message: "Invalid pagination" });
}

export async function getTask(
  actorId: string,
  projectId: string,
  taskId: string,
) {
  return db.transaction(async (tx) => {
    const { task } = await lockTaskContext(
      tx,
      actorId,
      projectId,
      taskId,
      "readContent",
    );
    if (!task) throw new HTTPException(404, { message: "Task not found" });
    const result = await taskDTO(tx, task);
    await authorizeTaskProject(tx, actorId, projectId, "readContent");
    return result;
  });
}

export async function listTasks(
  actorId: string,
  projectId: string,
  input: Page & { archived: boolean; parentTaskId?: string },
) {
  return db.transaction(async (tx) => {
    await lockTaskContext(
      tx,
      actorId,
      projectId,
      input.parentTaskId,
      "readContent",
    );
    validatePage(input);
    const rows = await tx
      .select({ task: taskTable })
      .from(taskTable)
      .leftJoin(columnTable, eq(columnTable.id, taskTable.columnId))
      .where(
        and(
          eq(taskTable.projectId, projectId),
          input.parentTaskId === undefined
            ? undefined
            : eq(taskTable.parentTaskId, input.parentTaskId),
          input.archived
            ? isNotNull(taskTable.archivedAt)
            : isNull(taskTable.archivedAt),
        ),
      )
      .orderBy(
        asc(columnTable.position),
        asc(taskTable.position),
        asc(taskTable.id),
      )
      .limit(input.limit)
      .offset(input.offset);
    const ids = rows.map(({ task }) => task.id);
    const progress = await checklistProgress(tx, ids);
    const customValues = await listFieldValues(tx, ids);
    const labels = await listTaskLabels(tx, ids);
    const assignments = ids.length
      ? await tx
          .select()
          .from(taskCoexecutorTable)
          .where(inArray(taskCoexecutorTable.taskId, ids))
          .orderBy(asc(taskCoexecutorTable.userId))
      : [];
    const coexecutors = new Map<string, string[]>();
    for (const { taskId, userId } of assignments) {
      const users = coexecutors.get(taskId) ?? [];
      users.push(userId);
      coexecutors.set(taskId, users);
    }
    const result = rows.map(({ task }) => ({
      ...task,
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
    await authorizeTaskProject(tx, actorId, projectId, "readContent");
    return result;
  });
}

function visibleRelationHistory(actorId: string) {
  return sql`(${activityTable.type} NOT LIKE 'doska.task.relation.%' OR EXISTS (
    SELECT 1 FROM task AS relation_history_target
    WHERE relation_history_target.id = ${activityTable.eventData}->>'otherTaskId'
      AND ${readProjectCondition(actorId, sql.raw("relation_history_target.project_id"))}
  ))`;
}

export async function getTaskHistory(
  actorId: string,
  projectId: string,
  taskId: string,
  input: Page,
) {
  return db.transaction(async (tx) => {
    await lockTaskContext(tx, actorId, projectId, taskId, "readContent");
    validatePage(input);
    const result = await tx
      .select({
        id: activityTable.id,
        taskId: activityTable.taskId,
        type: activityTable.type,
        createdAt: activityTable.createdAt,
        userId: activityTable.userId,
        eventData: activityTable.eventData,
        authorName: userTable.name,
      })
      .from(activityTable)
      .leftJoin(userTable, eq(userTable.id, activityTable.userId))
      .where(
        and(
          eq(activityTable.taskId, taskId),
          like(activityTable.type, "doska.task.%"),
          visibleRelationHistory(actorId),
        ),
      )
      .orderBy(desc(activityTable.createdAt), desc(activityTable.id))
      .limit(input.limit)
      .offset(input.offset);
    await authorizeTaskProject(tx, actorId, projectId, "readContent");
    if (!result.length) return [];
    const references = await historyReferences(tx, projectId, result);
    const allowed = await tx
      .select({ id: activityTable.id })
      .from(activityTable)
      .where(
        and(
          readProjectCondition(actorId, projectId),
          inArray(
            activityTable.id,
            result.map((row) => row.id),
          ),
          visibleRelationHistory(actorId),
        ),
      );
    const allowedIds = new Set(allowed.map((row) => row.id));
    return result
      .filter((row) => allowedIds.has(row.id))
      .map((row) => ({ ...row, references }));
  });
}
