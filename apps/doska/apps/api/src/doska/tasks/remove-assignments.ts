import { and, asc, eq, inArray, or } from "drizzle-orm";
import { taskCoexecutorTable, taskTable } from "../../database/schema";
import type { Transaction } from "../projects/transaction";
import { recordTaskActivity } from "./transaction";

// The caller holds the project lock and commits membership and task history together.
export async function removeProjectTaskAssignments(
  tx: Transaction,
  actorId: string,
  projectId: string,
  userId: string,
) {
  const tasks = await tx
    .select()
    .from(taskTable)
    .where(
      and(
        eq(taskTable.projectId, projectId),
        or(
          eq(taskTable.userId, userId),
          inArray(
            taskTable.id,
            tx
              .select({ taskId: taskCoexecutorTable.taskId })
              .from(taskCoexecutorTable)
              .where(eq(taskCoexecutorTable.userId, userId)),
          ),
        ),
      ),
    )
    .orderBy(asc(taskTable.id))
    .for("update");
  if (!tasks.length) return;

  const taskIds = tasks.map((task) => task.id);
  const coexecutors = await tx
    .select()
    .from(taskCoexecutorTable)
    .where(inArray(taskCoexecutorTable.taskId, taskIds))
    .orderBy(asc(taskCoexecutorTable.userId));
  const assignments = new Map<string, string[]>();
  for (const row of coexecutors) {
    const ids = assignments.get(row.taskId) ?? [];
    ids.push(row.userId);
    assignments.set(row.taskId, ids);
  }
  await tx
    .delete(taskCoexecutorTable)
    .where(
      and(
        inArray(taskCoexecutorTable.taskId, taskIds),
        eq(taskCoexecutorTable.userId, userId),
      ),
    );
  for (const task of tasks) {
    const before = {
      userId: task.userId,
      coexecutorIds: assignments.get(task.id) ?? [],
    };
    const after = {
      userId: task.userId === userId ? null : task.userId,
      coexecutorIds: before.coexecutorIds.filter((id) => id !== userId),
    };
    await tx
      .update(taskTable)
      .set({
        userId: after.userId,
        revision: task.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(taskTable.id, task.id));
    await recordTaskActivity(
      tx,
      actorId,
      task.id,
      "doska.task.updated",
      before,
      after,
    );
  }
}
