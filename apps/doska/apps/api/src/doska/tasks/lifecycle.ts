import { publishTaskDeletion } from "../live/publications";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { projectAuditTable, taskTable } from "../../database/schema";
import {
  authorizeTaskProject,
  lockTaskContext,
  recordTaskActivity,
  taskDTO,
} from "./transaction";

export async function archiveTask(
  actorId: string,
  projectId: string,
  taskId: string,
  input: { expectedRevision: number; archived: boolean },
) {
  return db.transaction(async (tx) => {
    const { task } = await lockTaskContext(tx, actorId, projectId, taskId);
    if (!task) throw new HTTPException(404, { message: "Task not found" });
    if (task.revision !== input.expectedRevision)
      throw new HTTPException(409, { message: "Task revision conflict" });
    if (Boolean(task.archivedAt) === input.archived) {
      const result = await taskDTO(tx, task);
      await authorizeTaskProject(tx, actorId, projectId, "workOnTasks");
      return result;
    }
    const before = await taskDTO(tx, task);
    const [updated] = await tx
      .update(taskTable)
      .set({
        archivedAt: input.archived ? new Date() : null,
        revision: task.revision + 1,
      })
      .where(eq(taskTable.id, taskId))
      .returning();
    if (!updated) throw new HTTPException(404, { message: "Task not found" });
    const after = await taskDTO(tx, updated);
    await recordTaskActivity(
      tx,
      actorId,
      taskId,
      input.archived ? "doska.task.archived" : "doska.task.restored",
      before,
      after,
    );
    await authorizeTaskProject(tx, actorId, projectId, "workOnTasks");
    return after;
  });
}

export async function deleteTask(
  actorId: string,
  projectId: string,
  taskId: string,
  input: { expectedRevision: number },
) {
  return db.transaction(async (tx) => {
    const { task } = await lockTaskContext(
      tx,
      actorId,
      projectId,
      taskId,
      "deleteTask",
    );
    if (!task) throw new HTTPException(404, { message: "Task not found" });
    if (task.revision !== input.expectedRevision)
      throw new HTTPException(409, { message: "Task revision conflict" });
    const children = await tx
      .select()
      .from(taskTable)
      .where(
        and(
          eq(taskTable.parentTaskId, taskId),
          eq(taskTable.projectId, projectId),
        ),
      );
    for (const child of children) {
      await tx
        .update(taskTable)
        .set({ parentTaskId: null, revision: child.revision + 1 })
        .where(eq(taskTable.id, child.id));
      await recordTaskActivity(
        tx,
        actorId,
        child.id,
        "doska.task.parent_deleted",
        { parentTaskId: taskId, revision: child.revision },
        { parentTaskId: null, revision: child.revision + 1 },
      );
    }
    await publishTaskDeletion(tx, task);
    await tx.delete(taskTable).where(eq(taskTable.id, taskId));
    await tx.insert(projectAuditTable).values({
      projectId,
      actorUserId: actorId,
      operation: "task.deleted",
      payload: { taskId, number: task.number },
    });
    await authorizeTaskProject(tx, actorId, projectId, "deleteTask");
    return { id: taskId };
  });
}
