import { publishLiveChanges } from "../live/publisher";
import { createId } from "@paralleldrive/cuid2";
import { and, asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  columnTable,
  projectAuditTable,
  projectTable,
  taskTable,
} from "../../database/schema";
import { nextTaskPosition } from "../../task/controllers/next-task-position";
import { getProjectCapabilities } from "../project-access";
import { lockDirectory, type Transaction } from "../projects/transaction";
import { recordTaskActivity } from "../tasks/transaction";
import { assertCompletionAllowed } from "../tasks/hierarchy";

type Column = typeof columnTable.$inferSelect;
type ColumnFields = {
  name: string;
  semanticState: "planned" | "active" | "completed";
  color?: string | null;
  icon?: string | null;
};
export type CreateColumnInput = ColumnFields & { expectedRevision: number };
export type UpdateColumnInput = Partial<ColumnFields> & {
  expectedRevision: number;
  confirmIncompleteSubtasks?: boolean;
};
const invalid = () =>
  new HTTPException(400, { message: "Invalid column input" });
function validate(input: UpdateColumnInput) {
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  )
    throw invalid();
  if (
    input.name !== undefined &&
    (typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.trim().length > 100)
  )
    throw invalid();
  if (
    input.semanticState !== undefined &&
    !["planned", "active", "completed"].includes(input.semanticState)
  )
    throw invalid();
  for (const value of [input.color, input.icon])
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "string" || value.length > 100)
    )
      throw invalid();
  if (
    input.confirmIncompleteSubtasks !== undefined &&
    typeof input.confirmIncompleteSubtasks !== "boolean"
  )
    throw invalid();
}
async function authorize(
  tx: Transaction,
  actorId: string,
  projectId: string,
  mutation: boolean,
) {
  const caps = await getProjectCapabilities(actorId, projectId, {
    database: tx,
  });
  if (!caps.readContent && !caps.readManagementMetadata)
    throw new HTTPException(404, { message: "Project not found" });
  if (mutation ? !caps.manageSettings : !caps.readContent)
    throw new HTTPException(403, {
      message: "Column operation is not permitted",
    });
}
function columns(tx: Transaction, projectId: string) {
  return tx
    .select()
    .from(columnTable)
    .where(eq(columnTable.projectId, projectId))
    .orderBy(asc(columnTable.position), asc(columnTable.id));
}
export async function listColumns(actorId: string, projectId: string) {
  return db.transaction(async (tx) => {
    await lockDirectory(tx);
    await authorize(tx, actorId, projectId, false);
    const result = await columns(tx, projectId);
    await authorize(tx, actorId, projectId, false);
    return result;
  });
}
async function mutate(
  actorId: string,
  projectId: string,
  expectedRevision: number,
  operation: string,
  change: (tx: Transaction, before: Column[]) => Promise<boolean>,
) {
  validate({ expectedRevision });
  return db.transaction(async (tx) => {
    await lockDirectory(tx);
    const [project] = await tx
      .select()
      .from(projectTable)
      .where(eq(projectTable.id, projectId))
      .for("update");
    await authorize(tx, actorId, projectId, true);
    if (!project)
      throw new HTTPException(404, { message: "Project not found" });
    if (project.archivedAt)
      throw new HTTPException(409, { message: "Project is archived" });
    if (project.revision !== expectedRevision)
      throw new HTTPException(409, { message: "Project revision conflict" });
    const before = await columns(tx, projectId);
    const changed = await change(tx, before);
    const after = await columns(tx, projectId);
    const revision = project.revision + Number(changed);
    if (changed) {
      const [updated] = await tx
        .update(projectTable)
        .set({ revision })
        .where(
          and(
            eq(projectTable.id, projectId),
            eq(projectTable.revision, expectedRevision),
          ),
        )
        .returning({ id: projectTable.id });
      if (!updated)
        throw new HTTPException(409, { message: "Project revision conflict" });
      await publishLiveChanges(tx, [
        { kind: "project", projectId, scopes: ["columns", "tasks", "project"] },
      ]);
      await tx.insert(projectAuditTable).values({
        projectId,
        actorUserId: actorId,
        operation,
        payload: {
          before: { revision: project.revision, columns: before },
          after: { revision, columns: after },
        },
      });
    }
    await authorize(tx, actorId, projectId, true);
    return { revision, columns: after };
  });
}
function selected(columns: Column[], id: string) {
  const found = columns.find((column) => column.id === id);
  if (!found) throw new HTTPException(404, { message: "Column not found" });
  return found;
}
export async function createColumn(
  actorId: string,
  projectId: string,
  input: CreateColumnInput,
) {
  validate(input);
  if (input.name === undefined || input.semanticState === undefined)
    throw invalid();
  return mutate(
    actorId,
    projectId,
    input.expectedRevision,
    "column.created",
    async (tx, before) => {
      const id = createId();
      await tx.insert(columnTable).values({
        id,
        projectId,
        name: input.name.trim(),
        slug: `column-${id}`,
        semanticState: input.semanticState,
        isFinal: input.semanticState === "completed",
        color: input.color ?? null,
        icon: input.icon ?? null,
        position: before.length
          ? Math.max(...before.map((c) => c.position)) + 1
          : 0,
      });
      return true;
    },
  );
}
export async function updateColumn(
  actorId: string,
  projectId: string,
  columnId: string,
  input: UpdateColumnInput,
) {
  validate(input);
  return mutate(
    actorId,
    projectId,
    input.expectedRevision,
    "column.updated",
    async (tx, before) => {
      const current = selected(before, columnId);
      const patch: Partial<typeof columnTable.$inferInsert> = {};
      for (const key of ["name", "semanticState", "color", "icon"] as const)
        if (input[key] !== undefined)
          Object.assign(patch, { [key]: input[key] });
      if (patch.name !== undefined) patch.name = patch.name.trim();
      if (patch.semanticState !== undefined)
        patch.isFinal = patch.semanticState === "completed";
      if (
        !Object.entries(patch).some(
          ([key, value]) => current[key as keyof Column] !== value,
        )
      )
        return false;
      if (
        patch.semanticState !== undefined &&
        current.semanticState !== patch.semanticState
      ) {
        const tasks = await tx
          .select()
          .from(taskTable)
          .where(
            and(
              eq(taskTable.projectId, projectId),
              eq(taskTable.columnId, columnId),
            ),
          )
          .orderBy(asc(taskTable.id))
          .for("update");
        const completedTaskIds = new Set(tasks.map((task) => task.id));
        for (const task of tasks) {
          const incompleteIds = await assertCompletionAllowed(
            tx,
            task,
            { semanticState: patch.semanticState },
            input.confirmIncompleteSubtasks ?? false,
            completedTaskIds,
          );
          if (incompleteIds.length)
            await recordTaskActivity(
              tx,
              actorId,
              task.id,
              "doska.task.incomplete_subtasks_confirmed",
              null,
              { incompleteSubtaskIds: incompleteIds },
            );
        }
        for (const task of tasks) {
          await tx
            .update(taskTable)
            .set({ revision: task.revision + 1, updatedAt: new Date() })
            .where(eq(taskTable.id, task.id));
          await recordTaskActivity(
            tx,
            actorId,
            task.id,
            "doska.task.column_state_changed",
            { semanticState: current.semanticState },
            { semanticState: patch.semanticState },
          );
        }
      }
      await tx
        .update(columnTable)
        .set(patch)
        .where(eq(columnTable.id, columnId));
      return true;
    },
  );
}
export async function reorderColumns(
  actorId: string,
  projectId: string,
  input: { expectedRevision: number; columnIds: string[] },
) {
  return mutate(
    actorId,
    projectId,
    input.expectedRevision,
    "columns.reordered",
    async (tx, before) => {
      if (
        !Array.isArray(input.columnIds) ||
        input.columnIds.length !== before.length ||
        new Set(input.columnIds).size !== before.length ||
        input.columnIds.some((id) => !before.some((c) => c.id === id))
      )
        throw invalid();
      if (before.every((c, i) => c.id === input.columnIds[i])) return false;
      for (const [position, id] of input.columnIds.entries())
        await tx
          .update(columnTable)
          .set({ position })
          .where(eq(columnTable.id, id));
      return true;
    },
  );
}
export async function deleteColumn(
  actorId: string,
  projectId: string,
  columnId: string,
  input: {
    expectedRevision: number;
    destinationColumnId?: string;
    confirmIncompleteSubtasks?: boolean;
  },
) {
  validate(input);
  return mutate(
    actorId,
    projectId,
    input.expectedRevision,
    "column.deleted",
    async (tx, before) => {
      selected(before, columnId);
      if (before.length === 1)
        throw new HTTPException(409, {
          message: "Cannot delete the last column",
        });
      const destination =
        input.destinationColumnId === undefined
          ? undefined
          : before.find(
              (c) => c.id === input.destinationColumnId && c.id !== columnId,
            );
      if (input.destinationColumnId !== undefined && !destination)
        throw invalid();
      const tasks = await tx
        .select()
        .from(taskTable)
        .where(
          and(
            eq(taskTable.projectId, projectId),
            eq(taskTable.columnId, columnId),
          ),
        )
        .orderBy(
          asc(taskTable.position),
          asc(taskTable.createdAt),
          asc(taskTable.id),
        )
        .for("update");
      if (tasks.length && !destination)
        throw new HTTPException(409, {
          message: "Occupied column requires a destination",
        });
      if (destination) {
        const completedTaskIds = new Set(tasks.map((task) => task.id));
        for (const task of tasks) {
          const incompleteIds = await assertCompletionAllowed(
            tx,
            task,
            destination,
            input.confirmIncompleteSubtasks ?? false,
            completedTaskIds,
          );
          if (incompleteIds.length)
            await recordTaskActivity(
              tx,
              actorId,
              task.id,
              "doska.task.incomplete_subtasks_confirmed",
              null,
              { incompleteSubtaskIds: incompleteIds },
            );
        }
        for (const task of tasks) {
          const position = await nextTaskPosition(
            tx,
            projectId,
            destination.slug,
            destination.id,
          );
          const after = {
            columnId: destination.id,
            status: destination.slug,
            position,
            revision: task.revision + 1,
          };
          await tx
            .update(taskTable)
            .set(after)
            .where(eq(taskTable.id, task.id));
          await recordTaskActivity(
            tx,
            actorId,
            task.id,
            "doska.task.updated",
            {
              columnId: task.columnId,
              status: task.status,
              position: task.position,
              revision: task.revision,
            },
            after,
          );
        }
      }
      await tx.delete(columnTable).where(eq(columnTable.id, columnId));
      return true;
    },
  );
}
