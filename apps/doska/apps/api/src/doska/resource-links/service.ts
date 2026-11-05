import { and, asc, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  doskaResourceLinkTable as links,
  doskaResourceLinkStateTable as states,
  taskTable,
} from "../../database/schema";
import {
  authorizeTaskProject,
  lockTaskContext,
  recordTaskActivity,
  type Transaction,
} from "../tasks/transaction";
import { createTaskInTransaction } from "../tasks/service";
import { taskInput } from "../tasks/schema";
import {
  attachBody,
  createBody,
  mutationBody,
  type ResourceRef,
} from "./schema";
import { readReceipt, requestDigest, saveReceipt } from "./receipts";
import type { z } from "../../openapi";
export const taskHref = (projectId: string, taskId: string) =>
  `/doska/projects/${encodeURIComponent(projectId)}?taskId=${encodeURIComponent(taskId)}`;
async function currentRevision(tx: Transaction, taskId: string) {
  const [row] = await tx.select().from(states).where(eq(states.taskId, taskId));
  return row?.revision ?? 0;
}
async function advance(tx: Transaction, taskId: string) {
  const [row] = await tx
    .insert(states)
    .values({ taskId, revision: 1 })
    .onConflictDoUpdate({
      target: states.taskId,
      set: { revision: sql`${states.revision}+1` },
    })
    .returning();
  if (!row || !Number.isSafeInteger(row.revision))
    throw new Error("Resource link revision exhausted");
  return row.revision;
}
function sameRef(taskId: string, ref: ResourceRef) {
  return and(
    eq(links.taskId, taskId),
    eq(links.source, ref.source),
    eq(links.objectType, ref.type),
    eq(links.objectId, ref.id),
  );
}
async function insertLink(
  tx: Transaction,
  actorId: string,
  taskId: string,
  ref: ResourceRef,
) {
  const [link] = await tx
    .insert(links)
    .values({
      taskId,
      source: ref.source,
      objectType: ref.type,
      objectId: ref.id,
    })
    .returning();
  if (!link) throw new Error("Resource link insert failed");
  const revision = await advance(tx, taskId);
  await recordTaskActivity(
    tx,
    actorId,
    taskId,
    "doska.task.resource.attached",
    null,
    { linkId: link.id },
  );
  return { version: 1 as const, revision, linkId: link.id };
}
export async function resourceCapabilities(actorId: string, projectId: string) {
  return db.transaction(async (tx) => {
    const { project } = await lockTaskContext(
      tx,
      actorId,
      projectId,
      undefined,
      "readContent",
    );
    const access = await authorizeTaskProject(
      tx,
      actorId,
      projectId,
      "readContent",
    );
    return {
      version: 1 as const,
      readContent: true,
      workOnTasks: access.workOnTasks && !project.archivedAt,
    };
  });
}
export async function listResourceLinks(
  actorId: string,
  projectId: string,
  taskId: string,
) {
  return db.transaction(async (tx) => {
    await lockTaskContext(tx, actorId, projectId, taskId, "readContent");
    const rows = await tx
      .select()
      .from(links)
      .where(eq(links.taskId, taskId))
      .orderBy(asc(links.id))
      .limit(32);
    const revision = await currentRevision(tx, taskId);
    await authorizeTaskProject(tx, actorId, projectId, "readContent");
    return {
      version: 1 as const,
      revision,
      links: rows.map((row) => ({
        linkId: row.id,
        ref: {
          version: 1 as const,
          source: row.source,
          type: row.objectType,
          id: row.objectId,
        } as ResourceRef,
      })),
    };
  });
}
export async function attachResource(
  actorId: string,
  projectId: string,
  taskId: string,
  raw: z.infer<typeof attachBody>,
) {
  const input = attachBody.parse(raw);
  const digest = requestDigest({ operation: "attach", taskId, input });
  return db.transaction(async (tx) => {
    const { task } = await lockTaskContext(tx, actorId, projectId, taskId);
    if (task?.archivedAt)
      throw new HTTPException(409, { message: "Task is archived" });
    const previous = await readReceipt(
      tx,
      actorId,
      projectId,
      input.clientRequestId,
      digest,
    );
    if (previous) {
      await authorizeTaskProject(tx, actorId, projectId);
      return previous;
    }
    const revision = await currentRevision(tx, taskId);
    if (revision !== input.expectedRevision)
      throw new HTTPException(409, { message: "revision_conflict" });
    const [existing] = await tx
      .select()
      .from(links)
      .where(sameRef(taskId, input.ref));
    let result = existing
      ? { version: 1 as const, revision, linkId: existing.id }
      : undefined;
    if (!result) {
      const [count] = await tx
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(links)
        .where(eq(links.taskId, taskId));
      if ((count?.count ?? 0) >= 32)
        throw new HTTPException(400, {
          message: "Resource link limit reached",
        });
      result = await insertLink(tx, actorId, taskId, input.ref);
    }
    await authorizeTaskProject(tx, actorId, projectId);
    return saveReceipt(
      tx,
      actorId,
      projectId,
      input.clientRequestId,
      digest,
      result,
    );
  });
}
export async function detachResource(
  actorId: string,
  projectId: string,
  taskId: string,
  linkId: string,
  raw: z.infer<typeof mutationBody>,
) {
  const input = mutationBody.parse(raw);
  const digest = requestDigest({ operation: "detach", taskId, linkId, input });
  return db.transaction(async (tx) => {
    const { task } = await lockTaskContext(tx, actorId, projectId, taskId);
    if (task?.archivedAt)
      throw new HTTPException(409, { message: "Task is archived" });
    const previous = await readReceipt(
      tx,
      actorId,
      projectId,
      input.clientRequestId,
      digest,
    );
    if (previous) {
      await authorizeTaskProject(tx, actorId, projectId);
      return previous;
    }
    if ((await currentRevision(tx, taskId)) !== input.expectedRevision)
      throw new HTTPException(409, { message: "revision_conflict" });
    const [link] = await tx
      .delete(links)
      .where(and(eq(links.id, linkId), eq(links.taskId, taskId)))
      .returning();
    if (!link) throw new HTTPException(404, { message: "Link not found" });
    const revision = await advance(tx, taskId);
    await recordTaskActivity(
      tx,
      actorId,
      taskId,
      "doska.task.resource.detached",
      { linkId },
      null,
    );
    await authorizeTaskProject(tx, actorId, projectId);
    return saveReceipt(tx, actorId, projectId, input.clientRequestId, digest, {
      version: 1,
      revision,
      linkId,
    });
  });
}
export async function createTaskFromResource(
  actorId: string,
  projectId: string,
  raw: z.infer<typeof createBody>,
) {
  const input = createBody.parse(raw);
  const digest = requestDigest({ operation: "create", input });
  return db.transaction(async (tx) => {
    await lockTaskContext(tx, actorId, projectId);
    const previous = await readReceipt(
      tx,
      actorId,
      projectId,
      input.clientRequestId,
      digest,
    );
    if (previous) {
      const [task] = await tx
        .select({ id: taskTable.id })
        .from(taskTable)
        .where(
          and(
            eq(taskTable.id, previous.taskId!),
            eq(taskTable.projectId, projectId),
          ),
        );
      if (!task) throw new HTTPException(404, { message: "Task not found" });
      await authorizeTaskProject(tx, actorId, projectId);
      return previous;
    }
    const task = await createTaskInTransaction(
      tx,
      actorId,
      projectId,
      taskInput(input.task),
    );
    const result = await insertLink(tx, actorId, task.id, input.ref);
    await authorizeTaskProject(tx, actorId, projectId);
    return saveReceipt(tx, actorId, projectId, input.clientRequestId, digest, {
      ...result,
      taskId: task.id,
      projectId,
      href: taskHref(projectId, task.id),
    });
  });
}
