import { describe, expect, it } from "vite-plus/test";
import type { Column, CreateTaskInput } from "./api";
import type { CustomField, ProjectFields } from "./custom-fields";
import { importTaskIssues } from "./task-import-validation";
const columns = [{ id: "planned" }] as Column[];
const people = [{ userId: "owner", name: "Owner" }];
const base: CreateTaskInput = { title: "Task", columnId: "planned" };
const fields: ProjectFields = {
  revision: 0,
  requiredTaskFields: [],
  fields: [],
};
const check = (task: CreateTaskInput, definitions = fields) =>
  importTaskIssues(task, definitions, columns, people);
function field(
  type: CustomField["type"],
  extra: Partial<CustomField> = {},
): CustomField {
  return {
    id: "f",
    name: "Field",
    type,
    required: true,
    defaultValue: null,
    options: ["a", "b"],
    position: 0,
    archivedAt: null,
    ...extra,
  };
}
describe("Import preview validation", () => {
  it("accepts minimal staged tasks, same-day deadlines and optional nulls", () => {
    expect(
      check({
        ...base,
        description: null,
        userId: null,
        startDate: "2028-02-29",
        due: { date: "2028-02-29", time: "00:00" },
      }),
    ).toEqual([]);
  });
  it("reports malformed runtime values and calendar dates without throwing", () => {
    expect(
      check({
        ...base,
        title: 42,
        description: [],
        priority: "bad",
        startDate: "2027-02-29",
        due: "tomorrow",
      } as unknown as CreateTaskInput),
    ).toEqual([
      { field: "title", reason: "invalid" },
      { field: "description", reason: "invalid" },
      { field: "priority", reason: "invalid" },
      { field: "startDate", reason: "invalid" },
      { field: "due", reason: "invalid" },
    ]);
    for (const startDate of [
      "0000-01-01",
      "2026-13-01",
      "2026-01-32",
      "2026-1-01",
    ])
      expect(check({ ...base, startDate })).toContainEqual({
        field: "startDate",
        reason: "invalid",
      });
    expect(
      check({ ...base, startDate: "2026-10-27", due: { date: "2026-10-26" } }),
    ).toEqual([{ field: "due", reason: "date_order" }]);
  });
  it("requires mapped columns and current project participants", () => {
    expect(check({ ...base, columnId: "", userId: "observer" })).toEqual([
      { field: "columnId", reason: "required" },
      { field: "userId", reason: "invalid" },
    ]);
    expect(check({ ...base, columnId: "other" })).toContainEqual({
      field: "columnId",
      reason: "invalid",
    });
  });
  it("enforces standard required fields and lengths", () => {
    expect(
      check(
        { ...base, priority: "no-priority" },
        {
          ...fields,
          requiredTaskFields: [
            "description",
            "userId",
            "priority",
            "startDate",
            "due",
          ],
        },
      ),
    ).toHaveLength(5);
    expect(
      check({
        ...base,
        title: "x".repeat(501),
        description: "x".repeat(100001),
      }),
    ).toHaveLength(2);
  });
  it.each([
    ["text", "hello", "x".repeat(10001)],
    ["number", "-1.25e+2", "1e999"],
    ["date", "2028-02-29", "2027-02-29"],
    ["boolean", "false", "yes"],
    ["dropdown", "a", "c"],
    ["multiselect", '["a","b"]', '["a","a"]'],
    ["user", "owner", "observer"],
  ] as const)("validates %s using server semantics", (type, valid, invalid) => {
    const project = { ...fields, fields: [field(type)] };
    expect(
      check(
        { ...base, customValues: [{ fieldId: "f", value: valid }] },
        project,
      ),
    ).toEqual([]);
    expect(
      check(
        { ...base, customValues: [{ fieldId: "f", value: invalid }] },
        project,
      ),
    ).toEqual([{ field: "f", reason: "invalid" }]);
  });
  it("uses defaults only for omitted values and rejects missing required multiselect", () => {
    const project = {
      ...fields,
      fields: [field("boolean", { defaultValue: "false" })],
    };
    expect(check(base, project)).toEqual([]);
    expect(
      check(
        { ...base, customValues: [{ fieldId: "f", value: null }] },
        project,
      ),
    ).toEqual([{ field: "f", reason: "required" }]);
    expect(
      check(
        { ...base, customValues: [{ fieldId: "f", value: "[]" }] },
        { ...fields, fields: [field("multiselect")] },
      ),
    ).toEqual([{ field: "f", reason: "required" }]);
  });
  it("rejects unknown, duplicate and archived fields and total byte excess", () => {
    expect(
      check({ ...base, customValues: [{ fieldId: "unknown", value: "x" }] }),
    ).toEqual([{ field: "unknown", reason: "invalid" }]);
    expect(
      check(
        {
          ...base,
          customValues: [
            { fieldId: "f", value: "x" },
            { fieldId: "f", value: "y" },
          ],
        },
        { ...fields, fields: [field("text")] },
      ),
    ).toEqual([{ field: "f", reason: "invalid" }]);
    expect(
      check(
        { ...base, customValues: [{ fieldId: "f", value: "x" }] },
        { ...fields, fields: [field("text", { archivedAt: "2026-01-01" })] },
      ),
    ).toEqual([{ field: "f", reason: "invalid" }]);
    const defs = ["a", "b"].map((id) =>
      field("text", { id, defaultValue: "я".repeat(9000) }),
    );
    expect(check(base, { ...fields, fields: defs })).toHaveLength(2);
  });
});
