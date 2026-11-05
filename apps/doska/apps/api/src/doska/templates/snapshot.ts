import { cardColors, type CardColor } from "../tasks/card-color";
import type { TemplateField, TemplateTaskMetadata } from "./snapshot-metadata";
import type {
  columnTable,
  taskTable,
  checklistTable,
  checklistItemTable,
  taskRelationTable,
} from "../../database/schema";

type ColumnInput = Pick<
  typeof columnTable.$inferSelect,
  | "id"
  | "projectId"
  | "name"
  | "slug"
  | "semanticState"
  | "isFinal"
  | "color"
  | "icon"
  | "position"
>;
type TaskInput = Pick<
  typeof taskTable.$inferSelect,
  | "id"
  | "projectId"
  | "title"
  | "description"
  | "priority"
  | "columnId"
  | "parentTaskId"
  | "position"
  | "archivedAt"
> & { cardColor?: CardColor | null };
type ChecklistInput = Pick<
  typeof checklistTable.$inferSelect,
  "id" | "taskId" | "title" | "position"
>;
type ItemInput = Pick<
  typeof checklistItemTable.$inferSelect,
  "id" | "checklistId" | "text" | "position"
>;
type RelationInput = Pick<
  typeof taskRelationTable.$inferSelect,
  "sourceTaskId" | "targetTaskId" | "relationType"
>;
export type TemplateSnapshotInput = {
  projectId: string;
  columns: readonly ColumnInput[];
  allTasks: readonly TaskInput[];
  selectedTaskIds: readonly string[];
  checklists: readonly ChecklistInput[];
  checklistItems: readonly ItemInput[];
  relations: readonly RelationInput[];
};
type Priority = "no-priority" | "low" | "medium" | "high" | "urgent";
type RelationType = "related" | "blocks" | "duplicate";
export type TemplateSnapshot = {
  readonly version: 1;
  readonly requiredTaskFields?: readonly (
    | "description"
    | "userId"
    | "priority"
    | "startDate"
    | "due"
  )[];
  readonly customFields?: readonly TemplateField[];
  readonly columns: readonly {
    readonly key: string;
    readonly name: string;
    readonly slug: string;
    readonly semanticState: "planned" | "active" | "completed";
    readonly color: string | null;
    readonly icon: string | null;
    readonly position: number;
  }[];
  readonly tasks: readonly {
    readonly labels?: TemplateTaskMetadata["labels"];
    readonly customValues?: TemplateTaskMetadata["customValues"];
    readonly key: string;
    readonly title: string;
    readonly description: string | null;
    readonly priority: Priority;
    readonly cardColor?: CardColor | null;
    readonly columnKey: string | null;
    readonly parentKey: string | null;
    readonly position: number;
    readonly checklists: readonly {
      readonly title: string;
      readonly items: readonly {
        readonly text: string;
        readonly done: false;
      }[];
    }[];
  }[];
  readonly relations: readonly {
    readonly type: RelationType;
    readonly sourceKey: string;
    readonly targetKey: string;
  }[];
};
export class TemplateSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateSnapshotError";
  }
}
function compareText(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function comparePosition(
  a: { position: number | null; id: string },
  b: { position: number | null; id: string },
) {
  return (a.position ?? 0) - (b.position ?? 0) || compareText(a.id, b.id);
}
function uniqueIds(rows: readonly { id: string }[]) {
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new TemplateSnapshotError("Duplicate source identifiers");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function buildTemplateSnapshot(input: TemplateSnapshotInput): {
  snapshot: TemplateSnapshot;
  expandedTaskIds: readonly string[];
} {
  if (
    input.columns.some((column) => column.projectId !== input.projectId) ||
    input.allTasks.some((task) => task.projectId !== input.projectId)
  )
    throw new TemplateSnapshotError("Source rows must belong to one project");
  uniqueIds(input.columns);
  uniqueIds(input.allTasks);
  uniqueIds(input.checklists);
  uniqueIds(input.checklistItems);
  const byId = new Map(input.allTasks.map((task) => [task.id, task]));
  const selected = new Set(input.selectedTaskIds);
  for (const id of selected) {
    const task = byId.get(id);
    if (!task || task.archivedAt)
      throw new TemplateSnapshotError("Selected task is missing or archived");
  }
  const explicit = new Set(selected);
  for (const task of input.allTasks) {
    if (
      !task.archivedAt &&
      task.parentTaskId &&
      explicit.has(task.parentTaskId)
    )
      selected.add(task.id);
  }
  const columns = [...input.columns].sort(comparePosition);
  const columnKeys = new Map(
    columns.map((column, index) => [column.id, `c${index + 1}`]),
  );
  const tasks = input.allTasks
    .filter((task) => selected.has(task.id))
    .sort(comparePosition);
  const taskKeys = new Map(
    tasks.map((task, index) => [task.id, `t${index + 1}`]),
  );
  const priorities = new Set([
    "no-priority",
    "low",
    "medium",
    "high",
    "urgent",
  ]);
  const snapshotTasks = tasks.map((task) => {
    if (task.cardColor != null && !cardColors.includes(task.cardColor))
      throw new TemplateSnapshotError("Unsupported task card color");
    if (!priorities.has(task.priority))
      throw new TemplateSnapshotError("Unsupported task priority");
    if (task.columnId && !columnKeys.has(task.columnId))
      throw new TemplateSnapshotError("Selected task column is missing");
    const parent =
      task.parentTaskId && selected.has(task.parentTaskId)
        ? byId.get(task.parentTaskId)
        : null;
    if (
      parent &&
      (parent.id === task.id ||
        (parent.parentTaskId && selected.has(parent.parentTaskId)))
    )
      throw new TemplateSnapshotError("Only one subtask level is supported");
    return {
      key: taskKeys.get(task.id)!,
      title: task.title,
      description: task.description,
      priority: task.priority as Priority,
      cardColor: task.cardColor ?? null,
      columnKey: task.columnId ? columnKeys.get(task.columnId)! : null,
      parentKey: parent ? taskKeys.get(parent.id)! : null,
      position: task.position ?? 0,
      checklists: input.checklists
        .filter((list) => list.taskId === task.id)
        .sort(comparePosition)
        .map((list) => ({
          title: list.title,
          items: input.checklistItems
            .filter((item) => item.checklistId === list.id)
            .sort(comparePosition)
            .map((item) => ({ text: item.text, done: false as const })),
        })),
    };
  });
  const relationTypes = new Map<string, RelationType>([
    ["doska.related", "related"],
    ["doska.blocks", "blocks"],
    ["doska.duplicate", "duplicate"],
  ]);
  const relations = new Map<
    string,
    { type: RelationType; sourceKey: string; targetKey: string }
  >();
  for (const relation of input.relations) {
    const type = relationTypes.get(relation.relationType);
    let sourceKey = taskKeys.get(relation.sourceTaskId),
      targetKey = taskKeys.get(relation.targetTaskId);
    if (!type || !sourceKey || !targetKey) continue;
    if (sourceKey === targetKey)
      throw new TemplateSnapshotError("A task cannot relate to itself");
    if (type !== "blocks" && compareText(sourceKey, targetKey) > 0)
      [sourceKey, targetKey] = [targetKey, sourceKey];
    relations.set(`${type}:${sourceKey}:${targetKey}`, {
      type,
      sourceKey,
      targetKey,
    });
  }
  const snapshot: TemplateSnapshot = {
    version: 1,
    columns: columns.map((column) => ({
      key: columnKeys.get(column.id)!,
      name: column.name,
      slug: column.slug,
      semanticState:
        column.semanticState ?? (column.isFinal ? "completed" : "planned"),
      color: column.color,
      icon: column.icon,
      position: column.position,
    })),
    tasks: snapshotTasks,
    relations: [...relations.entries()]
      .sort(([a], [b]) => compareText(a, b))
      .map(([, relation]) => relation),
  };
  return {
    snapshot: freeze(snapshot),
    expandedTaskIds: Object.freeze(tasks.map((task) => task.id)),
  };
}
