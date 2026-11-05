import { expect, it } from "vite-plus/test";
import {
  fieldEmpty,
  fieldValue,
  patchFieldValue,
  selectedOptions,
  type CustomField,
} from "./custom-fields";
const field = {
  id: "f",
  name: "Ready",
  type: "boolean",
  required: true,
  defaultValue: "false",
  options: null,
  position: 0,
  archivedAt: null,
} satisfies CustomField;
it("treats explicit false and zero as filled values and an empty multiselect as missing", () => {
  expect(fieldEmpty(field, "false")).toBe(false);
  expect(fieldEmpty({ type: "number" }, "0")).toBe(false);
  expect(fieldEmpty({ type: "multiselect" }, "[]")).toBe(true);
});
it("uses defaults only for new tasks and preserves an explicit clear", () => {
  expect(fieldValue(field, [], true)).toBe("false");
  expect(fieldValue(field, [], false)).toBeNull();
  expect(fieldValue(field, [{ fieldId: "f", value: null }], true)).toBeNull();
});
it("changes one field while preserving other values", () => {
  expect(
    patchFieldValue(
      [
        { fieldId: "a", value: "Keep" },
        { fieldId: "f", value: "true" },
      ],
      "f",
      null,
    ),
  ).toEqual([
    { fieldId: "a", value: "Keep" },
    { fieldId: "f", value: null },
  ]);
  expect(selectedOptions('["one",4,"two"]')).toEqual(["one", "two"]);
});
