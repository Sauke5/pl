import { z } from "zod";
const selection = z.strictObject({
  resourceId: z.string().uuid(),
  sourceKind: z.enum(["platform", "netbox"]),
});
export const descriptor = z.strictObject({
  displayName: z.string().min(1).max(256),
  objectKind: z.enum(["service", "resource", "device", "virtual_machine"]),
  site: z.string().max(128).optional(),
  platformHref: z
    .string()
    .regex(
      /^\/#catalog\?resourceId=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    .optional(),
  sourceObservedAt: z.string().optional(),
  stale: z.boolean().optional(),
});
export const resourceSearchSchema = z.strictObject({
  version: z.literal(1),
  items: z
    .array(
      z.strictObject({
        displayName: z.string().min(1).max(256),
        objectKind: z.enum([
          "service",
          "resource",
          "device",
          "virtual_machine",
        ]),
        selection,
      }),
    )
    .max(50),
  nextCursor: z.string().max(512).nullable(),
});
export const resourceLinksSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  links: z
    .array(
      z.discriminatedUnion("available", [
        z.strictObject({
          linkId: z.string(),
          available: z.literal(true),
          descriptor,
        }),
        z.strictObject({ linkId: z.string(), available: z.literal(false) }),
      ]),
    )
    .max(32),
});
export const resourceMutationSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  linkId: z.string(),
});
export type ResourceSelection = z.infer<typeof selection>;
export type ResourceLinks = z.infer<typeof resourceLinksSchema>;
export type ResourceSearch = z.infer<typeof resourceSearchSchema>;
export type ResourceMutation = {
  expectedRevision: number;
  clientRequestId: string;
} & (
  | { operation: "attach"; selection: ResourceSelection }
  | { operation: "detach"; linkId: string }
);
