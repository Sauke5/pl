import { publishLiveChanges } from "../live/publisher";
import { and, eq, gt, lte, or, desc } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  doskaTemplateTable,
  doskaTemplateSnapshotTable,
  doskaTemplateAuditTable,
  platformDepartmentTable,
  platformUserIdentityTable,
  columnTable,
  taskTable,
  checklistTable,
  checklistItemTable,
  taskRelationTable,
  projectTable,
  customFieldDefinitionTable,
  customFieldValueTable,
  labelTable,
} from "../../database/schema";
import {
  lockDirectory,
  requireFreshIdentity,
  type Transaction,
} from "../projects/transaction";
import {
  createProjectInTransaction,
  DOSKA_WORKSPACE_ID,
  creationContext,
  type CreateProjectInput,
} from "../projects/service";
import { recordTaskActivity } from "../tasks/transaction";
import { captureTemplateSource } from "./source";
import { templateCapabilities, type TemplateVisibility } from "./policy";
import { materializeTemplate } from "./materialize";
import { TemplateSnapshotError } from "./snapshot";
import {
  templateSnapshotSchema,
  saveTemplateBody,
  createFromTemplateBody,
} from "./schema";

type Template = typeof doskaTemplateTable.$inferSelect;
async function actor(tx: Transaction, userId: string) {
  const identity = await requireFreshIdentity(tx, userId),
    now = new Date();
  const [department] = identity.departmentId
    ? await tx
        .select({ id: platformDepartmentTable.id })
        .from(platformDepartmentTable)
        .where(
          and(
            eq(platformDepartmentTable.id, identity.departmentId),
            eq(platformDepartmentTable.active, true),
            lte(platformDepartmentTable.observedAt, now),
            gt(platformDepartmentTable.validUntil, now),
          ),
        )
    : [];
  return {
    userId,
    active: true,
    primaryDepartmentId: department?.id ?? null,
    departmentHeadIds: [],
  };
}
async function authorize(
  tx: Transaction,
  userId: string,
  template: Template | undefined,
  manage = false,
) {
  const person = await actor(tx, userId);
  if (!template || !templateCapabilities(person, template).read)
    throw new HTTPException(404, { message: "Template not found" });
  if (manage && !templateCapabilities(person, template).manage)
    throw new HTTPException(403, {
      message: "Only the template owner can change it",
    });
  return person;
}
async function audit(
  tx: Transaction,
  userId: string,
  templateId: string,
  operation: string,
  payload: Record<string, unknown>,
) {
  await tx
    .insert(doskaTemplateAuditTable)
    .values({ templateId, actorUserId: userId, operation, payload });
}
function summary(template: Template) {
  return {
    id: template.id,
    name: template.name,
    visibility: template.visibility,
    revision: template.revision,
    snapshotVersion: template.snapshotVersion,
  };
}
export type SaveTemplateInput = {
  sourceProjectId: string;
  fingerprint: string;
  name: string;
  visibility: TemplateVisibility;
  templateId?: string;
  expectedRevision?: number;
};
export async function saveTemplate(
  userId: string,
  rawInput: SaveTemplateInput,
) {
  const input = saveTemplateBody.parse(rawInput);
  return db.transaction(async (tx) => {
    const captured = await captureTemplateSource(
      tx,
      userId,
      input.sourceProjectId,
    );
    if (captured.fingerprint !== input.fingerprint)
      throw new HTTPException(409, {
        message: "Template source changed; preview again",
      });
    let template: Template | undefined;
    let previousAudience: Template | undefined;
    if (input.templateId) {
      const [before] = await tx
        .select()
        .from(doskaTemplateTable)
        .where(eq(doskaTemplateTable.id, input.templateId))
        .for("update");
      await authorize(tx, userId, before, true);
      previousAudience = before;
      if (before!.revision !== input.expectedRevision)
        throw new HTTPException(409, { message: "Template revision conflict" });
      [template] = await tx
        .update(doskaTemplateTable)
        .set({
          name: input.name,
          visibility: input.visibility,
          sourceProjectId: input.sourceProjectId,
          departmentId: captured.departmentId,
          revision: before!.revision + 1,
          snapshotVersion: before!.snapshotVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(doskaTemplateTable.id, before!.id))
        .returning();
    } else {
      [template] = await tx
        .insert(doskaTemplateTable)
        .values({
          ownerUserId: userId,
          departmentId: captured.departmentId,
          sourceProjectId: input.sourceProjectId,
          name: input.name,
          visibility: input.visibility,
        })
        .returning();
    }
    if (!template) throw new Error("Template write failed");
    await tx.insert(doskaTemplateSnapshotTable).values({
      templateId: template!.id,
      version: template!.snapshotVersion,
      payload: templateSnapshotSchema.parse(captured.snapshot),
      fingerprint: captured.fingerprint,
      createdBy: userId,
    });
    await audit(
      tx,
      userId,
      template!.id,
      input.templateId ? "template.updated" : "template.created",
      {
        revision: template!.revision,
        snapshotVersion: template!.snapshotVersion,
        visibility: template!.visibility,
        taskCount: captured.snapshot.tasks.length,
      },
    );
    const audiences = [previousAudience, template].filter(
      (value): value is Template => Boolean(value),
    );
    const company = audiences.some((value) => value.visibility === "company");
    const departments = audiences
      .filter((value) => value.visibility === "department")
      .map((value) => value.departmentId);
    const recipients =
      company || departments.length
        ? await tx
            .select({ userId: platformUserIdentityTable.userId })
            .from(platformUserIdentityTable)
            .where(
              and(
                eq(platformUserIdentityTable.active, true),
                ...(company
                  ? []
                  : [
                      or(
                        ...departments.map((id) =>
                          eq(platformUserIdentityTable.primaryDepartmentId, id),
                        ),
                      ),
                    ]),
              ),
            )
        : [];
    await publishLiveChanges(tx, [
      {
        kind: "personal",
        userIds: [userId, ...recipients.map((row) => row.userId)],
        scopes: ["templates"],
      },
    ]);
    await authorize(tx, userId, template!, true);
    return summary(template!);
  });
}
export async function readTemplate(userId: string, id: string) {
  return db.transaction(async (tx) => {
    await lockDirectory(tx);
    const [template] = await tx
      .select()
      .from(doskaTemplateTable)
      .where(eq(doskaTemplateTable.id, id))
      .for("share");
    const person = await authorize(tx, userId, template);
    const [version] = await tx
      .select()
      .from(doskaTemplateSnapshotTable)
      .where(
        and(
          eq(doskaTemplateSnapshotTable.templateId, id),
          eq(doskaTemplateSnapshotTable.version, template!.snapshotVersion),
        ),
      );
    if (!version) throw new Error("Template snapshot missing");
    await authorize(tx, userId, template);
    return {
      ...summary(template!),
      snapshot: templateSnapshotSchema.parse(version.payload),
      canManage: templateCapabilities(person, template!).manage,
    };
  });
}
export async function createProjectFromTemplate(
  userId: string,
  id: string,
  rawInput: {
    expectedRevision: number;
    includeTasks: boolean;
    project: CreateProjectInput;
  },
) {
  const input = createFromTemplateBody.parse(rawInput);
  return db.transaction(async (tx) => {
    await lockDirectory(tx);
    const [template] = await tx
      .select()
      .from(doskaTemplateTable)
      .where(eq(doskaTemplateTable.id, id))
      .for("share");
    await authorize(tx, userId, template);
    if (template!.revision !== input.expectedRevision)
      throw new HTTPException(409, { message: "Template revision conflict" });
    const [version] = await tx
      .select()
      .from(doskaTemplateSnapshotTable)
      .where(
        and(
          eq(doskaTemplateSnapshotTable.templateId, id),
          eq(doskaTemplateSnapshotTable.version, template!.snapshotVersion),
        ),
      );
    if (!version) throw new Error("Template snapshot missing");
    const project = await createProjectInTransaction(
      tx,
      userId,
      input.project,
      { initializeColumns: false },
    );
    const snapshot = templateSnapshotSchema.parse(version.payload);
    let rows;
    try {
      rows = materializeTemplate(snapshot, project.id, input.includeTasks);
    } catch (error) {
      if (error instanceof TemplateSnapshotError)
        throw new HTTPException(400, { message: error.message });
      throw error;
    }
    if (rows.columns.length) await tx.insert(columnTable).values(rows.columns);
    if (rows.tasks.length) await tx.insert(taskTable).values(rows.tasks);
    if (rows.customFields.length)
      await tx.insert(customFieldDefinitionTable).values(rows.customFields);
    if (rows.customValues.length)
      await tx.insert(customFieldValueTable).values(rows.customValues);
    if (rows.labels.length)
      await tx.insert(labelTable).values(
        rows.labels.map((label) => ({
          ...label,
          workspaceId: DOSKA_WORKSPACE_ID,
        })),
      );
    if (rows.checklists.length)
      await tx.insert(checklistTable).values(rows.checklists);
    if (rows.items.length)
      await tx.insert(checklistItemTable).values(rows.items);
    if (rows.relations.length)
      await tx.insert(taskRelationTable).values(rows.relations);
    await tx
      .update(projectTable)
      .set({
        lastTaskNumber: rows.lastTaskNumber,
        requiredTaskFields: snapshot.requiredTaskFields,
      })
      .where(eq(projectTable.id, project.id));
    for (const task of rows.tasks)
      await recordTaskActivity(
        tx,
        userId,
        task.id!,
        "doska.task.created",
        null,
        {
          title: task.title,
          columnId: task.columnId,
          templateId: id,
          templateVersion: version.version,
        },
        false,
      );
    await publishLiveChanges(tx, [
      {
        kind: "project",
        projectId: project.id,
        scopes: [
          "tasks",
          "columns",
          "checklists",
          "subtasks",
          "relations",
          "fields",
          "labels",
          "project",
        ],
      },
    ]);
    await audit(tx, userId, id, "template.used", {
      projectId: project.id,
      snapshotVersion: version.version,
      includeTasks: input.includeTasks,
    });
    await authorize(tx, userId, template);
    const context = await creationContext(tx, userId);
    if (!context.canCreateProject)
      throw new HTTPException(403, {
        message: "Current department is required",
      });
    return project;
  });
}

export async function listTemplates(userId: string, page = 1) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000)
    throw new HTTPException(400, { message: "Invalid page" });
  return db.transaction(async (tx) => {
    await lockDirectory(tx);
    const person = await actor(tx, userId);
    const condition = or(
      eq(doskaTemplateTable.ownerUserId, userId),
      eq(doskaTemplateTable.visibility, "company"),
      person.primaryDepartmentId
        ? and(
            eq(doskaTemplateTable.visibility, "department"),
            eq(doskaTemplateTable.departmentId, person.primaryDepartmentId),
          )
        : undefined,
    );
    const rows = await tx
      .select()
      .from(doskaTemplateTable)
      .where(condition)
      .orderBy(desc(doskaTemplateTable.updatedAt), desc(doskaTemplateTable.id))
      .limit(51)
      .offset((page - 1) * 50)
      .for("share");
    const latest = await actor(tx, userId);
    if (latest.primaryDepartmentId !== person.primaryDepartmentId)
      throw new HTTPException(409, {
        message: "Department changed; reload templates",
      });
    return {
      items: rows.slice(0, 50).map((template) => ({
        ...summary(template),
        canManage: templateCapabilities(latest, template).manage,
      })),
      hasMore: rows.length > 50,
    };
  });
}
