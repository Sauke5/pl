import { listTaskLabels } from "../labels/task-labels";
import { listFieldValues } from "../fields/task-values";
import { publishLiveChanges } from "../live/publisher";
import type { LiveScope } from "../live/events";
import { and, asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  activityTable,
  projectTable,
  taskCoexecutorTable,
  taskTable,
} from "../../database/schema";
import { getProjectCapabilities } from "../project-access";
import { lockDirectory, type Transaction } from "../projects/transaction";
import { checklistProgress } from "./checklist-progress";
export type { Transaction } from "../projects/transaction";
export type Task = typeof taskTable.$inferSelect;
export type TaskCapability = "workOnTasks" | "readContent" | "deleteTask";

export async function authorizeTaskProject(
  tx: Transaction,
  actorId: string,
  projectId: string,
  capability: TaskCapability = "workOnTasks",
) {
  const capabilities = await getProjectCapabilities(actorId, projectId, {
    database: tx,
  });
  if (!capabilities.readContent)
    throw new HTTPException(404, { message: "Project not found" });
  if (!capabilities[capability])
    throw new HTTPException(403, {
      message: "Task operation is not permitted",
    });
  return capabilities;
}

export async function lockTaskContext(
  tx: Transaction,
  actorId: string,
  projectId: string,
  taskId?: string,
  capability: TaskCapability = "workOnTasks",
) {
  await lockDirectory(tx);
  const [project] = await tx
    .select()
    .from(projectTable)
    .where(eq(projectTable.id, projectId))
    .for("update");
  await authorizeTaskProject(tx, actorId, projectId, capability);
  if (!project) throw new HTTPException(404, { message: "Project not found" });
  if (project.archivedAt && capability !== "readContent")
    throw new HTTPException(409, { message: "Project is archived" });
  let task: Task | undefined;
  if (taskId !== undefined) {
    [task] = await tx
      .select()
      .from(taskTable)
      .where(and(eq(taskTable.id, taskId), eq(taskTable.projectId, projectId)))
      .for("update");
    if (!task) throw new HTTPException(404, { message: "Task not found" });
  }
  return { project, task };
}

export async function taskDTO(tx: Transaction, task: Task) {
  const coexecutors = await tx
    .select({ userId: taskCoexecutorTable.userId })
    .from(taskCoexecutorTable)
    .where(eq(taskCoexecutorTable.taskId, task.id))
    .orderBy(asc(taskCoexecutorTable.userId));
  const progress = await checklistProgress(tx, [task.id]);
  const customValues =
    (await listFieldValues(tx, [task.id])).get(task.id) ?? [];
  return {
    ...task,
    labels: (await listTaskLabels(tx, [task.id])).get(task.id) ?? [],
    customValues,
    coexecutorIds: coexecutors.map((row) => row.userId),
    checklistProgress: {
      total: progress.get(task.id)?.total ?? 0,
      done: progress.get(task.id)?.done ?? 0,
    },
    checklistPreview: progress.get(task.id)?.preview ?? [],
    checklistGroups: progress.get(task.id)?.groups ?? [],
  };
}
export async function recordTaskActivity(
  tx: Transaction,
  actorId: string,
  taskId: string,
  type: string,
  before: unknown,
  after: unknown,
  publish = true,
) {
  await tx
    .insert(activityTable)
    .values({ taskId, userId: actorId, type, eventData: { before, after } });
  if (!publish) return;
  const [task] = await tx
    .select({
      projectId: taskTable.projectId,
      parentTaskId: taskTable.parentTaskId,
    })
    .from(taskTable)
    .where(eq(taskTable.id, taskId));
  if (task) {
    const scopes: LiveScope[] = ["tasks", "history", "subtasks"];
    if (type.includes("checklist")) scopes.push("checklists");
    if (type.includes("comment")) scopes.push("comments");
    if (type.includes("attachment")) scopes.push("attachments");
    if (type.includes("relation")) scopes.push("relations");
    if (
      [before, after].some(
        (value) => value && typeof value === "object" && "labels" in value,
      )
    )
      scopes.push("labels");
    const parents = [before, after].flatMap((value) =>
      value &&
      typeof value === "object" &&
      "parentTaskId" in value &&
      typeof value.parentTaskId === "string"
        ? [value.parentTaskId]
        : [],
    );
    await publishLiveChanges(tx, [
      {
        kind: "project",
        projectId: task.projectId,
        taskIds: [
          taskId,
          ...(task.parentTaskId ? [task.parentTaskId] : []),
          ...parents,
        ],
        scopes,
      },
    ]);
  }
}
