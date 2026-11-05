import { and, asc, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  customFieldDefinitionTable,
  customFieldValueTable,
} from "../../database/schema";
import { getProjectCapabilities } from "../project-access";
import type { Transaction } from "../projects/transaction";
import {
  planFieldValues,
  type FieldDefinition,
  type FieldValue,
} from "./value-policy";
export async function listFieldValues(tx: Transaction, taskIds: string[]) {
  if (!taskIds.length) return new Map<string, FieldValue[]>();
  const rows = await tx
    .select({
      taskId: customFieldValueTable.taskId,
      fieldId: customFieldValueTable.fieldId,
      value: customFieldValueTable.value,
    })
    .from(customFieldValueTable)
    .where(inArray(customFieldValueTable.taskId, taskIds))
    .orderBy(asc(customFieldValueTable.fieldId));
  const result = new Map<string, FieldValue[]>();
  for (const { taskId, ...value } of rows) {
    const items = result.get(taskId) ?? [];
    items.push(value);
    result.set(taskId, items);
  }
  return result;
}
export async function prepareTaskFields(
  tx: Transaction,
  projectId: string,
  taskId: string | undefined,
  updates: FieldValue[] | undefined,
) {
  const definitions = await tx
    .select()
    .from(customFieldDefinitionTable)
    .where(eq(customFieldDefinitionTable.projectId, projectId));
  const before = taskId
    ? ((await listFieldValues(tx, [taskId])).get(taskId) ?? [])
    : [];
  const changes = planFieldValues(
    definitions as FieldDefinition[],
    before,
    updates,
    !taskId,
  );
  for (const change of changes) {
    const field = definitions.find((item) => item.id === change.fieldId)!;
    if (
      field.type === "user" &&
      change.value &&
      !(await getProjectCapabilities(change.value, projectId, { database: tx }))
        .workOnTasks
    )
      throw new HTTPException(400, {
        message: `Сотрудник недоступен для поля «${field.name}»`,
      });
  }
  return { before, changes };
}
export async function applyTaskFields(
  tx: Transaction,
  taskId: string,
  changes: FieldValue[],
) {
  for (const change of changes) {
    if (change.value === null)
      await tx
        .delete(customFieldValueTable)
        .where(
          and(
            eq(customFieldValueTable.taskId, taskId),
            eq(customFieldValueTable.fieldId, change.fieldId),
          ),
        );
    else
      await tx
        .insert(customFieldValueTable)
        .values({ taskId, ...change })
        .onConflictDoUpdate({
          target: [customFieldValueTable.taskId, customFieldValueTable.fieldId],
          set: { value: change.value, updatedAt: new Date() },
        });
  }
}
export function assertStandardRequired(
  required: readonly string[],
  input: {
    description?: string | null;
    userId?: string | null;
    priority?: string;
    startDate?: Date | null;
    dueDate?: Date | null;
  },
  creating: boolean,
) {
  const names: Record<string, string> = {
    description: "Описание",
    userId: "Ответственный",
    priority: "Приоритет",
    startDate: "Начало",
    due: "Срок",
  };
  for (const key of required) {
    const property = key === "due" ? "dueDate" : (key as keyof typeof input);
    if (!creating && !(property in input)) continue;
    const value = input[property];
    if (
      value === null ||
      value === undefined ||
      (typeof value === "string" && !value.trim()) ||
      (key === "priority" && value === "no-priority")
    )
      throw new HTTPException(400, {
        message: `Заполните поле «${names[key] ?? key}»`,
      });
  }
}
