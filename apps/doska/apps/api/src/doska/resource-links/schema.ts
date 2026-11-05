import { z } from "../../openapi";
import { createTaskBody } from "../tasks/schema";
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const resourceRef = z.union([
  z.strictObject({
    version: z.literal(1),
    source: z.literal("platform"),
    type: z.literal("resource"),
    id: uuid,
  }),
  z.strictObject({
    version: z.literal(1),
    source: z
      .string()
      .regex(
        /^netbox\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    type: z.enum(["dcim.device", "virtualization.virtualmachine"]),
    id: z
      .string()
      .regex(/^[1-9][0-9]{0,9}$/)
      .refine((value) => Number(value) <= 2147483647),
  }),
]);
export type ResourceRef = z.infer<typeof resourceRef>;
export const linkParams = z.strictObject({ id, taskId: id });
export const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const mutationBody = z.strictObject({
  version: z.literal(1),
  expectedRevision: revision,
  clientRequestId: uuid,
});
export const attachBody = mutationBody.extend({ ref: resourceRef });
export const createBody = attachBody.extend({
  expectedRevision: z.literal(0),
  task: createTaskBody,
});
export const backrefsBody = z.strictObject({
  version: z.literal(1),
  ref: resourceRef,
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().max(512).nullable().optional(),
});
export const mutationResponse = z.strictObject({
  version: z.literal(1),
  revision,
  linkId: id,
});
export const createResponse = mutationResponse.extend({
  taskId: id,
  projectId: id,
  href: z.string(),
});
export const linksResponse = z.strictObject({
  version: z.literal(1),
  revision,
  links: z.array(z.strictObject({ linkId: id, ref: resourceRef })).max(32),
});
export const backrefsResponse = z.strictObject({
  version: z.literal(1),
  items: z
    .array(
      z.strictObject({
        projectId: id,
        taskId: id,
        title: z.string(),
        href: z.string(),
      }),
    )
    .max(50),
  nextCursor: z.string().nullable(),
});
