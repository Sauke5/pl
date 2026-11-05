import { z } from "../../openapi";
import { pageQuery } from "../projects/member-schema";
import { resourceRef } from "../resource-links/schema";
import { isCalendarDate } from "./dates";
const filters = {
  resourceSource: z.string().max(43).optional(),
  resourceType: z
    .enum(["resource", "dcim.device", "virtualization.virtualmachine"])
    .optional(),
  resourceObjectId: z.string().max(36).optional(),
  labelName: z.string().trim().min(1).max(100).optional(),
  customFieldId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  customFieldValue: z.string().min(1).max(2000).optional(),
  q: z.string().max(200).optional(),
  projectId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  assigneeId: z
    .string()
    .regex(/^[A-Za-z0-9:_-]{1,128}$/)
    .optional(),
  coexecutorId: z
    .string()
    .regex(/^[A-Za-z0-9:_-]{1,128}$/)
    .optional(),
  state: z.enum(["planned", "active", "completed"]).optional(),
  priority: z
    .enum(["no-priority", "low", "medium", "high", "urgent"])
    .optional(),
  dueFrom: z.string().refine(isCalendarDate, "Invalid date").optional(),
  dueTo: z.string().refine(isCalendarDate, "Invalid date").optional(),
};
const datesOrdered = (input: { dueFrom?: string; dueTo?: string }) =>
  !input.dueFrom || !input.dueTo || input.dueFrom <= input.dueTo;
const fieldFilterComplete = (input: {
  projectId?: string;
  customFieldId?: string;
  customFieldValue?: string;
}) =>
  (input.customFieldId === undefined && input.customFieldValue === undefined) ||
  Boolean(input.projectId && input.customFieldId && input.customFieldValue);
const resourceFilterComplete = (input: {
  projectId?: string;
  resourceSource?: string;
  resourceType?: string;
  resourceObjectId?: string;
}) => {
  if (
    [input.resourceSource, input.resourceType, input.resourceObjectId].every(
      (value) => value === undefined,
    )
  )
    return true;
  return (
    Boolean(input.projectId) &&
    resourceRef.safeParse({
      version: 1,
      source: input.resourceSource,
      type: input.resourceType,
      id: input.resourceObjectId,
    }).success
  );
};
const booleanQuery = z
  .enum(["true", "false"])
  .transform((value) => value === "true");
export const taskSearchQuery = pageQuery
  .extend({
    ...filters,
    open: booleanQuery.optional(),
    upcoming: booleanQuery.optional(),
    unassigned: booleanQuery.optional(),
    overdue: booleanQuery.optional(),
    archived: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .strict()
  .refine(resourceFilterComplete, "Invalid resource filter")
  .refine(datesOrdered, "Invalid date range")
  .refine(
    fieldFilterComplete,
    "Field search requires project, field and value",
  );
export const taskSearchInput = z
  .strictObject({
    ...filters,
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).max(10_000_000).default(0),
    open: z.boolean().optional(),
    upcoming: z.boolean().optional(),
    unassigned: z.boolean().optional(),
    overdue: z.boolean().optional(),
    archived: z.boolean().default(false),
  })
  .strict()
  .refine(resourceFilterComplete, "Invalid resource filter")
  .refine(datesOrdered, "Invalid date range")
  .refine(
    fieldFilterComplete,
    "Field search requires project, field and value",
  );
export type TaskSearchInput = z.input<typeof taskSearchInput>;
