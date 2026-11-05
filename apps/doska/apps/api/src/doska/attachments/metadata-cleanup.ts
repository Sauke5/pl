import { and, asc, eq, isNull, lt, ne, or } from "drizzle-orm";
import db from "../../database";
import { doskaAttachmentUploadTable as uploads } from "../../database/schema";
/** Claim before unlink: finalize and receiving transitions can no longer publish a claimed row. */
export async function cleanupCandidates(limit = 100) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(uploads)
      .where(
        and(
          or(
            isNull(uploads.receivingUntil),
            lt(uploads.receivingUntil, new Date()),
          ),
          or(
            eq(uploads.state, "deleting"),
            isNull(uploads.taskId),
            isNull(uploads.projectId),
            and(ne(uploads.state, "ready"), lt(uploads.expiresAt, new Date())),
          ),
        ),
      )
      .orderBy(asc(uploads.updatedAt), asc(uploads.id))
      .limit(Math.max(1, Math.min(limit, 1000)))
      .for("update", { skipLocked: true });
    for (const row of rows)
      await tx
        .update(uploads)
        .set({ state: "deleting", updatedAt: new Date() })
        .where(eq(uploads.id, row.id));
    return rows.map((row) => ({ ...row, state: "deleting" as const }));
  });
}
/** Storage caller must first unlink the recorded object (ENOENT counts as removed). */
export async function markRemoved(id: string, objectKey: string | null) {
  await db
    .delete(uploads)
    .where(
      and(
        eq(uploads.id, id),
        eq(uploads.state, "deleting"),
        or(
          isNull(uploads.receivingUntil),
          lt(uploads.receivingUntil, new Date()),
        ),
        objectKey === null
          ? isNull(uploads.objectKey)
          : eq(uploads.objectKey, objectKey),
      ),
    );
}
