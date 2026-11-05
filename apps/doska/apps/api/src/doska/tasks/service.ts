import { prepareTaskLabels, applyTaskLabels } from "../labels/task-labels";
import {
  prepareTaskFields,
  applyTaskFields,
  assertStandardRequired,
} from "../fields/task-values";
import { cardColors } from "./card-color";
import { and, asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  columnTable,
  taskCoexecutorTable,
  taskReminderSentTable,
  taskTable,
} from "../../database/schema";
import { claimTaskNumber } from "../../task/controllers/claim-task-numbers";
import { nextTaskPosition } from "../../task/controllers/next-task-position";
import { getProjectCapabilities } from "../project-access";
import { persistAssignmentNotifications } from "../notifications/assignments";
import {
  authorizeTaskProject,
  lockTaskContext,
  recordTaskActivity,
  taskDTO,
  type Transaction,
} from "./transaction";
import { assertCompletionAllowed, assertParentAllowed } from "./hierarchy";
import { placeTaskBefore } from "./ordering";
import type { CreateTaskInput, UpdateTaskInput } from "./types";
export type { CreateTaskInput, UpdateTaskInput } from "./types";
const badInput = () =>
  new HTTPException(400, { message: "Invalid task input" });
function validate(input: Partial<CreateTaskInput>) {
  if (
    input.parentTaskId !== undefined &&
    input.parentTaskId !== null &&
    (typeof input.parentTaskId !== "string" || !input.parentTaskId)
  )
    throw badInput();
  if (
    input.title !== undefined &&
    (typeof input.title !== "string" ||
      !input.title.trim() ||
      input.title.trim().length > 500)
  )
    throw badInput();
  if (
    input.description !== undefined &&
    input.description !== null &&
    (typeof input.description !== "string" ||
      input.description.length > 100_000)
  )
    throw badInput();
  if (
    input.columnId !== undefined &&
    (typeof input.columnId !== "string" || !input.columnId)
  )
    throw badInput();
  if (
    input.userId !== undefined &&
    input.userId !== null &&
    (typeof input.userId !== "string" || !input.userId)
  )
    throw badInput();
  if (
    input.priority !== undefined &&
    !["no-priority", "low", "medium", "high", "urgent"].includes(input.priority)
  )
    throw badInput();
  if (
    input.cardColor !== undefined &&
    input.cardColor !== null &&
    !cardColors.includes(input.cardColor)
  )
    throw badInput();
  for (const date of [input.startDate, input.dueDate])
    if (
      date !== undefined &&
      date !== null &&
      (!(date instanceof Date) || !Number.isFinite(date.getTime()))
    )
      throw badInput();
  if (
    input.dueDateHasTime !== undefined &&
    typeof input.dueDateHasTime !== "boolean"
  )
    throw badInput();
  if (
    input.coexecutorIds !== undefined &&
    (!Array.isArray(input.coexecutorIds) ||
      input.coexecutorIds.length > 100 ||
      input.coexecutorIds.some((id) => typeof id !== "string" || !id))
  )
    throw badInput();
}
async function checkAssignments(
  tx: Transaction,
  projectId: string,
  userId: string | null,
  coexecutorIds: string[],
  previous?: { userId: string | null; coexecutorIds: string[] },
) {
  if (userId && coexecutorIds.includes(userId))
    throw new HTTPException(400, {
      message: "Responsible user cannot also be a coexecutor",
    });
  const newAssignments = [
    ...(userId && userId !== previous?.userId ? [userId] : []),
    ...coexecutorIds.filter((id) => !previous?.coexecutorIds.includes(id)),
  ];
  for (const id of newAssignments) {
    if (
      !(await getProjectCapabilities(id, projectId, { database: tx }))
        .workOnTasks
    )
      throw new HTTPException(400, { message: "Task assignee unavailable" });
  }
}
async function column(tx: Transaction, projectId: string, columnId?: string) {
  const [result] = await tx
    .select()
    .from(columnTable)
    .where(
      and(
        eq(columnTable.projectId, projectId),
        columnId === undefined ? undefined : eq(columnTable.id, columnId),
      ),
    )
    .orderBy(asc(columnTable.position), asc(columnTable.id))
    .limit(1);
  if (!result)
    throw new HTTPException(400, { message: "Task column unavailable" });
  return result;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export async function createTask(
  actorId: string,
  projectId: string,
  input: CreateTaskInput,
) {
  return db.transaction((tx) =>
    createTaskInTransaction(tx, actorId, projectId, input),
  );
}

export async function createTaskInTransaction(
  tx: Transaction,
  actorId: string,
  projectId: string,
  input: CreateTaskInput,
) {
  validate(input);
  if (input.title === undefined) throw badInput();
  const { project } = await lockTaskContext(tx, actorId, projectId);
  const labels = await prepareTaskLabels(tx, undefined, input.labels);
  assertStandardRequired(project.requiredTaskFields, input, true);
  const customFields = await prepareTaskFields(
    tx,
    projectId,
    undefined,
    input.customValues,
  );
  await assertParentAllowed(
    tx,
    projectId,
    undefined,
    input.parentTaskId ?? null,
  );
  const selected = await column(tx, projectId, input.columnId);
  const coexecutorIds = [...new Set(input.coexecutorIds ?? [])].sort();
  const userId = input.userId ?? null;
  await checkAssignments(tx, projectId, userId, coexecutorIds);
  if (input.dueDateHasTime && !input.dueDate) throw badInput();
  if (input.startDate && input.dueDate && input.startDate > input.dueDate)
    throw badInput();
  const number = await claimTaskNumber(projectId, tx);
  const [task] = await tx
    .insert(taskTable)
    .values({
      projectId,
      parentTaskId: input.parentTaskId ?? null,
      title: input.title.trim(),
      description: input.description ?? null,
      userId,
      priority: input.priority ?? "no-priority",
      cardColor: input.cardColor ?? null,
      columnId: selected.id,
      status: selected.slug,
      number,
      position: await nextTaskPosition(
        tx,
        projectId,
        selected.slug,
        selected.id,
      ),
      startDate: input.startDate ?? null,
      dueDate: input.dueDate ?? null,
      dueDateHasTime: input.dueDateHasTime ?? false,
    })
    .returning();
  if (!task) throw new Error("Task insert failed");
  if (coexecutorIds.length)
    await tx
      .insert(taskCoexecutorTable)
      .values(coexecutorIds.map((userId) => ({ taskId: task.id, userId })));
  await applyTaskFields(tx, task.id, customFields.changes);
  if (labels.changed) await applyTaskLabels(tx, task.id, labels.after);
  const after = await taskDTO(tx, task);
  await recordTaskActivity(
    tx,
    actorId,
    task.id,
    "doska.task.created",
    null,
    after,
  );
  await persistAssignmentNotifications(tx, {
    actorId,
    projectId,
    taskId: task.id,
    before: { userId: null, coexecutorIds: [] },
    after,
  });
  await authorizeTaskProject(tx, actorId, projectId);
  await checkAssignments(tx, projectId, userId, coexecutorIds);
  return after;
}
export async function updateTask(
  actorId: string,
  projectId: string,
  taskId: string,
  input: UpdateTaskInput,
) {
  validate(input);
  if (
    input.beforeTaskId !== undefined &&
    input.beforeTaskId !== null &&
    (typeof input.beforeTaskId !== "string" || !input.beforeTaskId)
  )
    throw badInput();
  if (
    input.confirmIncompleteSubtasks !== undefined &&
    typeof input.confirmIncompleteSubtasks !== "boolean"
  )
    throw badInput();
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  )
    throw badInput();
  return db.transaction(async (tx) => {
    const { task, project } = await lockTaskContext(
      tx,
      actorId,
      projectId,
      taskId,
    );
    if (!task) throw new HTTPException(404, { message: "Task not found" });
    if (task.archivedAt)
      throw new HTTPException(409, { message: "Task is archived" });
    if (task.revision !== input.expectedRevision)
      throw new HTTPException(409, { message: "Task revision conflict" });
    if (
      input.parentTaskId !== undefined &&
      input.parentTaskId !== task.parentTaskId
    )
      await assertParentAllowed(tx, projectId, task.id, input.parentTaskId);
    assertStandardRequired(project.requiredTaskFields, input, false);
    const customFields = await prepareTaskFields(
      tx,
      projectId,
      taskId,
      input.customValues,
    );
    const labels = await prepareTaskLabels(tx, taskId, input.labels);
    const before = await taskDTO(tx, task);
    const coexecutorIds =
      input.coexecutorIds === undefined
        ? before.coexecutorIds
        : [...new Set(input.coexecutorIds)].sort();
    const userId = input.userId === undefined ? task.userId : input.userId;
    await checkAssignments(tx, projectId, userId, coexecutorIds, before);
    const patch: Partial<typeof taskTable.$inferInsert> = {};
    for (const key of [
      "parentTaskId",
      "title",
      "description",
      "userId",
      "priority",
      "cardColor",
      "startDate",
      "dueDate",
      "dueDateHasTime",
    ] as const) {
      if (input[key] !== undefined) Object.assign(patch, { [key]: input[key] });
    }
    if (patch.title !== undefined) patch.title = patch.title.trim();
    const dueDate = input.dueDate === undefined ? task.dueDate : input.dueDate;
    const startDate =
      input.startDate === undefined ? task.startDate : input.startDate;
    if (startDate && dueDate && startDate > dueDate) throw badInput();
    if (!dueDate) {
      if (input.dueDateHasTime) throw badInput();
      patch.dueDateHasTime = false;
    }
    let confirmedSubtaskIds: string[] = [];
    if (input.columnId !== undefined) {
      const selected = await column(tx, projectId, input.columnId);
      confirmedSubtaskIds = await assertCompletionAllowed(
        tx,
        task,
        selected,
        input.confirmIncompleteSubtasks === true,
      );
      patch.columnId = selected.id;
      patch.status = selected.slug;
      if (selected.id !== task.columnId && input.beforeTaskId === undefined)
        patch.position = await nextTaskPosition(
          tx,
          projectId,
          selected.slug,
          selected.id,
        );
    }
    const changedBefore: Record<string, unknown> = {};
    const changedAfter: Record<string, unknown> = {};
    if (input.beforeTaskId !== undefined) {
      const targetColumnId = patch.columnId ?? task.columnId;
      if (!targetColumnId) throw badInput();
      const order = await placeTaskBefore(
        tx,
        task,
        targetColumnId,
        input.beforeTaskId,
      );
      patch.position = order.position;
      if (order.changed) {
        changedBefore.beforeTaskId = order.previousBeforeTaskId;
        changedAfter.beforeTaskId = input.beforeTaskId;
      }
    }
    for (const [key, value] of Object.entries(patch)) {
      const old = task[key as keyof typeof task];
      if (!equal(old, value)) {
        changedBefore[key] = old;
        changedAfter[key] = value;
      }
    }
    if (!equal(before.coexecutorIds, coexecutorIds)) {
      changedBefore.coexecutorIds = before.coexecutorIds;
      changedAfter.coexecutorIds = coexecutorIds;
    }
    if (customFields.changes.length) {
      changedBefore.customValues = customFields.changes.map((change) => ({
        fieldId: change.fieldId,
        value:
          customFields.before.find((item) => item.fieldId === change.fieldId)
            ?.value ?? null,
      }));
      changedAfter.customValues = customFields.changes;
    }
    if (labels.changed) {
      changedBefore.labels = labels.before;
      changedAfter.labels = labels.after;
    }
    if (!Object.keys(changedAfter).length) {
      await authorizeTaskProject(tx, actorId, projectId);
      await checkAssignments(tx, projectId, userId, coexecutorIds, before);
      return before;
    }
    const [updated] = await tx
      .update(taskTable)
      .set({ ...patch, revision: task.revision + 1 })
      .where(
        and(
          eq(taskTable.id, taskId),
          eq(taskTable.revision, input.expectedRevision),
        ),
      )
      .returning();
    if (!updated)
      throw new HTTPException(409, { message: "Task revision conflict" });
    await applyTaskFields(tx, taskId, customFields.changes);
    if (labels.changed) await applyTaskLabels(tx, taskId, labels.after);
    if (!equal(before.coexecutorIds, coexecutorIds)) {
      await tx
        .delete(taskCoexecutorTable)
        .where(eq(taskCoexecutorTable.taskId, taskId));
      if (coexecutorIds.length)
        await tx
          .insert(taskCoexecutorTable)
          .values(coexecutorIds.map((userId) => ({ taskId, userId })));
    }
    if (
      !equal(task.dueDate, updated.dueDate) ||
      task.dueDateHasTime !== updated.dueDateHasTime
    )
      await tx
        .delete(taskReminderSentTable)
        .where(eq(taskReminderSentTable.taskId, taskId));
    await recordTaskActivity(
      tx,
      actorId,
      taskId,
      "doska.task.updated",
      changedBefore,
      changedAfter,
    );
    if (confirmedSubtaskIds.length)
      await recordTaskActivity(
        tx,
        actorId,
        taskId,
        "doska.task.incomplete_subtasks_confirmed",
        null,
        { incompleteSubtaskIds: confirmedSubtaskIds },
      );
    const after = await taskDTO(tx, updated);
    await persistAssignmentNotifications(tx, {
      actorId,
      projectId,
      taskId,
      before,
      after,
    });
    await checkAssignments(tx, projectId, userId, coexecutorIds, before);
    await authorizeTaskProject(tx, actorId, projectId);
    return after;
  });
}
