import {
  taskLabelsSchema,
  taskLabelsPatchSchema,
  labelResponse,
} from "../labels/schema";
import { customValuesSchema, customValuesResponse } from "../fields/schema";
import { cardColors } from "./card-color";
import { z, responseTimestamp, nullableResponseTimestamp } from "../../openapi";
import { pageQuery } from "../projects/member-schema";
import { isCalendarDate, moscowDate } from "./dates";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const userId = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const date = z.string().refine(isCalendarDate, "Invalid date");
const priority = z.enum(["no-priority", "low", "medium", "high", "urgent"]);
const fields = {
  labels: taskLabelsSchema.optional(),
  customValues: customValuesSchema.optional(),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(100_000).nullable().optional(),
  columnId: id.optional(),
  parentTaskId: id.nullable().optional(),
  userId: userId.nullable().optional(),
  coexecutorIds: z
    .array(userId)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate coexecutor")
    .optional(),
  priority: priority.optional(),
  cardColor: z.enum(cardColors).nullable().optional(),
  startDate: date.nullable().optional(),
  due: z
    .strictObject({
      date,
      time: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .optional(),
    })
    .nullable()
    .optional(),
};
export const taskParams = z.strictObject({ id, taskId: id });
export const createTaskBody = z.strictObject(fields);
export const updateTaskBody = z
  .strictObject({
    ...fields,
    labels: taskLabelsPatchSchema.optional(),
    title: fields.title.optional(),
    beforeTaskId: id
      .nullable()
      .optional()
      .describe(
        "Insert before this active task in the destination column; null appends. Omit to keep order within the current column.",
      ),
    confirmIncompleteSubtasks: z.boolean().optional(),
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
  })
  .refine(
    (body) => Object.keys(body).some((key) => key !== "expectedRevision"),
    "No changes supplied",
  );
export const archiveTaskBody = z.strictObject({
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  archived: z.boolean(),
});
export const deleteTaskBody = z.strictObject({
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
});
export const taskListQuery = pageQuery.extend({
  parentTaskId: id
    .optional()
    .describe("Return direct subtasks of this project task."),
  archived: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});
export function taskInput<
  T extends z.infer<typeof createTaskBody> | z.infer<typeof updateTaskBody>,
>(body: T) {
  const { due, startDate, ...rest } = body;
  return {
    ...rest,
    ...(startDate !== undefined
      ? { startDate: startDate === null ? null : moscowDate(startDate) }
      : {}),
    ...(due !== undefined
      ? {
          dueDate:
            due === null ? null : moscowDate(due.date, due.time ?? "23:59"),
          dueDateHasTime: Boolean(due?.time),
        }
      : {}),
  };
}
export const taskResponse = z.strictObject({
  labels: z.array(labelResponse),
  customValues: customValuesResponse,
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  columnId: z.string().nullable(),
  parentTaskId: z.string().nullable(),
  status: z.string(),
  priority: z.string(),
  cardColor: z.enum(cardColors).nullable(),
  userId: z.string().nullable(),
  coexecutorIds: z.array(z.string()),
  checklistPreview: z
    .array(
      z.strictObject({
        id: z.string(),
        checklistId: z.string(),
        text: z.string(),
        done: z.boolean(),
      }),
    )
    .max(4),
  checklistGroups: z
    .array(
      z.strictObject({
        id: z.string(),
        title: z.string(),
        total: z.number().int().nonnegative(),
        done: z.number().int().nonnegative(),
        preview: z
          .array(
            z.strictObject({
              id: z.string(),
              checklistId: z.string(),
              text: z.string(),
              done: z.boolean(),
            }),
          )
          .max(4),
      }),
    )
    .optional(),
  checklistProgress: z.strictObject({
    total: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
  }),
  number: z.number().nullable(),
  position: z.number().nullable(),
  revision: z.number(),
  startDate: nullableResponseTimestamp,
  dueDate: nullableResponseTimestamp,
  dueDateHasTime: z.boolean(),
  archivedAt: nullableResponseTimestamp,
  createdAt: responseTimestamp,
  updatedAt: responseTimestamp,
});
export const taskHistoryItem = z.object({
  references: z.strictObject({
    users: z.array(z.strictObject({ id: z.string(), name: z.string() })),
    columns: z.array(z.strictObject({ id: z.string(), name: z.string() })),
    tasks: z.array(
      z.strictObject({
        id: z.string(),
        number: z.number().nullable(),
        title: z.string(),
      }),
    ),
  }),
  authorName: z.string().nullable(),
  id: z.string(),
  taskId: z.string(),
  type: z.string(),
  userId: z.string().nullable(),
  createdAt: responseTimestamp,
  eventData: z.unknown(),
});
