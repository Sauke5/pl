import { describe, expect, it } from "vite-plus/test";
import {
  buildTemplateSnapshot,
  TemplateSnapshotError,
  type TemplateSnapshotInput,
} from "./snapshot";
function source() {
  return {
    projectId: "source-project-private",
    columns: [
      {
        id: "source-done",
        projectId: "source-project-private",
        name: "Done",
        slug: "done",
        semanticState: "completed" as const,
        isFinal: true,
        color: "green",
        icon: "check",
        position: 2,
      },
      {
        id: "source-todo",
        projectId: "source-project-private",
        name: "Todo",
        slug: "todo",
        semanticState: "planned" as const,
        isFinal: false,
        color: null,
        icon: null,
        position: 0,
      },
    ],
    allTasks: [
      {
        id: "source-parent",
        projectId: "source-project-private",
        title: "Parent",
        description: "Instructions",
        priority: "high",
        columnId: "source-todo",
        parentTaskId: null,
        position: 5,
        archivedAt: null,
        userId: "private-user",
        coexecutorIds: ["private-helper"],
        dueDate: new Date(),
        startDate: new Date(),
        comments: ["private-comment"],
        history: ["private-history"],
        attachments: ["private-attachment"],
        revision: 99,
        number: 43,
      },
      {
        id: "source-child",
        projectId: "source-project-private",
        title: "Child",
        description: null,
        priority: "low",
        columnId: "source-done",
        parentTaskId: "source-parent",
        position: 1,
        archivedAt: null,
      },
      {
        id: "source-other",
        projectId: "source-project-private",
        title: "Not selected",
        description: null,
        priority: "medium",
        columnId: "source-todo",
        parentTaskId: null,
        position: 9,
        archivedAt: null,
      },
      {
        id: "source-archived",
        projectId: "source-project-private",
        title: "Archived child",
        description: null,
        priority: "low",
        columnId: "source-todo",
        parentTaskId: "source-parent",
        position: 10,
        archivedAt: new Date(),
      },
    ],
    selectedTaskIds: ["source-parent"],
    checklists: [
      {
        id: "source-list",
        taskId: "source-parent",
        title: "Prepare",
        position: 1,
      },
      {
        id: "source-private-list",
        taskId: "source-other",
        title: "Excluded",
        position: 0,
      },
    ],
    checklistItems: [
      {
        id: "source-item-2",
        checklistId: "source-list",
        text: "Second",
        position: 2,
        done: true,
      },
      {
        id: "source-item-1",
        checklistId: "source-list",
        text: "First",
        position: 0,
        done: true,
      },
      {
        id: "source-private-item",
        checklistId: "source-private-list",
        text: "Excluded",
        position: 0,
        done: true,
      },
    ],
    relations: [
      {
        sourceTaskId: "source-parent",
        targetTaskId: "source-child",
        relationType: "doska.blocks",
      },
      {
        sourceTaskId: "source-other",
        targetTaskId: "source-parent",
        relationType: "doska.related",
      },
      {
        sourceTaskId: "external-private-task",
        targetTaskId: "source-child",
        relationType: "doska.duplicate",
      },
    ],
  };
}
describe("template snapshot", () => {
  it("whitelists reusable fields and excludes private source metadata", () => {
    const { snapshot, expandedTaskIds } = buildTemplateSnapshot(source());
    expect(snapshot.version).toBe(1);
    expect(expandedTaskIds).toEqual(["source-child", "source-parent"]);
    expect(snapshot.tasks.map((task) => task.title)).toEqual([
      "Child",
      "Parent",
    ]);
    const parent = snapshot.tasks.find((task) => task.title === "Parent")!;
    expect(Object.keys(parent).sort()).toEqual(
      [
        "key",
        "title",
        "description",
        "priority",
        "cardColor",
        "columnKey",
        "parentKey",
        "position",
        "checklists",
      ].sort(),
    );
    expect(parent.checklists).toEqual([
      {
        title: "Prepare",
        items: [
          { text: "First", done: false },
          { text: "Second", done: false },
        ],
      },
    ]);
    const json = JSON.stringify(snapshot);
    for (const value of [
      "source-",
      "private-",
      "dueDate",
      "startDate",
      "coexecutorIds",
      "userId",
      "comments",
      "history",
      "attachments",
      "revision",
      "number",
      "Archived child",
      "Not selected",
    ])
      expect(json).not.toContain(value);
  });
  it("remaps graph edges to local ordinal keys and preserves blocking direction", () => {
    const { snapshot } = buildTemplateSnapshot(source());
    expect(snapshot.columns.map((column) => column.key)).toEqual(["c1", "c2"]);
    expect(snapshot.tasks[0]!).toMatchObject({
      key: "t1",
      columnKey: "c2",
      parentKey: "t2",
    });
    expect(snapshot.tasks[1]!).toMatchObject({
      key: "t2",
      columnKey: "c1",
      parentKey: null,
    });
    expect(snapshot.relations).toEqual([
      { type: "blocks", sourceKey: "t2", targetKey: "t1" },
    ]);
  });
  it("makes a child selected without its parent standalone", () => {
    const input = source();
    input.selectedTaskIds = ["source-child"];
    const { snapshot } = buildTemplateSnapshot(input);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]!.parentKey).toBeNull();
    expect(snapshot.relations).toEqual([]);
  });
  it("rejects archived, unknown and foreign selections", () => {
    for (const id of ["source-archived", "unknown"]) {
      const input = source();
      input.selectedTaskIds = [id];
      expect(() => buildTemplateSnapshot(input)).toThrow(TemplateSnapshotError);
    }
    const input = source();
    input.allTasks[0]!.projectId = "foreign-project";
    expect(() => buildTemplateSnapshot(input)).toThrow("one project");
  });
  it("is deterministic across input ordering and duplicate symmetric edges", () => {
    const first = source();
    first.relations.push(
      {
        sourceTaskId: "source-parent",
        targetTaskId: "source-child",
        relationType: "doska.related",
      },
      {
        sourceTaskId: "source-child",
        targetTaskId: "source-parent",
        relationType: "doska.related",
      },
    );
    const second = structuredClone(first);
    second.allTasks.reverse();
    second.columns.reverse();
    second.checklists.reverse();
    second.checklistItems.reverse();
    second.relations.reverse();
    second.selectedTaskIds.push("source-parent");
    expect(buildTemplateSnapshot(second)).toEqual(buildTemplateSnapshot(first));
    expect(
      buildTemplateSnapshot(first).snapshot.relations.filter(
        (relation) => relation.type === "related",
      ),
    ).toHaveLength(1);
  });
  it("does not mutate inputs and returns an independent deeply frozen snapshot", () => {
    const input = source(),
      before = structuredClone(input);
    const { snapshot } = buildTemplateSnapshot(input);
    expect(input).toEqual(before);
    input.allTasks[0]!.title = "Changed source";
    input.checklistItems[1]!.text = "Changed item";
    input.columns[0]!.name = "Changed column";
    expect(snapshot.tasks[1]!.title).toBe("Parent");
    expect(snapshot.tasks[1]!.checklists[0]!.items[0]!.text).toBe("First");
    expect(snapshot.columns[1]!.name).toBe("Done");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tasks[1]!.checklists[0]!.items[0]!)).toBe(
      true,
    );
    expect(() =>
      Reflect.set(snapshot.tasks[1]!, "title", "Mutated"),
    ).not.toThrow();
    expect(snapshot.tasks[1]!.title).toBe("Parent");
  });
  it("supports structure-only templates and legacy final column semantics", () => {
    const input: TemplateSnapshotInput = source();
    input.selectedTaskIds = [];
    input.columns = [{ ...input.columns[0]!, semanticState: null }];
    const { snapshot } = buildTemplateSnapshot(input);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.relations).toEqual([]);
    expect(snapshot.columns[0]!.semanticState).toBe("completed");
  });
});
