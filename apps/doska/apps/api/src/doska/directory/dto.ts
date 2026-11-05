import { z } from "zod";

const id = z.string().min(1).max(4096);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
const cursor = z.string().max(4096);

export const identitySchema = z
  .strictObject({
    schema_version: z.literal(1),
    sub: id,
    name: z.string(),
    state: z.enum(["active", "disabled", "expired", "missing", "unknown"]),
    identity_revision: revision,
    department_state: z.enum(["resolved", "ambiguous", "unassigned"]),
    primary_department_id: id.nullable(),
    head_department_ids: z.array(id),
    observed_at: timestamp,
    valid_until: timestamp,
  })
  .superRefine((identity, ctx) => {
    if (
      (identity.department_state === "resolved") !==
      (identity.primary_department_id !== null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Inconsistent department projection",
      });
    }
    const age =
      Date.parse(identity.valid_until) - Date.parse(identity.observed_at);
    // Go emits this pair when no successful observation exists. Preserve a
    // revocation even without freshness; it must never authorize an account.
    const unobservedInactive =
      identity.state !== "active" &&
      identity.observed_at === "0001-01-01T00:00:00Z" &&
      identity.valid_until === "0001-01-01T00:00:00Z";
    if (!unobservedInactive && (age <= 0 || age > 2 * 60 * 60 * 1000)) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid identity validity interval",
      });
    }
  });

export const departmentSchema = z.strictObject({
  id,
  name: z.string(),
  revision,
  active: z.boolean(),
  head_subjects: z.array(id),
});

const eventFields = {
  cursor: cursor.min(1),
  event_id: id,
  occurred_at: timestamp,
};

export const changeSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      ...eventFields,
      type: z.literal("identity.changed"),
      subject: id,
      identity_revision: revision,
      previous_department_id: id.nullable(),
      primary_department_id: id.nullable(),
      identity: identitySchema,
    }),
    z.strictObject({
      ...eventFields,
      type: z.literal("department.changed"),
      department: departmentSchema,
    }),
  ])
  .superRefine((event, ctx) => {
    if (
      event.type === "identity.changed" &&
      (event.subject !== event.identity.sub ||
        event.identity_revision !== event.identity.identity_revision ||
        event.primary_department_id !== event.identity.primary_department_id)
    ) {
      ctx.addIssue({ code: "custom", message: "Inconsistent identity event" });
    }
  });

export const employeesPageSchema = z.strictObject({
  schema_version: z.literal(1),
  items: z.array(identitySchema).max(100),
  next_cursor: cursor,
  changes_cursor: cursor,
});
export const departmentsPageSchema = z.strictObject({
  schema_version: z.literal(1),
  items: z.array(departmentSchema).max(100),
  next_cursor: cursor,
  changes_cursor: cursor,
});
export const changesPageSchema = z.strictObject({
  schema_version: z.literal(1),
  items: z.array(changeSchema).max(100),
  next_cursor: cursor,
});

export type DirectoryIdentity = z.infer<typeof identitySchema>;
export type DirectoryDepartment = z.infer<typeof departmentSchema>;
export type DirectoryChange = z.infer<typeof changeSchema>;
export type EmployeesPage = z.infer<typeof employeesPageSchema>;
export type DepartmentsPage = z.infer<typeof departmentsPageSchema>;
export type ChangesPage = z.infer<typeof changesPageSchema>;
