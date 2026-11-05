import type {
  customFieldDefinitionTable,
  customFieldValueTable,
  labelTable,
} from "../../database/schema";
import { TemplateSnapshotError } from "./snapshot";

type FieldInput = Pick<
  typeof customFieldDefinitionTable.$inferSelect,
  | "id"
  | "projectId"
  | "name"
  | "type"
  | "required"
  | "defaultValue"
  | "options"
  | "position"
> & { archivedAt?: Date | null };
type ValueInput = Pick<
  typeof customFieldValueTable.$inferSelect,
  "taskId" | "fieldId" | "value"
>;
type LabelInput = Pick<
  typeof labelTable.$inferSelect,
  "id" | "taskId" | "name" | "color" | "deletionStartedAt"
>;
export type TemplateField = {
  key: string;
  name: string;
  type:
    | "text"
    | "number"
    | "date"
    | "dropdown"
    | "boolean"
    | "multiselect"
    | "user";
  required: boolean;
  defaultValue: string | null;
  options: string[] | null;
  position: number;
};
export type TemplateTaskMetadata = {
  labels: { name: string; color: string }[];
  customValues: { fieldKey: string; value: string | null }[];
};
function fail(): never {
  throw new TemplateSnapshotError("Invalid template custom field metadata");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function validDate(value: string) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})?)?$/.exec(
      value,
    );
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
}
function validateValue(value: string | null, field: TemplateField) {
  // Typical tasks may be incomplete; the project editor exposes missing required values.
  if (value === null || value.trim() === "") return;
  switch (field.type) {
    case "text":
    case "user":
      return;
    case "number":
      if (
        !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.trim()) ||
        !Number.isFinite(Number(value))
      )
        fail();
      return;
    case "date":
      if (!validDate(value)) fail();
      return;
    case "boolean":
      if (value !== "true" && value !== "false") fail();
      return;
    case "dropdown":
      if (!field.options?.includes(value.trim())) fail();
      return;
    case "multiselect": {
      let items: unknown;
      try {
        items = JSON.parse(value);
      } catch {
        fail();
      }
      if (
        !Array.isArray(items) ||
        items.some(
          (item) => typeof item !== "string" || !field.options?.includes(item),
        ) ||
        new Set(items).size !== items.length
      )
        fail();
      return;
    }
  }
}
export function buildTemplateMetadata(input: {
  projectId: string;
  fields: readonly FieldInput[];
  values: readonly ValueInput[];
  labels: readonly LabelInput[];
  taskKeys: ReadonlyMap<string, string>;
}): {
  customFields: TemplateField[];
  taskMetadata: Record<string, TemplateTaskMetadata>;
} {
  const byId = new Map<string, TemplateField>();
  const archivedIds = new Set(
    input.fields.filter((field) => field.archivedAt).map((field) => field.id),
  );
  const customFields = [...input.fields]
    .filter((field) => !field.archivedAt)
    .sort((a, b) => a.position - b.position || compare(a.id, b.id))
    .map((row, index): TemplateField => {
      if (
        row.projectId !== input.projectId ||
        byId.has(row.id) ||
        !row.name.trim() ||
        !Number.isFinite(row.position)
      )
        fail();
      if (
        ![
          "text",
          "number",
          "date",
          "dropdown",
          "boolean",
          "multiselect",
          "user",
        ].includes(row.type)
      )
        fail();
      let options: string[] | null = null;
      if (row.options !== null && row.options !== undefined) {
        if (
          !Array.isArray(row.options) ||
          row.options.some(
            (option) => typeof option !== "string" || !option.trim(),
          ) ||
          new Set(row.options).size !== row.options.length
        )
          fail();
        options = [...row.options];
      }
      if (
        (row.type === "dropdown" && !options?.length) ||
        (row.type === "multiselect" && !options?.length)
      )
        fail();
      const field: TemplateField = {
        key: `f${index + 1}`,
        name: row.name,
        type: row.type as TemplateField["type"],
        required: row.required,
        defaultValue: row.type === "user" ? null : row.defaultValue,
        options,
        position: row.position,
      };
      validateValue(field.defaultValue, field);
      // Removed choices remain valid historical task values. Carry only choices
      // used by selected tasks into the independent template snapshot.
      if (field.type === "dropdown" || field.type === "multiselect") {
        const historical = new Set<string>();
        for (const value of input.values) {
          if (
            value.fieldId !== row.id ||
            !input.taskKeys.has(value.taskId) ||
            value.value === null ||
            value.value.trim() === ""
          )
            continue;
          let choices: unknown = [value.value.trim()];
          if (field.type === "multiselect") {
            try {
              choices = JSON.parse(value.value);
            } catch {
              fail();
            }
          }
          if (
            !Array.isArray(choices) ||
            choices.some(
              (choice) => typeof choice !== "string" || !choice.trim(),
            )
          )
            fail();
          for (const choice of choices as string[]) {
            if (!field.options!.includes(choice)) historical.add(choice);
          }
        }
        field.options = [...field.options!, ...[...historical].sort(compare)];
        if (
          field.options.length > 200 ||
          field.options.some((option) => option.length > 2000)
        ) {
          throw new TemplateSnapshotError(
            "Template choices exceed limits: at most 200 options of 2000 characters",
          );
        }
      }
      byId.set(row.id, field);
      return field;
    });
  const taskMetadata: Record<string, TemplateTaskMetadata> =
    Object.create(null);
  for (const key of input.taskKeys.values()) {
    if (Object.hasOwn(taskMetadata, key)) fail();
    taskMetadata[key] = { labels: [], customValues: [] };
  }
  const seenValues = new Map<string, Set<string>>();
  for (const row of input.values) {
    const key = input.taskKeys.get(row.taskId);
    if (key === undefined) continue;
    if (archivedIds.has(row.fieldId)) continue;
    const field = byId.get(row.fieldId);
    if (!field) fail();
    if (field.type === "user") continue;
    const seen = seenValues.get(key) ?? new Set<string>();
    if (seen.has(row.fieldId)) fail();
    seen.add(row.fieldId);
    seenValues.set(key, seen);
    validateValue(row.value, field);
    taskMetadata[key]!.customValues.push({
      fieldKey: field.key,
      value: row.value,
    });
  }
  for (const row of [...input.labels].sort((a, b) => compare(a.id, b.id))) {
    if (row.taskId === null || row.deletionStartedAt !== null) continue;
    const key = input.taskKeys.get(row.taskId);
    if (key !== undefined)
      taskMetadata[key]!.labels.push({ name: row.name, color: row.color });
  }
  for (const metadata of Object.values(taskMetadata))
    metadata.customValues.sort(
      (a, b) => Number(a.fieldKey.slice(1)) - Number(b.fieldKey.slice(1)),
    );
  return freeze({ customFields, taskMetadata });
}
