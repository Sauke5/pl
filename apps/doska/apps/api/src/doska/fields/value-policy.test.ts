import { describe, expect, it } from "vite-plus/test";
import {
  normalizeFieldValue,
  planFieldValues,
  type FieldDefinition,
} from "./value-policy";
const field: FieldDefinition = {
  id: "f",
  name: "Поле",
  type: "text",
  required: false,
  defaultValue: null,
  options: null,
  archivedAt: null,
};
describe("project custom field values", () => {
  it("validates strict calendar dates and finite decimal numbers", () => {
    expect(normalizeFieldValue({ ...field, type: "date" }, "2024-02-29")).toBe(
      "2024-02-29",
    );
    for (const value of ["2025-02-29", "2026-13-01", "2026-01-01T00:00:00Z"])
      expect(() =>
        normalizeFieldValue({ ...field, type: "date" }, value),
      ).toThrow();
    for (const value of ["NaN", "Infinity", "0x12", "1e999"])
      expect(() =>
        normalizeFieldValue({ ...field, type: "number" }, value),
      ).toThrow();
    expect(normalizeFieldValue({ ...field, type: "number" }, " -1.25e2 ")).toBe(
      "-1.25e2",
    );
  });
  it("accepts false as a filled required checkbox and rejects empty required values", () => {
    expect(
      planFieldValues(
        [{ ...field, type: "boolean", required: true }],
        [],
        [{ fieldId: "f", value: "false" }],
        true,
      ),
    ).toEqual([{ fieldId: "f", value: "false" }]);
    expect(() =>
      planFieldValues([{ ...field, required: true }], [], [], true),
    ).toThrow("Заполните");
  });
  it("rejects duplicate and unknown selections and normalizes empty selection", () => {
    const choice = {
      ...field,
      type: "multiselect" as const,
      options: ["A", "B"],
    };
    expect(normalizeFieldValue(choice, '["B","A"]')).toBe('["B","A"]');
    expect(normalizeFieldValue(choice, "[]")).toBeNull();
    for (const value of ['["A","A"]', '["C"]', "[1]", "{}"])
      expect(() => normalizeFieldValue(choice, value)).toThrow();
  });
  it("leaves grandfathered missing fields alone but rejects explicitly clearing required fields", () => {
    expect(
      planFieldValues([{ ...field, required: true }], [], undefined, false),
    ).toEqual([]);
    expect(() =>
      planFieldValues(
        [{ ...field, required: true }],
        [],
        [{ fieldId: "f", value: null }],
        false,
      ),
    ).toThrow("Заполните");
  });
  it("applies defaults only on creation and keeps omitted values unchanged", () => {
    expect(
      planFieldValues(
        [{ ...field, defaultValue: "Default" }],
        [],
        undefined,
        true,
      ),
    ).toEqual([{ fieldId: "f", value: "Default" }]);
    expect(
      planFieldValues(
        [{ ...field, defaultValue: "Default" }],
        [{ fieldId: "f", value: "Existing" }],
        [],
        false,
      ),
    ).toEqual([]);
    expect(
      planFieldValues(
        [field],
        [{ fieldId: "f", value: "Existing" }],
        [{ fieldId: "f", value: null }],
        false,
      ),
    ).toEqual([{ fieldId: "f", value: null }]);
  });
  it("rejects unknown, archived and duplicate field writes", () => {
    for (const definitions of [[], [{ ...field, archivedAt: new Date() }]])
      expect(() =>
        planFieldValues(definitions, [], [{ fieldId: "f", value: "x" }], false),
      ).toThrow();
    expect(() =>
      planFieldValues(
        [field],
        [],
        [
          { fieldId: "f", value: "x" },
          { fieldId: "f", value: "y" },
        ],
        false,
      ),
    ).toThrow();
  });
  it("bounds per-value text and aggregate UTF-8 bytes including retained values", () => {
    expect(() => normalizeFieldValue(field, "x".repeat(10001))).toThrow();
    const fields = Array.from({ length: 4 }, (_, i) => ({
      ...field,
      id: `f${i}`,
    }));
    expect(() =>
      planFieldValues(
        fields,
        [],
        fields.map((item) => ({ fieldId: item.id, value: "я".repeat(5000) })),
        true,
      ),
    ).toThrow("32 КБ");
    expect(() =>
      planFieldValues(
        fields,
        [{ fieldId: "f0", value: "я".repeat(10000) }],
        [{ fieldId: "f1", value: "я".repeat(10000) }],
        false,
      ),
    ).toThrow("32 КБ");
    expect(
      planFieldValues(
        fields,
        [{ fieldId: "f0", value: "x".repeat(40000) }],
        [{ fieldId: "f0", value: null }],
        false,
      ),
    ).toEqual([{ fieldId: "f0", value: null }]);
  });
});
