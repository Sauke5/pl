import { searchMetadataPredicate } from "./search-metadata";
import {
  unfinishedTask,
  overdueTask as overdue,
  upcomingTask,
} from "./work-predicates";
import { listTaskLabels } from "../labels/task-labels";
import { listFieldValues } from "../fields/task-values";
import {
  and,
  asc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
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
import { moscowDate } from "./dates";
import { taskSearchInput, type TaskSearchInput } from "./search-schema";

/** Search predicates and content authorization run before pagination. */
export async function searchTasks(actorId: string, raw: TaskSearchInput) {
  const parsed = taskSearchInput.safeParse(raw);
  if (!parsed.success)
    throw new HTTPException(400, { message: "Invalid task search" });
  const input = parsed.data;
  const resourcePredicate = input.resourceSource
    ? sql`EXISTS (SELECT 1 FROM doska_resource_link AS resource_filter WHERE resource_filter.task_id=${taskTable.id} AND resource_filter.source=${input.resourceSource} AND resource_filter.object_type=${input.resourceType} AND resource_filter.object_id=${input.resourceObjectId})`
    : undefined;
  const pattern = input.q
    ? `%${input.q.replace(/[\\%_]/g, "\\$&")}%`
    : undefined;
  const number =
    input.q && /^#?\d+$/.test(input.q)
      ? Number(input.q.replace(/^#/, ""))
      : Number.NaN;
  return db.transaction(async (tx) => {
    const metadataPredicate = await searchMetadataPredicate(tx, actorId, input);
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
          metadataPredicate,
          resourcePredicate,
          input.archived
            ? undefined
            : and(
                isNull(taskTable.archivedAt),
                isNull(projectTable.archivedAt),
              ),
          input.projectId
            ? eq(taskTable.projectId, input.projectId)
            : undefined,
          input.assigneeId ? eq(taskTable.userId, input.assigneeId) : undefined,
          input.coexecutorId
            ? sql`EXISTS (SELECT 1 FROM task_coexecutor AS assignment WHERE assignment.task_id=${taskTable.id} AND assignment.user_id=${input.coexecutorId})`
            : undefined,
          input.open ? unfinishedTask : undefined,
          input.upcoming ? upcomingTask : undefined,
          input.state ? eq(columnTable.semanticState, input.state) : undefined,
          input.priority ? eq(taskTable.priority, input.priority) : undefined,
          input.unassigned === undefined
            ? undefined
            : input.unassigned
              ? isNull(taskTable.userId)
              : isNotNull(taskTable.userId),
          input.overdue === undefined
            ? undefined
            : input.overdue
              ? overdue
              : sql`NOT ${overdue}`,
          input.dueFrom
            ? gte(taskTable.dueDate, moscowDate(input.dueFrom))
            : undefined,
          input.dueTo
            ? lt(
                taskTable.dueDate,
                new Date(moscowDate(input.dueTo).getTime() + 86_400_000),
              )
            : undefined,
          pattern
            ? or(
                ilike(taskTable.title, pattern),
                ilike(taskTable.description, pattern),
                Number.isSafeInteger(number) && number <= 2_147_483_647
                  ? eq(taskTable.number, number)
                  : undefined,
                sql`EXISTS (SELECT 1 FROM comment AS search_comment WHERE search_comment.task_id=${taskTable.id} AND search_comment.deleted_at IS NULL AND search_comment.content ILIKE ${pattern})`,
              )
            : undefined,
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
    const visible = await tx
      .select({ id: taskTable.id })
      .from(taskTable)
      .where(
        and(
          inArray(taskTable.id, ids),
          resourcePredicate,
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
