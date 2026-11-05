import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { doskaAttachmentUploadTable as uploads } from "../../database/schema";
import { recordTaskActivity } from "../tasks/transaction";
import { validateAttachmentMetadata } from "./policy";
import {
  attachmentDTO,
  failure,
  findUpload,
  requireTicket,
  withTask,
} from "./metadata-context";
export { cleanupCandidates, markRemoved } from "./metadata-cleanup";
export const ATTACHMENT_QUOTA_BYTES = 20_000_000_000;
export const ATTACHMENT_OBJECT_LIMIT = 100_000;
export type ReserveInput = {
  filename: string;
  size: number;
  sha256: string;
  clientRequestId: string;
};
export async function reserve(
  actorId: string,
  projectId: string,
  taskId: string,
  binding: string,
  input: ReserveInput,
) {
  const validated = validateAttachmentMetadata(input);
  if (
    !/^[a-f0-9]{64}$/.test(binding) ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(input.clientRequestId)
  )
    throw failure(400, "Invalid upload metadata");
  return withTask(actorId, projectId, taskId, true, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('doska-attachment-quota-v1', 0))`,
    );
    const [existing] = await tx
      .select()
      .from(uploads)
      .where(
        and(
          eq(uploads.actorId, actorId),
          eq(uploads.sessionBinding, binding),
          eq(uploads.clientRequestId, input.clientRequestId),
        ),
      );
    if (existing) {
      if (
        existing.projectId !== projectId ||
        existing.taskId !== taskId ||
        existing.filename !== validated.filename ||
        existing.size !== input.size ||
        existing.sha256 !== input.sha256
      )
        throw failure(409, "Upload request conflict");
      return requireTicket(existing, actorId, binding);
    }
    const [total] = await tx
      .select({
        bytes: sql<string>`coalesce(sum(${uploads.size}),0)`,
        count: sql<string>`count(*)`,
      })
      .from(uploads);
    if (Number(total!.count) >= ATTACHMENT_OBJECT_LIMIT)
      throw failure(413, "Attachment object limit exceeded");
    if (Number(total!.bytes) + input.size > ATTACHMENT_QUOTA_BYTES)
      throw failure(413, "Attachment quota exceeded");
    const [row] = await tx
      .insert(uploads)
      .values({
        actorId,
        projectId,
        taskId,
        sessionBinding: binding,
        clientRequestId: input.clientRequestId,
        filename: validated.filename,
        size: input.size,
        sha256: input.sha256,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      })
      .returning();
    return row!;
  });
}
export async function inspectUpload(
  actorId: string,
  projectId: string,
  taskId: string,
  binding: string,
  id: string,
) {
  return withTask(actorId, projectId, taskId, true, async (tx) =>
    requireTicket(
      await findUpload(tx, projectId, taskId, id),
      actorId,
      binding,
    ),
  );
}
export async function beginReceiving(
  actorId: string,
  projectId: string,
  taskId: string,
  binding: string,
  id: string,
) {
  return withTask(actorId, projectId, taskId, true, async (tx) => {
    const row = requireTicket(
      await findUpload(tx, projectId, taskId, id),
      actorId,
      binding,
    );
    if (row.state === "receiving")
      throw failure(409, "Upload is already receiving");
    if (row.state !== "reserved") return row;
    const [updated] = await tx
      .update(uploads)
      .set({
        state: "receiving",
        objectKey: randomUUID(),
        receivingUntil: new Date(Date.now() + 125_000),
        updatedAt: new Date(),
      })
      .where(eq(uploads.id, id))
      .returning();
    return updated!;
  });
}
export async function markUploaded(
  actorId: string,
  projectId: string,
  taskId: string,
  binding: string,
  id: string,
  actual: { objectKey: string; size: number; sha256: string; deadline?: Date },
) {
  return withTask(actorId, projectId, taskId, true, async (tx) => {
    const row = requireTicket(
      await findUpload(tx, projectId, taskId, id),
      actorId,
      binding,
    );
    if (
      row.objectKey !== actual.objectKey ||
      row.size !== actual.size ||
      row.sha256 !== actual.sha256
    )
      throw failure(409, "Uploaded content does not match reservation");
    if (row.state === "uploaded" || row.state === "ready") return row;
    if (row.state !== "receiving")
      throw failure(409, "Upload is not receiving");
    if (!row.receivingUntil || row.receivingUntil <= new Date())
      throw failure(409, "Upload receiving lease expired");
    if (
      actual.deadline &&
      (!Number.isFinite(actual.deadline.getTime()) ||
        actual.deadline <= new Date())
    )
      throw failure(409, "Upload request deadline expired");
    const [updated] = await tx
      .update(uploads)
      .set({ state: "uploaded", receivingUntil: null, updatedAt: new Date() })
      .where(eq(uploads.id, id))
      .returning();
    return updated!;
  });
}
export async function finalize(
  actorId: string,
  projectId: string,
  taskId: string,
  binding: string,
  id: string,
) {
  return withTask(actorId, projectId, taskId, true, async (tx) => {
    const row = requireTicket(
      await findUpload(tx, projectId, taskId, id),
      actorId,
      binding,
    );
    if (row.state === "ready") return attachmentDTO(row);
    if (row.state !== "uploaded") throw failure(409, "Upload is incomplete");
    await tx
      .update(uploads)
      .set({ state: "ready", updatedAt: new Date() })
      .where(eq(uploads.id, id));
    const result = attachmentDTO(row);
    await recordTaskActivity(
      tx,
      actorId,
      taskId,
      "doska.task.attachment.created",
      null,
      result,
    );
    return result;
  });
}
export async function listReady(
  actorId: string,
  projectId: string,
  taskId: string,
  pagination: { limit?: number; offset?: number } = {},
) {
  const { limit = 100, offset = 0 } = pagination;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 10_000_000
  )
    throw failure(400, "Invalid attachment pagination");
  return withTask(actorId, projectId, taskId, false, async (tx) =>
    (
      await tx
        .select()
        .from(uploads)
        .where(
          and(
            eq(uploads.taskId, taskId),
            eq(uploads.projectId, projectId),
            eq(uploads.state, "ready"),
          ),
        )
        .orderBy(asc(uploads.createdAt), asc(uploads.id))
        .limit(limit)
        .offset(offset)
    ).map(attachmentDTO),
  );
}
export async function inspectReady(
  actorId: string,
  projectId: string,
  taskId: string,
  id: string,
) {
  return withTask(actorId, projectId, taskId, false, async (tx) => {
    const row = await findUpload(tx, projectId, taskId, id);
    if (!row || row.state !== "ready")
      throw failure(404, "Attachment not found");
    return row;
  });
}
export async function requestDelete(
  actorId: string,
  projectId: string,
  taskId: string,
  id: string,
  binding?: string,
) {
  return withTask(actorId, projectId, taskId, true, async (tx) => {
    const row = await findUpload(tx, projectId, taskId, id);
    if (!row || row.state === "deleting") return;
    if (
      row.state !== "ready" &&
      (row.actorId !== actorId || row.sessionBinding !== binding)
    )
      throw failure(404, "Upload not found");
    await tx
      .update(uploads)
      .set({ state: "deleting", updatedAt: new Date() })
      .where(eq(uploads.id, id));
    if (row.state === "ready")
      await recordTaskActivity(
        tx,
        actorId,
        taskId,
        "doska.task.attachment.deleted",
        attachmentDTO(row),
        null,
      );
  });
}
