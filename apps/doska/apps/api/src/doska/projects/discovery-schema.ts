import { z } from "../../openapi";
import { pageQuery } from "./member-schema";
import { managementMetadata } from "./schema";

const search = z.string().trim().max(200).optional();
export const projectListQuery = pageQuery.extend({
  q: search,
  archived: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});
export const employeeOptionsQuery = pageQuery.extend({
  q: search,
  purpose: z.enum(["invitation", "ownership"]),
});
export const projectListItem = managementMetadata.extend({
  slug: z.string(),
  icon: z.string().nullable(),
  description: z.string().nullable(),
  departmentId: z.string(),
  visibility: z.enum(["department", "private"]),
});
export const employeeOption = z.strictObject({
  userId: z.string(),
  name: z.string(),
  departmentId: z.string().nullable(),
});
