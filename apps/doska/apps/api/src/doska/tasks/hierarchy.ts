import { and, asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { columnTable, taskTable } from "../../database/schema";
import type { Task, Transaction } from "./transaction";

// Callers hold the project lock, so checking and writing a relation is atomic.
export async function assertParentAllowed(
  tx: Transaction,
  projectId: string,
  taskId: string | undefined,
  parentTaskId: string | null,
) {
  if (parentTaskId === null) return;
  if (parentTaskId === taskId)
    throw new HTTPException(400, { message: "Task cannot be its own parent" });
  const [parent] = await tx
    .select()
    .from(taskTable)
    .where(
      and(eq(taskTable.id, parentTaskId), eq(taskTable.projectId, projectId)),
    );
  if (!parent || parent.archivedAt)
    throw new HTTPException(400, { message: "Parent task unavailable" });
  if (parent.parentTaskId)
    throw new HTTPException(400, {
      message: "Only one subtask level is allowed",
    });
  if (taskId) {
    const [child] = await tx
      .select({ id: taskTable.id })
      .from(taskTable)
      .where(eq(taskTable.parentTaskId, taskId))
      .limit(1);
    if (child)
      throw new HTTPException(400, {
        message: "Only one subtask level is allowed",
      });
  }
}

// Batch column moves can exclude children that complete in the same transaction.
export async function assertCompletionAllowed(
  tx: Transaction,
  task: Task,
  destinationColumn: { semanticState: string | null },
  confirm: boolean,
  completedTaskIds: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  if (destinationColumn.semanticState !== "completed") return [];
  const [current] = task.columnId
    ? await tx
        .select()
        .from(columnTable)
        .where(eq(columnTable.id, task.columnId))
    : [];
  if (current?.semanticState === "completed") return [];
  const children = await tx
    .select({
      id: taskTable.id,
      semanticState: columnTable.semanticState,
    })
    .from(taskTable)
    .leftJoin(columnTable, eq(taskTable.columnId, columnTable.id))
    .where(
      and(
        eq(taskTable.parentTaskId, task.id),
        eq(taskTable.projectId, task.projectId),
      ),
    )
    .orderBy(asc(taskTable.id));
  const incomplete = children
    .filter(
      (child) =>
        child.semanticState !== "completed" && !completedTaskIds.has(child.id),
    )
    .map((child) => child.id);
  if (incomplete.length && !confirm)
    throw new HTTPException(409, { message: "Есть незавершённые подзадачи" });
  return incomplete;
}
