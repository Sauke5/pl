import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { doskaTaskImportTable as receipts } from "../../database/schema";
import { ApiError } from "../../errors/api-error";
import { requestDigest } from "../resource-links/receipts";
import { taskInput } from "../tasks/schema";
import { createTaskInTransaction } from "../tasks/service";
import { authorizeTaskProject, lockTaskContext } from "../tasks/transaction";
import { taskImportBody, type TaskImportInput } from "./schema";

export async function importTasks(
  actorId: string,
  projectId: string,
  raw: TaskImportInput,
) {
  const parsed = taskImportBody.safeParse(raw);
  if (!parsed.success)
    throw new ApiError(400, {
      code: "VALIDATION_ERROR",
      message: "Invalid task import",
    });
  const input = parsed.data;
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 3_145_728)
    throw new ApiError(413, {
      code: "PAYLOAD_TOO_LARGE",
      message: "Task import exceeds 3 MiB",
    });
  const digest = requestDigest(input.tasks);
  return db.transaction(async (tx) => {
    await lockTaskContext(tx, actorId, projectId);
    const actorProject = and(
      eq(receipts.actorId, actorId),
      eq(receipts.projectId, projectId),
    );
    const [attempt] = await tx
      .select()
      .from(receipts)
      .where(
        and(actorProject, eq(receipts.clientRequestId, input.clientRequestId)),
      );
    if (attempt && attempt.digest !== digest)
      throw new ApiError(409, {
        code: "IMPORT_REQUEST_CONFLICT",
        message: "Import request was already used for different tasks",
      });
    const [samePayload] = attempt
      ? []
      : await tx
          .select()
          .from(receipts)
          .where(and(actorProject, eq(receipts.digest, digest)))
          .limit(1);
    const previous = attempt ?? samePayload;
    if (previous) {
      // Retain an alias receipt too: this retry UUID cannot later import another payload.
      if (!attempt)
        await tx.insert(receipts).values({
          actorId,
          projectId,
          clientRequestId: input.clientRequestId,
          digest,
          taskIds: previous.taskIds,
        });
      await authorizeTaskProject(tx, actorId, projectId);
      return {
        taskIds: previous.taskIds,
        imported: previous.taskIds.length,
        replayed: true,
      };
    }
    const taskIds: string[] = [];
    for (const [index, task] of input.tasks.entries()) {
      try {
        const created = await createTaskInTransaction(
          tx,
          actorId,
          projectId,
          taskInput(task),
        );
        taskIds.push(created.id);
      } catch (error) {
        if (error instanceof HTTPException && error.status === 400)
          throw new ApiError(400, {
            code: "IMPORT_TASK_INVALID",
            message: "Import task is invalid",
            issues: [{ path: `body.tasks.${index}`, message: error.message }],
          });
        throw error;
      }
    }
    await authorizeTaskProject(tx, actorId, projectId);
    await tx.insert(receipts).values({
      actorId,
      projectId,
      clientRequestId: input.clientRequestId,
      digest,
      taskIds,
    });
    return { taskIds, imported: taskIds.length, replayed: false };
  });
}
