import { describe, expect, it } from "vite-plus/test";
import { saveTemplateBody, templateSnapshotSchema } from "./schema";
const valid = {
  version: 1,
  columns: [
    {
      key: "c1",
      name: "Planned",
      slug: "planned",
      semanticState: "planned",
      color: null,
      icon: null,
      position: 0,
    },
  ],
  tasks: [
    {
      key: "t1",
      title: "Work",
      description: null,
      priority: "low",
      columnKey: "c1",
      parentKey: null,
      position: 0,
      checklists: [],
    },
  ],
  relations: [],
};
describe("template contracts", () => {
  it("rejects source assignments, scheduling and unknown snapshot versions", () => {
    expect(templateSnapshotSchema.safeParse(valid).success).toBe(true);
    for (const field of ["userId", "dueDate", "sourceProjectId", "attachments"])
      expect(
        templateSnapshotSchema.safeParse({
          ...valid,
          tasks: [{ ...valid.tasks[0], [field]: "private" }],
        }).success,
      ).toBe(false);
    expect(
      templateSnapshotSchema.safeParse({ ...valid, version: 2 }).success,
    ).toBe(false);
  });
  it("rejects missing references and reused column keys", () => {
    expect(
      templateSnapshotSchema.safeParse({
        ...valid,
        columns: [...valid.columns, ...valid.columns],
      }).success,
    ).toBe(false);
    expect(
      templateSnapshotSchema.safeParse({
        ...valid,
        tasks: [{ ...valid.tasks[0], columnKey: "c2" }],
      }).success,
    ).toBe(false);
    expect(
      templateSnapshotSchema.safeParse({
        ...valid,
        tasks: [{ ...valid.tasks[0], parentKey: "t1" }],
      }).success,
    ).toBe(false);
    expect(
      templateSnapshotSchema.safeParse({
        ...valid,
        relations: [{ sourceKey: "t1", targetKey: "t2", type: "blocks" }],
      }).success,
    ).toBe(false);
  });
  it("defaults to a personal snapshot and requires a revision for updates", () => {
    const input = {
      sourceProjectId: "source",
      fingerprint: "a".repeat(64),
      name: " Work ",
    };
    expect(saveTemplateBody.parse(input)).toMatchObject({
      name: "Work",
      visibility: "private",
    });
    expect(
      saveTemplateBody.safeParse({ ...input, templateId: "saved" }).success,
    ).toBe(false);
    expect(
      saveTemplateBody.safeParse({ ...input, expectedRevision: 0 }).success,
    ).toBe(false);
    expect(
      saveTemplateBody.safeParse({
        ...input,
        templateId: "saved",
        expectedRevision: 0,
      }).success,
    ).toBe(true);
  });
});
