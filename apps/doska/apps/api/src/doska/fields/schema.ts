import { z, nullableResponseTimestamp } from "../../openapi";
import { fieldTypes } from "./value-policy";
export const requiredTaskFields = [
  "description",
  "userId",
  "priority",
  "startDate",
  "due",
] as const;
const revision = z.number().int().min(0).max(2_147_483_646);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const options = z
  .array(z.string().trim().min(1).max(200))
  .max(100)
  .refine(
    (values) => new Set(values).size === values.length,
    "Duplicate options",
  );
const fields = {
  name: z.string().trim().min(1).max(200),
  type: z.enum(fieldTypes),
  required: z.boolean().optional().default(false),
  defaultValue: z
    .string()
    .max(10_000, "Не больше 10 000 символов")
    .nullable()
    .optional()
    .default(null),
  options: options.nullable().optional().default(null),
};
export const createFieldBody = z.strictObject({
  expectedRevision: revision,
  ...fields,
});
export const updateFieldBody = z
  .strictObject({
    expectedRevision: revision,
    name: fields.name.optional(),
    required: z.boolean().optional(),
    defaultValue: z
      .string()
      .max(10_000, "Не больше 10 000 символов")
      .nullable()
      .optional(),
    options: options.nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 1, "No changes supplied");
export const reorderFieldsBody = z.strictObject({
  expectedRevision: revision,
  fieldIds: z
    .array(id)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate field"),
});
export const fieldSettingsBody = z.strictObject({
  expectedRevision: revision,
  requiredTaskFields: z
    .array(z.enum(requiredTaskFields))
    .max(5)
    .refine(
      (keys) => new Set(keys).size === keys.length,
      "Duplicate required field",
    ),
});
export const fieldParams = z.strictObject({ id, fieldId: id });
export const customValuesSchema = z
  .array(
    z.strictObject({
      fieldId: id,
      value: z.string().max(10_000, "Не больше 10 000 символов").nullable(),
    }),
  )
  .max(100)
  .refine(
    (values) =>
      new Set(values.map((value) => value.fieldId)).size === values.length,
    "Duplicate field",
  );
export const fieldResponse = z.strictObject({
  id,
  name: fields.name,
  type: z.enum(fieldTypes),
  required: z.boolean(),
  defaultValue: z.string().nullable(),
  options: z.array(z.string()).nullable(),
  position: z.number().int(),
  archivedAt: nullableResponseTimestamp,
});
export const fieldsResponse = z.strictObject({
  revision: z.number().int(),
  requiredTaskFields: z.array(z.enum(requiredTaskFields)),
  fields: z.array(fieldResponse),
});

export const customValuesResponse = z.array(
  z.strictObject({ fieldId: z.string(), value: z.string().nullable() }),
);
