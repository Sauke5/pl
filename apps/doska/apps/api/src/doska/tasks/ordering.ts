import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { taskTable } from "../../database/schema";
import { MAX_TASK_POSITION } from "../../task/controllers/next-task-position";
import type { Task, Transaction } from "./transaction";

// lockTaskContext holds the project row through commit. Resolve an anchor against
// current rows, never against a client's possibly filtered or paginated list.
export async function placeTaskBefore(
  tx: Transaction,
  task: Task,
  columnId: string,
  beforeTaskId: string | null,
) {
  const scope = and(
    eq(taskTable.projectId, task.projectId),
    eq(taskTable.columnId, columnId),
    isNull(taskTable.archivedAt),
  );
  const rows = await tx
    .select({ id: taskTable.id })
    .from(taskTable)
    .where(scope)
    .orderBy(asc(taskTable.position), asc(taskTable.id));
  const currentIndex = rows.findIndex((row) => row.id === task.id);
  const previousBeforeTaskId =
    currentIndex < 0 ? null : (rows[currentIndex + 1]?.id ?? null);
  const peers = rows.filter((row) => row.id !== task.id);
  const index =
    beforeTaskId === null
      ? peers.length
      : peers.findIndex((row) => row.id === beforeTaskId);
  if (index < 0)
    throw new HTTPException(409, {
      message: "Task order changed; refresh the board",
    });
  if (currentIndex >= 0 && previousBeforeTaskId === beforeTaskId)
    return { position: task.position, changed: false, previousBeforeTaskId };
  if (peers.length >= MAX_TASK_POSITION)
    throw new HTTPException(409, {
      message: "Task column has reached its capacity",
    });
  const position = index + 1;
  // Integer positions are already part of the storage contract. Normalize in
  // one statement, reserving the insertion slot and preserving all peers.
  await tx.execute(sql`
    WITH ranked AS (
      SELECT ${taskTable.id} AS id,
        row_number() OVER (ORDER BY ${taskTable.position}, ${taskTable.id}) AS ordinal
      FROM ${taskTable}
      WHERE ${and(scope, ne(taskTable.id, task.id))}
    )
    UPDATE ${taskTable}
      SET position = (ranked.ordinal + CASE WHEN ranked.ordinal >= ${position} THEN 1 ELSE 0 END)::integer
    FROM ranked
    WHERE ${taskTable.id} = ranked.id
      AND ${taskTable.position} IS DISTINCT FROM (ranked.ordinal + CASE WHEN ranked.ordinal >= ${position} THEN 1 ELSE 0 END)::integer
  `);
  return { position, changed: true, previousBeforeTaskId };
}
