import { describe, expect, it } from "vite-plus/test";
import { materializeTemplate } from "./materialize";
import type { TemplateSnapshot } from "./snapshot";
const snapshot: TemplateSnapshot = {
  version: 1,
  columns: [
    {
      key: "done",
      name: "Готово",
      slug: "done",
      semanticState: "completed",
      color: null,
      icon: null,
      position: 0,
    },
    {
      key: "planned2",
      name: "Позже",
      slug: "later",
      semanticState: "planned",
      color: null,
      icon: null,
      position: 2,
    },
    {
      key: "planned",
      name: "Запланировано",
      slug: "planned",
      semanticState: "planned",
      color: null,
      icon: null,
      position: 1,
    },
  ],
  tasks: [
    {
      key: "parent",
      title: "Parent",
      description: "Instructions",
      priority: "high",
      columnKey: "done",
      parentKey: null,
      position: 8,
      checklists: [{ title: "Steps", items: [{ text: "Do it", done: false }] }],
    },
    {
      key: "child",
      title: "Child",
      description: null,
      priority: "low",
      columnKey: "done",
      parentKey: "parent",
      position: 8,
      checklists: [],
    },
  ],
  relations: [{ sourceKey: "parent", targetKey: "child", type: "blocks" }],
};
describe("template materialization", () => {
  it("creates independent rows in the first planned column with empty assignments and dates", () => {
    const first = materializeTemplate(snapshot, "new-project", true);
    const second = materializeTemplate(snapshot, "other-project", true);
    expect(first.lastTaskNumber).toBe(2);
    const planned = first.columns.find((column) => column.slug === "planned")!;
    expect(first.tasks.map((task) => task.columnId)).toEqual([
      planned.id,
      planned.id,
    ]);
    expect(first.tasks.map((task) => task.number)).toEqual([1, 2]);
    expect(first.tasks.map((task) => task.position)).toEqual([0, 1]);
    expect(first.tasks[1]!.parentTaskId).toBe(first.tasks[0]!.id);
    expect(first.relations[0]).toMatchObject({
      sourceTaskId: first.tasks[0]!.id,
      targetTaskId: first.tasks[1]!.id,
      relationType: "doska.blocks",
    });
    expect(first.items[0]).toMatchObject({
      checklistId: first.checklists[0]!.id,
      done: false,
    });
    for (const task of first.tasks) {
      expect(task).toMatchObject({
        projectId: "new-project",
        userId: null,
        startDate: null,
        dueDate: null,
        archivedAt: null,
        revision: 0,
        status: "planned",
      });
      expect(second.tasks.some((other) => other.id === task.id)).toBe(false);
    }
  });
  it("can create structure only without any tasks or links", () => {
    const result = materializeTemplate(snapshot, "new", false);
    expect(result.columns).toHaveLength(3);
    expect(result.tasks).toEqual([]);
    expect(result.items).toEqual([]);
    expect(result.relations).toEqual([]);
    expect(result.lastTaskNumber).toBe(0);
  });
  it("rejects typified tasks without a planned column", () => {
    expect(() =>
      materializeTemplate(
        {
          ...snapshot,
          columns: snapshot.columns.filter(
            (column) => column.semanticState !== "planned",
          ),
        },
        "new",
        true,
      ),
    ).toThrow("planned column");
  });
  it("rejects dangling links and nested parents", () => {
    expect(() =>
      materializeTemplate(
        {
          ...snapshot,
          relations: [
            { sourceKey: "parent", targetKey: "missing", type: "related" },
          ],
        },
        "new",
        true,
      ),
    ).toThrow("relation");
    expect(() =>
      materializeTemplate(
        {
          ...snapshot,
          tasks: snapshot.tasks.map((task) => ({
            ...task,
            parentKey: "child",
          })),
        },
        "new",
        true,
      ),
    ).toThrow("parent");
  });
});

it("keeps incomplete typical tasks and never restores employee defaults or values", () => {
  const rows = materializeTemplate(
    {
      ...snapshot,
      customFields: [
        {
          key: "f1",
          name: "Employee",
          type: "user",
          required: true,
          defaultValue: "pl:secret",
          options: null,
          position: 0,
        },
        {
          key: "f2",
          name: "Required later",
          type: "text",
          required: true,
          defaultValue: null,
          options: null,
          position: 1,
        },
      ],
      tasks: snapshot.tasks.map((task) => ({
        ...task,
        customValues: [{ fieldKey: "f1", value: "pl:another-secret" }],
      })),
    },
    "new-project",
    true,
  );
  expect(rows.tasks).toHaveLength(2);
  expect(rows.customFields[0]?.defaultValue).toBeNull();
  expect(rows.customValues).toEqual([]);
  expect(JSON.stringify(rows)).not.toContain("pl:");
});
