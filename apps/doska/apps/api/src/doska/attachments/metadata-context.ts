import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { doskaAttachmentUploadTable as uploads } from "../../database/schema";
import {
  authorizeTaskProject,
  lockTaskContext,
  type Transaction,
} from "../tasks/transaction";
export type Upload = typeof uploads.$inferSelect;
export const failure = (status: 400 | 404 | 409 | 413, message: string) =>
  new HTTPException(status, { message });
export function attachmentDTO(row: Upload) {
  return {
    id: row.id,
    filename: row.filename,
    size: row.size,
    createdAt: row.createdAt,
    createdBy: row.actorId,
  };
}
export async function withTask<T>(
  actorId: string,
  projectId: string,
  taskId: string,
  write: boolean,
  run: (tx: Transaction) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    const capability = write ? "workOnTasks" : "readContent";
    const { task } = await lockTaskContext(
      tx,
      actorId,
      projectId,
      taskId,
      capability,
    );
    if (write && task!.archivedAt) throw failure(409, "Task is archived");
    const result = await run(tx);
    await authorizeTaskProject(tx, actorId, projectId, capability);
    return result;
  });
}
export async function findUpload(
  tx: Transaction,
  projectId: string,
  taskId: string,
  id: string,
) {
  const [row] = await tx
    .select()
    .from(uploads)
    .where(
      and(
        eq(uploads.id, id),
        eq(uploads.projectId, projectId),
        eq(uploads.taskId, taskId),
      ),
    )
    .for("update");
  return row;
}
export function requireTicket(
  row: Upload | undefined,
  actorId: string,
  binding: string,
) {
  if (!row || row.actorId !== actorId || row.sessionBinding !== binding)
    throw failure(404, "Upload not found");
  if (
    row.state === "deleting" ||
    (row.state !== "ready" && row.expiresAt <= new Date())
  )
    throw failure(409, "Upload expired or cancelled");
  return row;
}
