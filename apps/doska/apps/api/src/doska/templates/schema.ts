import { cardColors } from "../tasks/card-color";
import { z } from "../../openapi";
import { createProjectBody } from "../projects/schema";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z.number().int().min(0).max(2_147_483_646);
const key = z.string().regex(/^[ct][1-9][0-9]*$/);
const position = z.number().int().min(0).max(2_147_483_647);
export const templateVisibility = z.enum(["private", "department", "company"]);
export const templateSelectionBody = z.strictObject({
  expectedRevision: revision,
  selected: z.boolean(),
});
export const saveTemplateBody = z
  .strictObject({
    sourceProjectId: id,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().trim().min(1).max(200),
    visibility: templateVisibility.default("private"),
    templateId: id.optional(),
    expectedRevision: revision.optional(),
  })
  .refine(
    (value) =>
      Boolean(value.templateId) === (value.expectedRevision !== undefined),
    "Template ID and revision must be supplied together",
  );
export const createFromTemplateBody = z.strictObject({
  expectedRevision: revision,
  includeTasks: z.boolean(),
  project: createProjectBody,
});
export const templateSnapshotSchema = z
  .strictObject({
    version: z.literal(1),
    requiredTaskFields: z
      .array(z.enum(["description", "userId", "priority", "startDate", "due"]))
      .max(5)
      .default([]),
    customFields: z
      .array(
        z.strictObject({
          key: z.string().regex(/^f[1-9][0-9]*$/),
          name: z.string().min(1).max(200),
          type: z.enum([
            "text",
            "number",
            "date",
            "dropdown",
            "boolean",
            "multiselect",
            "user",
          ]),
          required: z.boolean(),
          defaultValue: z.string().max(100_000).nullable(),
          options: z.array(z.string().min(1).max(2000)).max(200).nullable(),
          position,
        }),
      )
      .max(100)
      .default([]),
    columns: z
      .array(
        z.strictObject({
          key,
          name: z.string().min(1).max(100),
          slug: z.string().min(1).max(128),
          semanticState: z.enum(["planned", "active", "completed"]),
          color: z.string().max(100).nullable(),
          icon: z.string().max(100).nullable(),
          position,
        }),
      )
      .min(1)
      .max(100),
    tasks: z
      .array(
        z.strictObject({
          key,
          labels: z
            .array(
              z.strictObject({
                name: z.string().min(1).max(200),
                color: z.string().max(100),
              }),
            )
            .max(100)
            .default([]),
          customValues: z
            .array(
              z.strictObject({
                fieldKey: z.string().regex(/^f[1-9][0-9]*$/),
                value: z.string().max(100_000).nullable(),
              }),
            )
            .max(100)
            .default([]),
          title: z.string().min(1).max(500),
          description: z.string().max(100_000).nullable(),
          priority: z.enum(["no-priority", "low", "medium", "high", "urgent"]),
          cardColor: z.enum(cardColors).nullable().default(null),
          columnKey: key.nullable(),
          parentKey: key.nullable(),
          position,
          checklists: z
            .array(
              z.strictObject({
                title: z.string().min(1).max(200),
                items: z
                  .array(
                    z.strictObject({
                      text: z.string().min(1).max(2000),
                      done: z.literal(false),
                    }),
                  )
                  .max(200),
              }),
            )
            .max(200),
        }),
      )
      .max(1000),
    relations: z
      .array(
        z.strictObject({
          type: z.enum(["related", "blocks", "duplicate"]),
          sourceKey: key,
          targetKey: key,
        }),
      )
      .max(10_000),
  })
  .superRefine((snapshot, ctx) => {
    const columns = new Set(snapshot.columns.map((column) => column.key));
    const fieldKeys = new Set(snapshot.customFields.map((field) => field.key));
    const tasks = new Map(snapshot.tasks.map((task) => [task.key, task]));
    const invalid = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (
      columns.size !== snapshot.columns.length ||
      tasks.size !== snapshot.tasks.length
    )
      invalid("Duplicate snapshot keys");
    if (
      new Set(snapshot.columns.map((column) => column.slug)).size !==
      snapshot.columns.length
    )
      invalid("Duplicate column slugs");
    if (fieldKeys.size !== snapshot.customFields.length)
      invalid("Duplicate custom field keys");
    for (const task of snapshot.tasks) {
      if (
        new Set(task.customValues.map((value) => value.fieldKey)).size !==
        task.customValues.length
      )
        invalid("Duplicate custom values");
      if (task.customValues.some((value) => !fieldKeys.has(value.fieldKey)))
        invalid("Unknown custom field");
      if (
        new Set(task.labels.map((label) => label.name)).size !==
        task.labels.length
      )
        invalid("Duplicate task labels");
      if (task.columnKey && !columns.has(task.columnKey))
        invalid("Missing task column");
      if (task.parentKey) {
        const parent = tasks.get(task.parentKey);
        if (!parent || parent.key === task.key || parent.parentKey)
          invalid("Invalid task hierarchy");
      }
    }
    for (const relation of snapshot.relations)
      if (
        !tasks.has(relation.sourceKey) ||
        !tasks.has(relation.targetKey) ||
        relation.sourceKey === relation.targetKey
      )
        invalid("Invalid task relation");
  });
