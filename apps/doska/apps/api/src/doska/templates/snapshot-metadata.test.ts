import { describe, expect, it } from "vite-plus/test";
import { buildTemplateMetadata } from "./snapshot-metadata";

type Input = Parameters<typeof buildTemplateMetadata>[0];
const field = (
  overrides: Partial<Input["fields"][number]> = {},
): Input["fields"][number] => ({
  id: "source-field",
  projectId: "project",
  name: "Category",
  type: "dropdown",
  required: false,
  defaultValue: "One",
  options: ["One", "Two"],
  position: 0,
  ...overrides,
});
const input = (overrides: Partial<Input> = {}): Input => ({
  projectId: "project",
  fields: [field()],
  values: [],
  labels: [],
  taskKeys: new Map([["source-task", "t1"]]),
  ...overrides,
});
describe("template snapshot metadata", () => {
  it("whitelists selected task metadata, remaps IDs, sorts fields and freezes copied options", () => {
    const options = ["One", "Two"];
    const source = input({
      fields: [
        field({ id: "source-z", options }),
        field({
          id: "source-a",
          type: "text",
          options: null,
          defaultValue: null,
        }),
      ],
      values: [
        { taskId: "source-task", fieldId: "source-z", value: "Two" },
        { taskId: "private-task", fieldId: "unknown", value: "secret" },
      ],
      labels: [
        {
          id: "source-label",
          taskId: "source-task",
          name: "Important",
          color: "red",
          deletionStartedAt: null,
        },
        {
          id: "workspace-label",
          taskId: null,
          name: "Workspace",
          color: "blue",
          deletionStartedAt: null,
        },
        {
          id: "private-label",
          taskId: "private-task",
          name: "Secret",
          color: "blue",
          deletionStartedAt: null,
        },
        {
          id: "deleted-label",
          taskId: "source-task",
          name: "Deleted",
          color: "blue",
          deletionStartedAt: new Date(),
        },
      ],
    });
    const result = buildTemplateMetadata(source);
    expect(result.customFields.map((f) => [f.key, f.type])).toEqual([
      ["f1", "text"],
      ["f2", "dropdown"],
    ]);
    expect(result.taskMetadata.t1).toEqual({
      labels: [{ name: "Important", color: "red" }],
      customValues: [{ fieldKey: "f2", value: "Two" }],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /source-|private-|secret|Workspace|Deleted|projectId|taskId|fieldId/,
    );
    options.push("Three");
    expect(result.customFields[1]?.options).toEqual(["One", "Two"]);
    expect(Object.isFrozen(result.customFields[1]?.options)).toBe(true);
    expect(Object.isFrozen(result.taskMetadata.t1?.customValues[0])).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it("allows required definitions without defaults or task values", () => {
    const result = buildTemplateMetadata(
      input({ fields: [field({ required: true, defaultValue: null })] }),
    );
    expect(result.customFields[0]?.required).toBe(true);
    expect(result.customFields[0]?.defaultValue).toBeNull();
    expect(result.taskMetadata.t1?.customValues).toEqual([]);
  });
  it.each([
    ["text", "hello"],
    ["number", "-12.5e2"],
    ["date", "2024-02-29"],
    ["boolean", "false"],
    ["dropdown", "Two"],
    ["multiselect", '["One","Two"]'],
  ])("accepts valid %s defaults and values", (type, value) => {
    const result = buildTemplateMetadata(
      input({
        fields: [field({ type, defaultValue: value })],
        values: [{ taskId: "source-task", fieldId: "source-field", value }],
      }),
    );
    expect(result.taskMetadata.t1?.customValues[0]?.value).toBe(value);
  });
  it.each([
    ["number", "Infinity"],
    ["number", "12oops"],
    ["date", "2025-02-29"],
    ["boolean", "yes"],
    ["multiselect", '["One","One"]'],
    ["multiselect", "{}"],
  ])("rejects invalid %s defaults and selected values: %s", (type, value) => {
    expect(() =>
      buildTemplateMetadata(
        input({ fields: [field({ type, defaultValue: value })] }),
      ),
    ).toThrow();
    expect(() =>
      buildTemplateMetadata(
        input({
          fields: [field({ type, defaultValue: null })],
          values: [{ taskId: "source-task", fieldId: "source-field", value }],
        }),
      ),
    ).toThrow();
  });
  it("rejects unknown fields, foreign definitions, duplicates and malformed options", () => {
    expect(() =>
      buildTemplateMetadata(
        input({
          values: [{ taskId: "source-task", fieldId: "unknown", value: null }],
        }),
      ),
    ).toThrow();
    expect(() =>
      buildTemplateMetadata(
        input({ fields: [field({ projectId: "foreign" })] }),
      ),
    ).toThrow();
    expect(() =>
      buildTemplateMetadata(input({ fields: [field(), field()] })),
    ).toThrow();
    for (const options of [
      ["One", "One"],
      [""],
      [1],
      { privateId: "secret" },
      null,
    ]) {
      expect(() =>
        buildTemplateMetadata(input({ fields: [field({ options })] })),
      ).toThrow();
    }
    expect(() =>
      buildTemplateMetadata(
        input({ fields: [field({ type: "unsupported" })] }),
      ),
    ).toThrow();
  });
});

it("excludes archived fields and employee identities from published snapshots", () => {
  const result = buildTemplateMetadata(
    input({
      fields: [
        field({
          id: "employee",
          type: "user",
          required: true,
          options: null,
          defaultValue: "pl:private",
        }),
        field({ id: "old", archivedAt: new Date() }),
      ],
      values: [
        {
          taskId: "source-task",
          fieldId: "employee",
          value: "pl:another-private",
        },
        { taskId: "source-task", fieldId: "old", value: "Two" },
      ],
    }),
  );
  expect(result.customFields).toHaveLength(1);
  expect(result.customFields[0]).toMatchObject({
    type: "user",
    required: true,
    defaultValue: null,
  });
  expect(result.taskMetadata.t1?.customValues).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("pl:");
});

it("accepts one-option multiselect fields in templates", () => {
  const result = buildTemplateMetadata(
    input({
      fields: [
        field({
          type: "multiselect",
          options: ["One"],
          defaultValue: '["One"]',
        }),
      ],
    }),
  );
  expect(result.customFields[0]?.options).toEqual(["One"]);
});
it.each(["dropdown", "multiselect"])(
  "preserves only selected historical %s choices in stable order",
  (type) => {
    const values = [
      {
        taskId: "source-task",
        fieldId: "source-field",
        value: type === "dropdown" ? "Removed" : '["Removed","Another"]',
      },
      {
        taskId: "private-task",
        fieldId: "source-field",
        value: type === "dropdown" ? "Private" : '["Private"]',
      },
    ];
    const source = input({
      fields: [field({ type, defaultValue: null })],
      values,
    });
    const result = buildTemplateMetadata(source);
    expect(result.customFields[0]?.options).toEqual(
      type === "dropdown"
        ? ["One", "Two", "Removed"]
        : ["One", "Two", "Another", "Removed"],
    );
    expect(result).toEqual(
      buildTemplateMetadata({ ...source, values: [...values].reverse() }),
    );
    expect(result.taskMetadata.t1?.customValues[0]?.value).toBe(
      values[0]!.value,
    );
    expect(source.fields[0]?.options).toEqual(["One", "Two"]);
  },
);
it("rejects invalid choice defaults and oversized historical choices", () => {
  for (const type of ["dropdown", "multiselect"]) {
    expect(() =>
      buildTemplateMetadata(
        input({
          fields: [
            field({
              type,
              defaultValue: type === "dropdown" ? "Unknown" : '["Unknown"]',
            }),
          ],
        }),
      ),
    ).toThrow();
  }
  for (const options of [
    Array.from({ length: 200 }, (_, i) => String(i)),
    ["One"],
  ]) {
    expect(() =>
      buildTemplateMetadata(
        input({
          fields: [field({ defaultValue: null, options })],
          values: [
            {
              taskId: "source-task",
              fieldId: "source-field",
              value: options.length === 200 ? "Extra" : "x".repeat(2001),
            },
          ],
        }),
      ),
    ).toThrow(/Template choices exceed limits/);
  }
});
