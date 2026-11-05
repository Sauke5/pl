import { z, responseTimestamp } from "../../openapi";
import { projectParams } from "../projects/schema";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z.number().int().min(0).max(2_147_483_646);
const fields = {
  name: z.string().trim().min(1).max(100),
  semanticState: z.enum(["planned", "active", "completed"]),
  color: z.string().max(64).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
};
export const columnParams = projectParams.extend({ columnId: id });
export const createColumnBody = z.strictObject({
  ...fields,
  expectedRevision: revision,
});
export const updateColumnBody = z
  .strictObject({
    ...fields,
    name: fields.name.optional(),
    semanticState: fields.semanticState.optional(),
    expectedRevision: revision,
    confirmIncompleteSubtasks: z.boolean().optional(),
  })
  .refine(
    (body) =>
      Object.keys(body).some(
        (key) =>
          key !== "expectedRevision" && key !== "confirmIncompleteSubtasks",
      ),
    "No changes supplied",
  );
export const reorderColumnsBody = z.strictObject({
  expectedRevision: revision,
  columnIds: z
    .array(id)
    .min(1)
    .max(1000)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate column"),
});
export const deleteColumnBody = z.strictObject({
  expectedRevision: revision,
  destinationColumnId: id.optional(),
  confirmIncompleteSubtasks: z.boolean().optional(),
});
export const columnResponse = z.strictObject({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  slug: z.string(),
  position: z.number(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
  semanticState: fields.semanticState.nullable(),
  isFinal: z.boolean(),
  createdAt: responseTimestamp,
  updatedAt: responseTimestamp,
});
export const columnsMutationResponse = z.strictObject({
  revision: z.number(),
  columns: z.array(columnResponse),
});
