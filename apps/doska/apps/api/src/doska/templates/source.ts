import { publishLiveChanges } from "../live/publisher";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  columnTable,
  taskTable,
  checklistTable,
  checklistItemTable,
  taskRelationTable,
  doskaTemplateSelectionTable,
  projectAuditTable,
  customFieldDefinitionTable,
  customFieldValueTable,
  labelTable,
} from "../../database/schema";
import { getProjectCapabilities } from "../project-access";
import {
  lockDirectory,
  lockProject,
  type Transaction,
} from "../projects/transaction";
import { buildTemplateSnapshot, TemplateSnapshotError } from "./snapshot";
import { buildTemplateMetadata } from "./snapshot-metadata";
import { templateSelectionBody, templateSnapshotSchema } from "./schema";

export async function lockTemplateSource(
  tx: Transaction,
  userId: string,
  projectId: string,
) {
  await lockDirectory(tx);
  const project = await lockProject(tx, projectId);
  const caps = await getProjectCapabilities(userId, projectId, {
    database: tx,
  });
  if (!caps.readContent)
    throw new HTTPException(404, { message: "Project not found" });
  if (!caps.manageSettings)
    throw new HTTPException(403, {
      message: "Only the project owner can save templates",
    });
  if (project.archivedAt)
    throw new HTTPException(409, { message: "Project is archived" });
  return project;
}
export async function setTemplateSelection(
  userId: string,
  projectId: string,
  taskId: string,
  rawInput: { expectedRevision: number; selected: boolean },
) {
  const input = templateSelectionBody.parse(rawInput);
  return db.transaction(async (tx) => {
    await lockTemplateSource(tx, userId, projectId);
    const [task] = await tx
      .select({ id: taskTable.id, archivedAt: taskTable.archivedAt })
      .from(taskTable)
      .where(and(eq(taskTable.id, taskId), eq(taskTable.projectId, projectId)));
    if (!task) throw new HTTPException(404, { message: "Task not found" });
    if (task.archivedAt && input.selected)
      throw new HTTPException(409, { message: "Task is archived" });
    const [before] = await tx
      .select()
      .from(doskaTemplateSelectionTable)
      .where(eq(doskaTemplateSelectionTable.taskId, taskId));
    if ((before?.revision ?? 0) !== input.expectedRevision)
      throw new HTTPException(409, {
        message: "Template selection revision conflict",
      });
    if ((before?.selected ?? false) === input.selected)
      return { selected: input.selected, revision: before?.revision ?? 0 };
    const revision = input.expectedRevision + 1;
    await tx
      .insert(doskaTemplateSelectionTable)
      .values({ taskId, projectId, selected: input.selected, revision })
      .onConflictDoUpdate({
        target: doskaTemplateSelectionTable.taskId,
        set: { selected: input.selected, revision },
      });
    await tx.insert(projectAuditTable).values({
      projectId,
      actorUserId: userId,
      operation: "template.selection",
      payload: { taskId, selected: input.selected, revision },
    });
    await lockTemplateSource(tx, userId, projectId);
    await publishLiveChanges(tx, [
      { kind: "personal", userIds: [userId], scopes: ["template-selection"] },
    ]);
    return { selected: input.selected, revision };
  });
}
export async function captureTemplateSource(
  tx: Transaction,
  userId: string,
  projectId: string,
) {
  const project = await lockTemplateSource(tx, userId, projectId);
  const columns = await tx
    .select()
    .from(columnTable)
    .where(eq(columnTable.projectId, projectId))
    .orderBy(asc(columnTable.position), asc(columnTable.id));
  const allTasks = await tx
    .select()
    .from(taskTable)
    .where(eq(taskTable.projectId, projectId))
    .limit(1001);
  if (allTasks.length > 1000 || columns.length > 100)
    throw new HTTPException(400, { message: "Template source exceeds limits" });
  const selections = await tx
    .select()
    .from(doskaTemplateSelectionTable)
    .where(
      and(
        eq(doskaTemplateSelectionTable.projectId, projectId),
        eq(doskaTemplateSelectionTable.selected, true),
      ),
    )
    .orderBy(asc(doskaTemplateSelectionTable.taskId));
  const taskIds = allTasks.map((task) => task.id);
  const checklists = taskIds.length
    ? await tx
        .select()
        .from(checklistTable)
        .where(inArray(checklistTable.taskId, taskIds))
    : [];
  const items = checklists.length
    ? await tx
        .select()
        .from(checklistItemTable)
        .where(
          inArray(
            checklistItemTable.checklistId,
            checklists.map((list) => list.id),
          ),
        )
    : [];
  const relations = taskIds.length
    ? await tx
        .select()
        .from(taskRelationTable)
        .where(
          or(
            inArray(taskRelationTable.sourceTaskId, taskIds),
            inArray(taskRelationTable.targetTaskId, taskIds),
          ),
        )
    : [];
  let result: ReturnType<typeof buildTemplateSnapshot>;
  try {
    result = buildTemplateSnapshot({
      projectId,
      columns,
      allTasks,
      selectedTaskIds: selections.map((row) => row.taskId),
      checklists,
      checklistItems: items,
      relations,
    });
    const selectedIds = [...result.expandedTaskIds];
    const fields = await tx
      .select()
      .from(customFieldDefinitionTable)
      .where(eq(customFieldDefinitionTable.projectId, projectId));
    const values = selectedIds.length
      ? await tx
          .select()
          .from(customFieldValueTable)
          .where(inArray(customFieldValueTable.taskId, selectedIds))
      : [];
    const labels = selectedIds.length
      ? await tx
          .select()
          .from(labelTable)
          .where(inArray(labelTable.taskId, selectedIds))
      : [];
    const metadata = buildTemplateMetadata({
      projectId,
      fields,
      values,
      labels,
      taskKeys: new Map(
        selectedIds.map((id, index) => [id, result.snapshot.tasks[index]!.key]),
      ),
    });
    result = {
      ...result,
      snapshot: Object.freeze({
        ...result.snapshot,
        customFields: metadata.customFields,
        requiredTaskFields: Object.freeze(
          templateSnapshotSchema.shape.requiredTaskFields.parse(
            project.requiredTaskFields ?? [],
          ),
        ),
        tasks: Object.freeze(
          result.snapshot.tasks.map((task) =>
            Object.freeze({ ...task, ...metadata.taskMetadata[task.key] }),
          ),
        ),
      }),
    };
  } catch (error) {
    if (error instanceof TemplateSnapshotError)
      throw new HTTPException(409, { message: error.message });
    throw error;
  }
  if (Buffer.byteLength(JSON.stringify(result.snapshot)) > 1_048_576)
    throw new HTTPException(400, {
      message: "Template snapshot exceeds 1 MiB",
    });
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        projectId,
        projectRevision: project.revision,
        selections,
        snapshot: result.snapshot,
      }),
    )
    .digest("hex");
  await lockTemplateSource(tx, userId, projectId);
  return { ...result, fingerprint, departmentId: project.departmentId! };
}
export async function previewTemplate(userId: string, projectId: string) {
  return db.transaction(async (tx) => {
    const { snapshot, fingerprint, expandedTaskIds } =
      await captureTemplateSource(tx, userId, projectId);
    return { snapshot, fingerprint, expandedTaskIds };
  });
}

export async function getTemplateSelection(userId: string, projectId: string) {
  return db.transaction(async (tx) => {
    await lockTemplateSource(tx, userId, projectId);
    const rows = await tx
      .select({
        taskId: doskaTemplateSelectionTable.taskId,
        selected: doskaTemplateSelectionTable.selected,
        revision: doskaTemplateSelectionTable.revision,
      })
      .from(doskaTemplateSelectionTable)
      .where(eq(doskaTemplateSelectionTable.projectId, projectId));
    await lockTemplateSource(tx, userId, projectId);
    return rows;
  });
}
