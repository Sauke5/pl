import { z, nullableResponseTimestamp } from "../../openapi";

const name = z.string().trim().min(1).max(200);
const icon = z.string().min(1).max(64).default("Layout");
const visibility = z.enum(["department", "private"]);
const revision = z.number().int().min(0).max(2_147_483_646);
export const projectParams = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});
export const createProjectBody = z.strictObject({
  name,
  icon,
  visibility,
  slug: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{0,19}$/),
  description: z.string().max(20_000).optional(),
});
export const updateProjectBody = z
  .strictObject({
    expectedRevision: revision,
    name: name.optional(),
    icon: z.string().min(1).max(64).optional(),
    description: z.string().max(20_000).nullable().optional(),
    visibility: visibility.optional(),
  })
  .refine(
    (body) => Object.keys(body).some((key) => key !== "expectedRevision"),
    "No changes supplied",
  );
export const archiveProjectBody = z.strictObject({
  expectedRevision: revision,
  archived: z.boolean(),
});
export const transferProjectBody = z.strictObject({
  expectedRevision: revision,
  newOwnerUserId: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/),
});
export const managementMetadata = z.strictObject({
  id: z.string(),
  name: z.string(),
  ownerUserId: z.string(),
  archivedAt: nullableResponseTimestamp,
  revision: z.number().int(),
});
