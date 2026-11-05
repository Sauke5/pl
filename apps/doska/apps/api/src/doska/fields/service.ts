import { publishLiveChanges } from "../live/publisher";
import { and, asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  customFieldDefinitionTable,
  projectAuditTable,
  projectTable,
} from "../../database/schema";
import { getProjectCapabilities } from "../project-access";
import { lockDirectory, type Transaction } from "../projects/transaction";
import { normalizeFieldValue, type FieldType } from "./value-policy";
import {
  createFieldBody,
  updateFieldBody,
  reorderFieldsBody,
  fieldSettingsBody,
  type requiredTaskFields,
} from "./schema";
import type { z } from "../../openapi";
const bad = (message: string) => new HTTPException(400, { message });
type Definition = typeof customFieldDefinitionTable.$inferSelect;
async function authorize(
  tx: Transaction,
  actorId: string,
  projectId: string,
  write: boolean,
) {
  const caps = await getProjectCapabilities(actorId, projectId, {
    database: tx,
  });
  if (!caps.readContent)
    throw new HTTPException(404, { message: "Project not found" });
  if (write && !caps.manageSettings)
    throw new HTTPException(403, { message: "Project owner required" });
}
function list(tx: Transaction, projectId: string) {
  return tx
    .select()
    .from(customFieldDefinitionTable)
    .where(eq(customFieldDefinitionTable.projectId, projectId))
    .orderBy(
      asc(customFieldDefinitionTable.position),
      asc(customFieldDefinitionTable.id),
    );
}
function response(
  project: typeof projectTable.$inferSelect,
  fields: Definition[],
) {
  return {
    revision: project.revision,
    requiredTaskFields:
      project.requiredTaskFields as (typeof requiredTaskFields)[number][],
    fields: fields.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type as FieldType,
      required: field.required,
      defaultValue: field.defaultValue,
      options: field.options as string[] | null,
      position: field.position,
      archivedAt: field.archivedAt,
    })),
  };
}
export async function listFields(actorId: string, projectId: string) {
  return db.transaction(async (tx) => {
    await lockDirectory(tx);
    await authorize(tx, actorId, projectId, false);
    const [project] = await tx
      .select()
      .from(projectTable)
      .where(eq(projectTable.id, projectId));
    if (!project)
      throw new HTTPException(404, { message: "Project not found" });
    const result = response(project, await list(tx, projectId));
    await authorize(tx, actorId, projectId, false);
    return result;
  });
}
async function validateDefinition(
  tx: Transaction,
  projectId: string,
  definition: Pick<Definition, "name" | "type" | "options" | "defaultValue">,
) {
  const options = definition.options as string[] | null;
  if (["dropdown", "multiselect"].includes(definition.type)) {
    if (!options?.length) throw bad("Добавьте варианты выбора");
  } else if (options?.length)
    throw bad("Варианты доступны только для полей выбора");
  const value = normalizeFieldValue(
    { ...definition, type: definition.type as FieldType, options },
    definition.defaultValue,
  );
  if (
    definition.type === "user" &&
    value &&
    !(await getProjectCapabilities(value, projectId, { database: tx }))
      .workOnTasks
  )
    throw bad("Сотрудник недоступен");
  return value;
}
async function mutate(
  actorId: string,
  projectId: string,
  expectedRevision: number,
  operation: string,
  change: (
    tx: Transaction,
    fields: Definition[],
    project: typeof projectTable.$inferSelect,
  ) => Promise<void>,
) {
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
    const before = response(project, await list(tx, projectId));
    await change(tx, await list(tx, projectId), project);
    const [current] = await tx
      .select()
      .from(projectTable)
      .where(eq(projectTable.id, projectId));
    const after = response(current!, await list(tx, projectId));
    if (Buffer.byteLength(JSON.stringify(after), "utf8") > 64 * 1024)
      throw bad("Настройки полей превышают 64 КБ");
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      after.revision = project.revision + 1;
      await tx
        .update(projectTable)
        .set({ revision: after.revision })
        .where(
          and(
            eq(projectTable.id, projectId),
            eq(projectTable.revision, expectedRevision),
          ),
        );
      await publishLiveChanges(tx, [
        {
          kind: "project",
          projectId,
          scopes: ["fields", "tasks", "history", "project"],
        },
      ]);
      await tx.insert(projectAuditTable).values({
        projectId,
        actorUserId: actorId,
        operation,
        payload: { before, after },
      });
    }
    await authorize(tx, actorId, projectId, true);
    return after;
  });
}
export async function createField(
  actorId: string,
  projectId: string,
  input: z.infer<typeof createFieldBody>,
) {
  const body = createFieldBody.parse(input);
  return mutate(
    actorId,
    projectId,
    body.expectedRevision,
    "doska.field.created",
    async (tx, fields) => {
      if (fields.length >= 100)
        throw bad("В проекте может быть не больше 100 полей");
      const defaultValue = await validateDefinition(tx, projectId, body);
      await tx.insert(customFieldDefinitionTable).values({
        projectId,
        name: body.name,
        type: body.type,
        required: body.required,
        defaultValue,
        options: body.options,
        position: Math.max(-1, ...fields.map((field) => field.position)) + 1,
      });
    },
  );
}
export async function updateField(
  actorId: string,
  projectId: string,
  fieldId: string,
  input: z.infer<typeof updateFieldBody>,
) {
  const body = updateFieldBody.parse(input);
  return mutate(
    actorId,
    projectId,
    body.expectedRevision,
    "doska.field.updated",
    async (tx, fields) => {
      const field = fields.find((item) => item.id === fieldId);
      if (!field) throw new HTTPException(404, { message: "Field not found" });
      const { expectedRevision: _, archived, ...patch } = body;
      const next = { ...field, ...patch };
      const defaultValue =
        patch.defaultValue !== undefined || patch.options !== undefined
          ? await validateDefinition(tx, projectId, next)
          : field.defaultValue;
      await tx
        .update(customFieldDefinitionTable)
        .set({
          ...patch,
          defaultValue,
          ...(archived === undefined
            ? {}
            : {
                archivedAt: archived ? (field.archivedAt ?? new Date()) : null,
              }),
        })
        .where(eq(customFieldDefinitionTable.id, fieldId));
    },
  );
}
export async function reorderFields(
  actorId: string,
  projectId: string,
  input: z.infer<typeof reorderFieldsBody>,
) {
  const body = reorderFieldsBody.parse(input);
  return mutate(
    actorId,
    projectId,
    body.expectedRevision,
    "doska.fields.reordered",
    async (tx, fields) => {
      const active = fields.filter((field) => !field.archivedAt);
      if (
        body.fieldIds.length !== active.length ||
        body.fieldIds.some((id) => !active.some((field) => field.id === id))
      )
        throw bad("Укажите все действующие поля");
      for (const [position, id] of body.fieldIds.entries())
        await tx
          .update(customFieldDefinitionTable)
          .set({ position })
          .where(eq(customFieldDefinitionTable.id, id));
    },
  );
}
export async function updateFieldSettings(
  actorId: string,
  projectId: string,
  input: z.infer<typeof fieldSettingsBody>,
) {
  const body = fieldSettingsBody.parse(input);
  return mutate(
    actorId,
    projectId,
    body.expectedRevision,
    "doska.fields.required_changed",
    async (tx) => {
      await tx
        .update(projectTable)
        .set({ requiredTaskFields: body.requiredTaskFields })
        .where(eq(projectTable.id, projectId));
    },
  );
}
