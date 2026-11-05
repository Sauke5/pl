import { z } from "../../openapi";
import { pageQuery } from "../projects/member-schema";
import { cardColors } from "../tasks/card-color";
export const labelInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  color: z
    .union([z.enum(cardColors), z.string().regex(/^#[0-9a-fA-F]{6}$/)])
    .transform((value) => value.toLowerCase()),
});
export const taskLabelsSchema = z
  .array(labelInputSchema)
  .max(20)
  .refine(
    (labels) =>
      new Set(labels.map((label) => label.name)).size === labels.length,
    "Duplicate label",
  );
export const labelResponse = z.strictObject({
  name: z.string(),
  color: z.string(),
});
export const labelsQuery = pageQuery.extend({
  q: z.string().trim().max(100).optional(),
});

export const taskLabelsPatchSchema = z
  .array(labelInputSchema.extend({ color: z.string().max(1000) }))
  .max(20)
  .refine(
    (labels) =>
      new Set(labels.map((label) => label.name)).size === labels.length,
    "Duplicate label",
  );
