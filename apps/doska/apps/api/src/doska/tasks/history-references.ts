import { and, eq, inArray } from "drizzle-orm";
import {
  columnTable,
  userTable,
  taskTable,
  customFieldDefinitionTable,
} from "../../database/schema";
import type { Transaction } from "./transaction";

export async function historyReferences(
  tx: Transaction,
  projectId: string,
  events: { eventData: unknown }[],
) {
  const userFields = new Set(
    (
      await tx
        .select({ id: customFieldDefinitionTable.id })
        .from(customFieldDefinitionTable)
        .where(
          and(
            eq(customFieldDefinitionTable.projectId, projectId),
            eq(customFieldDefinitionTable.type, "user"),
          ),
        )
    ).map((field) => field.id),
  );
  const users = new Set<string>();
  const columns = new Set<string>();
  const tasks = new Set<string>();
  for (const event of events) {
    if (!event.eventData || typeof event.eventData !== "object") continue;
    const data = event.eventData as Record<string, unknown>;
    for (const value of [data.before, data.after]) {
      if (!value || typeof value !== "object") continue;
      const fields = value as Record<string, unknown>;
      if (typeof fields.userId === "string") users.add(fields.userId);
      if (typeof fields.columnId === "string") columns.add(fields.columnId);
      if (typeof fields.parentTaskId === "string")
        tasks.add(fields.parentTaskId);
      if (Array.isArray(fields.customValues))
        for (const entry of fields.customValues) {
          if (
            entry &&
            typeof entry === "object" &&
            typeof entry.fieldId === "string" &&
            userFields.has(entry.fieldId) &&
            typeof entry.value === "string"
          )
            users.add(entry.value);
        }
      for (const key of ["coexecutorIds", "mentionIds"]) {
        if (Array.isArray(fields[key]))
          for (const id of fields[key])
            if (typeof id === "string") users.add(id);
      }
    }
  }
  return {
    tasks: tasks.size
      ? await tx
          .select({
            id: taskTable.id,
            number: taskTable.number,
            title: taskTable.title,
          })
          .from(taskTable)
          .where(
            and(
              eq(taskTable.projectId, projectId),
              inArray(taskTable.id, [...tasks]),
            ),
          )
      : [],
    users: users.size
      ? await tx
          .select({ id: userTable.id, name: userTable.name })
          .from(userTable)
          .where(inArray(userTable.id, [...users]))
      : [],
    columns: columns.size
      ? await tx
          .select({ id: columnTable.id, name: columnTable.name })
          .from(columnTable)
          .where(
            and(
              eq(columnTable.projectId, projectId),
              inArray(columnTable.id, [...columns]),
            ),
          )
      : [],
  };
}
