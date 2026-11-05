import { and, eq, isNull, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { customFieldDefinitionTable, taskTable } from "../../database/schema";
import { normalizeFieldValue, type FieldType } from "../fields/value-policy";
import { readProjectCondition } from "../read-project-condition";
import type { Transaction } from "../projects/transaction";
import type { TaskSearchInput } from "./search-schema";

export async function searchMetadataPredicate(
  tx: Transaction,
  actorId: string,
  input: TaskSearchInput,
) {
  const label = input.labelName
    ? sql`EXISTS (SELECT 1 FROM label AS search_label WHERE search_label.task_id=${taskTable.id} AND search_label.deletion_started_at IS NULL AND search_label.name=${input.labelName})`
    : undefined;
  if (!input.customFieldId) return label;
  const [field] = await tx
    .select()
    .from(customFieldDefinitionTable)
    .where(
      and(
        eq(customFieldDefinitionTable.id, input.customFieldId),
        eq(customFieldDefinitionTable.projectId, input.projectId!),
        isNull(customFieldDefinitionTable.archivedAt),
        readProjectCondition(actorId, customFieldDefinitionTable.projectId),
      ),
    );
  // Unknown, foreign and inaccessible definitions have the same empty result.
  if (!field) return sql`false`;
  const raw = input.customFieldValue!;
  const normalized = normalizeFieldValue(
    {
      ...field,
      type: field.type as FieldType,
      options: field.options as string[] | null,
    },
    raw,
  );
  if (normalized === null)
    throw new HTTPException(400, {
      message: "Укажите значение поля для поиска",
    });
  const value = sql`search_value.value`;
  const match =
    field.type === "text"
      ? sql`${value} ILIKE ${`%${normalized.replace(/[\\%_]/g, "\\$&")}%`}`
      : field.type === "number"
        ? sql`CASE WHEN pg_input_is_valid(${value}, 'numeric') THEN ${value}::numeric END = (CASE WHEN pg_input_is_valid(${normalized}, 'numeric') THEN ${normalized}::text END)::numeric`
        : field.type === "multiselect"
          ? sql`CASE WHEN pg_input_is_valid(${value}, 'jsonb') THEN ${value}::jsonb END @> ${normalized}::jsonb`
          : sql`${value} = ${normalized}`;
  return and(
    label,
    sql`EXISTS (SELECT 1 FROM custom_field_value AS search_value WHERE search_value.task_id=${taskTable.id} AND search_value.field_id=${field.id} AND ${match})`,
  );
}
