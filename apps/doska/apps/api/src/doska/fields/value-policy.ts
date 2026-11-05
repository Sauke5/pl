import { HTTPException } from "hono/http-exception";
import { isCalendarDate } from "../tasks/dates";

export const fieldTypes = [
  "text",
  "number",
  "date",
  "boolean",
  "dropdown",
  "multiselect",
  "user",
] as const;
export type FieldType = (typeof fieldTypes)[number];
export type FieldDefinition = {
  id: string;
  name: string;
  type: FieldType;
  required: boolean;
  defaultValue: string | null;
  options: string[] | null;
  archivedAt: Date | string | null;
};
export type FieldValue = { fieldId: string; value: string | null };
const invalid = (name: string): never => {
  throw new HTTPException(400, {
    message: `Некорректное значение поля «${name}»`,
  });
};
export function normalizeFieldValue(
  field: Pick<FieldDefinition, "name" | "type" | "options">,
  value: string | null,
): string | null {
  if (value === null || value.trim() === "") return null;
  if (value.length > 10_000)
    throw new HTTPException(400, {
      message: `Поле «${field.name}»: не больше 10 000 символов`,
    });
  const trimmed = value.trim();
  switch (field.type) {
    case "text":
      return value;
    case "number":
      if (
        !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(trimmed) ||
        !Number.isFinite(Number(trimmed))
      )
        return invalid(field.name);
      return trimmed;
    case "date":
      if (!isCalendarDate(trimmed)) return invalid(field.name);
      return trimmed;
    case "boolean":
      if (trimmed !== "true" && trimmed !== "false") return invalid(field.name);
      return trimmed;
    case "dropdown":
      if (!field.options?.includes(trimmed)) return invalid(field.name);
      return trimmed;
    case "multiselect": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return invalid(field.name);
      }
      if (
        !Array.isArray(parsed) ||
        parsed.length > 100 ||
        parsed.some(
          (option) =>
            typeof option !== "string" || !field.options?.includes(option),
        ) ||
        new Set(parsed).size !== parsed.length
      )
        return invalid(field.name);
      return parsed.length ? JSON.stringify(parsed) : null;
    }
    case "user":
      if (!/^[A-Za-z0-9:_-]{1,128}$/.test(trimmed)) return invalid(field.name);
      return trimmed;
  }
}

/** Sparse updates preserve omitted values. Existing incomplete tasks remain editable. */
export function planFieldValues(
  definitions: readonly FieldDefinition[],
  current: readonly FieldValue[],
  updates: readonly FieldValue[] | undefined,
  creating: boolean,
) {
  const byId = new Map(definitions.map((field) => [field.id, field]));
  const previous = new Map(current.map((item) => [item.fieldId, item.value]));
  const supplied = new Map<string, string | null>();
  for (const item of updates ?? []) {
    const field = byId.get(item.fieldId);
    if (!field || field.archivedAt || supplied.has(item.fieldId))
      throw new HTTPException(400, {
        message: "Поле недоступно или указано повторно",
      });
    supplied.set(item.fieldId, normalizeFieldValue(field, item.value));
  }
  const changes: FieldValue[] = [];
  for (const field of definitions) {
    if (field.archivedAt) continue;
    if (!creating && !supplied.has(field.id)) continue;
    const value = supplied.has(field.id)
      ? supplied.get(field.id)!
      : normalizeFieldValue(field, field.defaultValue);
    if (field.required && value === null)
      throw new HTTPException(400, {
        message: `Заполните поле «${field.name}»`,
      });
    if (value !== (previous.get(field.id) ?? null))
      changes.push({ fieldId: field.id, value });
  }
  if (changes.length) {
    const result = new Map(previous);
    for (const change of changes) {
      if (change.value === null) result.delete(change.fieldId);
      else result.set(change.fieldId, change.value);
    }
    const bytes = Buffer.byteLength(
      JSON.stringify(
        [...result].map(([fieldId, value]) => ({ fieldId, value })),
      ),
      "utf8",
    );
    if (bytes > 32 * 1024)
      throw new HTTPException(400, {
        message: "Общий размер значений полей превышает 32 КБ",
      });
  }
  return changes;
}
