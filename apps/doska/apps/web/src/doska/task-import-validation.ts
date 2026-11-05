import type { Column, CreateTaskInput } from "./api";
import type { CustomField, FieldPerson, ProjectFields } from "./custom-fields";

export const importPriorities = [
  "no-priority",
  "low",
  "medium",
  "high",
  "urgent",
] as const;
export type ImportTaskIssue = {
  field: string;
  reason: "required" | "invalid" | "date_order";
};
function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value))
    return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
  );
}
const empty = (value: unknown) =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && !value.trim());
function customValue(
  field: CustomField,
  value: unknown,
  people: Set<string>,
): "empty" | "valid" | "invalid" {
  if (empty(value)) return "empty";
  if (typeof value !== "string" || value.length > 10_000) return "invalid";
  const trimmed = value.trim();
  switch (field.type) {
    case "text":
      return "valid";
    case "number":
      return /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(trimmed) &&
        Number.isFinite(Number(trimmed))
        ? "valid"
        : "invalid";
    case "date":
      return calendarDate(trimmed) ? "valid" : "invalid";
    case "boolean":
      return trimmed === "true" || trimmed === "false" ? "valid" : "invalid";
    case "dropdown":
      return field.options?.includes(trimmed) ? "valid" : "invalid";
    case "user":
      return /^[A-Za-z0-9:_-]{1,128}$/.test(trimmed) && people.has(trimmed)
        ? "valid"
        : "invalid";
    case "multiselect": {
      try {
        const values: unknown = JSON.parse(trimmed);
        if (
          !Array.isArray(values) ||
          values.length > 100 ||
          values.some(
            (v) => typeof v !== "string" || !field.options?.includes(v),
          ) ||
          new Set(values).size !== values.length
        )
          return "invalid";
        return values.length ? "valid" : "empty";
      } catch {
        return "invalid";
      }
    }
  }
}

/** The people list is the current owner/participant roster, excluding observers. */
export function importTaskIssues(
  task: CreateTaskInput,
  fields: ProjectFields,
  columns: Column[],
  people: FieldPerson[],
): ImportTaskIssue[] {
  const issues: ImportTaskIssue[] = [];
  const add = (field: string, reason: ImportTaskIssue["reason"]) => {
    if (!issues.some((issue) => issue.field === field))
      issues.push({ field, reason });
  };
  const members = new Set(people.map((person) => person.userId));
  if (empty(task.title)) add("title", "required");
  else if (typeof task.title !== "string" || task.title.trim().length > 500)
    add("title", "invalid");
  if (
    task.description != null &&
    (typeof task.description !== "string" || task.description.length > 100_000)
  )
    add("description", "invalid");
  if (empty(task.columnId)) add("columnId", "required");
  else if (!columns.some((column) => column.id === task.columnId))
    add("columnId", "invalid");
  if (task.userId != null && !members.has(task.userId))
    add("userId", "invalid");
  if (task.priority !== undefined && !importPriorities.includes(task.priority))
    add("priority", "invalid");
  if (task.startDate != null && !calendarDate(task.startDate))
    add("startDate", "invalid");
  if (
    task.due != null &&
    (typeof task.due !== "object" ||
      !calendarDate(task.due.date) ||
      (task.due.time !== undefined &&
        (typeof task.due.time !== "string" ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(task.due.time))))
  )
    add("due", "invalid");
  if (
    calendarDate(task.startDate) &&
    task.due &&
    calendarDate(task.due.date) &&
    task.startDate > task.due.date
  )
    add("due", "date_order");
  for (const key of fields.requiredTaskFields) {
    const value = task[key];
    if (empty(value) || (key === "priority" && value === "no-priority"))
      add(key, "required");
  }
  const definitions = new Map(fields.fields.map((field) => [field.id, field]));
  const supplied = new Map<string, unknown>();
  for (const item of task.customValues ?? []) {
    if (
      !definitions.has(item.fieldId) ||
      definitions.get(item.fieldId)?.archivedAt ||
      supplied.has(item.fieldId)
    )
      add(item.fieldId, "invalid");
    supplied.set(item.fieldId, item.value);
  }
  const effective: { fieldId: string; value: string }[] = [];
  for (const field of fields.fields) {
    if (field.archivedAt) continue;
    const value = supplied.has(field.id)
      ? supplied.get(field.id)
      : field.defaultValue;
    const status = customValue(field, value, members);
    if (status === "invalid") add(field.id, "invalid");
    else if (status === "empty" && field.required) add(field.id, "required");
    else if (status === "valid") {
      const normalized =
        field.type === "text"
          ? (value as string)
          : field.type === "multiselect"
            ? JSON.stringify(JSON.parse((value as string).trim()))
            : (value as string).trim();
      effective.push({ fieldId: field.id, value: normalized });
    }
  }
  if (
    new TextEncoder().encode(JSON.stringify(effective)).byteLength >
    32 * 1024
  ) {
    for (const value of effective) add(value.fieldId, "invalid");
  }
  return issues;
}
