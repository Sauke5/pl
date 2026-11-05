import { publishLiveChanges } from "../live/publisher";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  activityTable,
  projectTable,
  taskRelationTable,
  taskTable,
} from "../../database/schema";
import { getProjectCapabilities } from "../project-access";
import { lockDirectory, type Transaction } from "../projects/transaction";
import { readProjectCondition } from "../read-project-condition";
import {
  authorizeTaskProject,
  lockTaskContext,
  type Task,
} from "./transaction";

export type RelationType = "related" | "blocks" | "duplicate";
export type TaskRelationDTO = {
  id: string;
  type: RelationType;
  direction: "outgoing" | "incoming" | "symmetric";
  task: { id: string; projectId: string; title: string; number: number | null };
};
type Relation = typeof taskRelationTable.$inferSelect;
const types = ["doska.related", "doska.blocks", "doska.duplicate"];
function dto(
  relation: Relation,
  sourceId: string,
  other: Task,
): TaskRelationDTO {
  return {
    id: relation.id,
    type: relation.relationType.slice(6) as RelationType,
    direction:
      relation.relationType !== "doska.blocks"
        ? "symmetric"
        : relation.sourceTaskId === sourceId
          ? "outgoing"
          : "incoming",
    task: {
      id: other.id,
      projectId: other.projectId,
      title: other.title,
      number: other.number,
    },
  };
}
async function authorizeTarget(
  tx: Transaction,
  actorId: string,
  projectId: string,
) {
  const access = await getProjectCapabilities(actorId, projectId, {
    database: tx,
  });
  if (!access.workOnTasks)
    throw new HTTPException(404, { message: "Target task not found" });
}
async function lockPair(
  tx: Transaction,
  actorId: string,
  projectId: string,
  taskId: string,
  targetId: string,
  revision: number,
) {
  await lockDirectory(tx);
  const [candidate] = await tx
    .select()
    .from(taskTable)
    .where(eq(taskTable.id, targetId));
  if (!candidate)
    throw new HTTPException(404, { message: "Target task not found" });
  const projects = await tx
    .select()
    .from(projectTable)
    .where(
      inArray(projectTable.id, [...new Set([projectId, candidate.projectId])]),
    )
    .orderBy(asc(projectTable.id))
    .for("update");
  await authorizeTaskProject(tx, actorId, projectId);
  await authorizeTarget(tx, actorId, candidate.projectId);
  const tasks = await tx
    .select()
    .from(taskTable)
    .where(inArray(taskTable.id, [taskId, targetId]))
    .orderBy(asc(taskTable.id))
    .for("update");
  const source = tasks.find(
    (task) => task.id === taskId && task.projectId === projectId,
  );
  const target = tasks.find(
    (task) => task.id === targetId && task.projectId === candidate.projectId,
  );
  if (!source || !target)
    throw new HTTPException(404, { message: "Task not found" });
  if (
    source.archivedAt ||
    target.archivedAt ||
    projects.some((project) => project.archivedAt)
  )
    throw new HTTPException(409, { message: "Task or project is archived" });
  if (source.revision !== revision)
    throw new HTTPException(409, { message: "Task revision conflict" });
  return { source, target };
}
async function changed(
  tx: Transaction,
  actorId: string,
  source: Task,
  target: Task,
  relation: Relation,
  operation: "created" | "deleted",
) {
  for (const [task, other] of [
    [source, target],
    [target, source],
  ] as const) {
    await tx
      .update(taskTable)
      .set({ revision: task.revision + 1 })
      .where(eq(taskTable.id, task.id));
    await tx.insert(activityTable).values({
      taskId: task.id,
      userId: actorId,
      type: `doska.task.relation.${operation}`,
      eventData: {
        relationId: relation.id,
        relationType: relation.relationType.slice(6),
        otherTaskId: other.id,
        direction: dto(relation, task.id, other).direction,
      },
    });
  }
  await publishLiveChanges(
    tx,
    [source, target].map((task) => ({
      kind: "project" as const,
      projectId: task.projectId,
      taskIds: [task.id],
      scopes: ["tasks", "relations", "history"],
    })),
  );
  await authorizeTaskProject(tx, actorId, source.projectId);
  await authorizeTarget(tx, actorId, target.projectId);
}
export async function createTaskRelation(
  actorId: string,
  projectId: string,
  taskId: string,
  input: { expectedRevision: number; targetTaskId: string; type: RelationType },
): Promise<TaskRelationDTO> {
  if (taskId === input.targetTaskId)
    throw new HTTPException(400, { message: "A task cannot relate to itself" });
  if (!types.includes(`doska.${input.type}`))
    throw new HTTPException(400, { message: "Invalid relation type" });
  return db.transaction(async (tx) => {
    const { source, target } = await lockPair(
      tx,
      actorId,
      projectId,
      taskId,
      input.targetTaskId,
      input.expectedRevision,
    );
    const [sourceId, targetId] =
      input.type === "blocks"
        ? [source.id, target.id]
        : [source.id, target.id].sort();
    const relationType = `doska.${input.type}`;
    const [existing] = await tx
      .select()
      .from(taskRelationTable)
      .where(
        and(
          eq(taskRelationTable.sourceTaskId, sourceId!),
          eq(taskRelationTable.targetTaskId, targetId!),
          eq(taskRelationTable.relationType, relationType),
        ),
      );
    if (existing)
      throw new HTTPException(409, { message: "Relation already exists" });
    const [relation] = await tx
      .insert(taskRelationTable)
      .values({
        sourceTaskId: sourceId!,
        targetTaskId: targetId!,
        relationType,
      })
      .returning();
    await changed(tx, actorId, source, target, relation!, "created");
    return dto(relation!, taskId, target);
  });
}
export async function deleteTaskRelation(
  actorId: string,
  projectId: string,
  taskId: string,
  relationId: string,
  input: { expectedRevision: number },
): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(taskRelationTable)
      .where(
        and(
          eq(taskRelationTable.id, relationId),
          inArray(taskRelationTable.relationType, types),
          or(
            eq(taskRelationTable.sourceTaskId, taskId),
            eq(taskRelationTable.targetTaskId, taskId),
          ),
        ),
      );
    if (!candidate)
      throw new HTTPException(404, { message: "Relation not found" });
    const targetId =
      candidate.sourceTaskId === taskId
        ? candidate.targetTaskId
        : candidate.sourceTaskId;
    const { source, target } = await lockPair(
      tx,
      actorId,
      projectId,
      taskId,
      targetId,
      input.expectedRevision,
    );
    const [relation] = await tx
      .delete(taskRelationTable)
      .where(eq(taskRelationTable.id, relationId))
      .returning();
    if (!relation)
      throw new HTTPException(404, { message: "Relation not found" });
    await changed(tx, actorId, source, target, relation, "deleted");
    return { id: relationId };
  });
}
export async function listTaskRelations(
  actorId: string,
  projectId: string,
  taskId: string,
  page: { limit: number; offset: number },
): Promise<TaskRelationDTO[]> {
  return db.transaction(async (tx) => {
    await lockTaskContext(tx, actorId, projectId, taskId, "readContent");
    if (
      !Number.isInteger(page.limit) ||
      page.limit < 1 ||
      page.limit > 100 ||
      !Number.isInteger(page.offset) ||
      page.offset < 0
    )
      throw new HTTPException(400, { message: "Invalid pagination" });
    const rows = await tx
      .select({ relation: taskRelationTable, other: taskTable })
      .from(taskRelationTable)
      .innerJoin(
        taskTable,
        eq(
          taskTable.id,
          sql`CASE WHEN ${taskRelationTable.sourceTaskId} = ${taskId} THEN ${taskRelationTable.targetTaskId} ELSE ${taskRelationTable.sourceTaskId} END`,
        ),
      )
      .where(
        and(
          or(
            eq(taskRelationTable.sourceTaskId, taskId),
            eq(taskRelationTable.targetTaskId, taskId),
          ),
          inArray(taskRelationTable.relationType, types),
          readProjectCondition(actorId, sql.raw('"task"."project_id"')),
        ),
      )
      .orderBy(asc(taskRelationTable.createdAt), asc(taskRelationTable.id))
      .limit(page.limit)
      .offset(page.offset);
    await authorizeTaskProject(tx, actorId, projectId, "readContent");
    if (!rows.length) return [];
    // Target leases can expire during the paged query, even with directory writes locked.
    const allowed = await tx
      .select({ id: taskTable.id })
      .from(taskTable)
      .where(
        and(
          readProjectCondition(actorId, projectId),
          inArray(
            taskTable.id,
            rows.map(({ other }) => other.id),
          ),
          readProjectCondition(actorId, sql.raw('"task"."project_id"')),
        ),
      );
    const allowedIds = new Set(allowed.map((task) => task.id));
    return rows
      .filter(({ other }) => allowedIds.has(other.id))
      .map(({ relation, other }) => dto(relation, taskId, other));
  });
}
