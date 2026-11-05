export const customFieldTypes = [
  "text",
  "number",
  "date",
  "boolean",
  "dropdown",
  "multiselect",
  "user",
] as const;
export type CustomField = {
  id: string;
  name: string;
  type: (typeof customFieldTypes)[number];
  required: boolean;
  defaultValue: string | null;
  options: string[] | null;
  position: number;
  archivedAt: string | null;
};
export type CustomValues = { fieldId: string; value: string | null }[];
export type RequiredTaskField =
  | "description"
  | "userId"
  | "priority"
  | "startDate"
  | "due";
export type ProjectFields = {
  revision: number;
  requiredTaskFields: RequiredTaskField[];
  fields: CustomField[];
};
export type FieldPerson = { userId: string; name: string };
export function selectedOptions(value: string | null | undefined): string[] {
  try {
    const result: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(result)
      ? result.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
export function fieldEmpty(
  field: Pick<CustomField, "type">,
  value: string | null | undefined,
) {
  return (
    !value?.trim() ||
    (field.type === "multiselect" && selectedOptions(value).length === 0)
  );
}
export function fieldValue(
  field: CustomField,
  values: CustomValues,
  creating: boolean,
) {
  const saved = values.find((item) => item.fieldId === field.id);
  return saved ? saved.value : creating ? field.defaultValue : null;
}
export function patchFieldValue(
  values: CustomValues,
  fieldId: string,
  value: string | null,
): CustomValues {
  return [
    ...values.filter((item) => item.fieldId !== fieldId),
    { fieldId, value },
  ].sort((a, b) => a.fieldId.localeCompare(b.fieldId));
}
