import { createId } from "@paralleldrive/cuid2";
import type {
  columnTable,
  taskTable,
  checklistTable,
  checklistItemTable,
  taskRelationTable,
  customFieldDefinitionTable,
  customFieldValueTable,
  labelTable,
} from "../../database/schema";
import { TemplateSnapshotError, type TemplateSnapshot } from "./snapshot";

/** Builds rows for one transaction; never copies source identities or scheduling. */
export function materializeTemplate(
  snapshot: TemplateSnapshot,
  projectId: string,
  includeTasks: boolean,
  newId: () => string = createId,
) {
  const columnIds = new Map(
    snapshot.columns.map((column) => [column.key, newId()]),
  );
  const taskIds = new Map(snapshot.tasks.map((task) => [task.key, newId()]));
  if (
    columnIds.size !== snapshot.columns.length ||
    taskIds.size !== snapshot.tasks.length
  )
    throw new TemplateSnapshotError("Duplicate snapshot keys");
  const columns: (typeof columnTable.$inferInsert)[] = snapshot.columns.map(
    (column) => ({
      id: columnIds.get(column.key)!,
      projectId,
      name: column.name,
      slug: column.slug,
      semanticState: column.semanticState,
      isFinal: column.semanticState === "completed",
      color: column.color,
      icon: column.icon,
      position: column.position,
    }),
  );
  const fields = snapshot.customFields ?? [];
  const fieldIds = new Map(fields.map((field) => [field.key, newId()]));
  if (fieldIds.size !== fields.length)
    throw new TemplateSnapshotError("Duplicate custom field keys");
  const customFields: (typeof customFieldDefinitionTable.$inferInsert)[] =
    fields.map((field) => ({
      id: fieldIds.get(field.key)!,
      projectId,
      name: field.name,
      type: field.type,
      required: field.required,
      defaultValue: field.type === "user" ? null : field.defaultValue,
      options: field.options ? [...field.options] : null,
      position: field.position,
    }));
  const customValues: (typeof customFieldValueTable.$inferInsert)[] = [];
  const labels: (typeof labelTable.$inferInsert)[] = [];
  const tasks: (typeof taskTable.$inferInsert)[] = [];
  const checklists: (typeof checklistTable.$inferInsert)[] = [];
  const items: (typeof checklistItemTable.$inferInsert)[] = [];
  const relations: (typeof taskRelationTable.$inferInsert)[] = [];
  if (!includeTasks || !snapshot.tasks.length)
    return {
      columns,
      tasks,
      checklists,
      items,
      relations,
      customFields,
      customValues,
      labels,
      lastTaskNumber: 0,
    };
  const initial = [...snapshot.columns]
    .sort((a, b) => a.position - b.position)
    .find((column) => column.semanticState === "planned");
  if (!initial)
    throw new TemplateSnapshotError(
      "A planned column is required for template tasks",
    );
  for (const [position, task] of snapshot.tasks.entries()) {
    const id = taskIds.get(task.key)!;
    const parentId = task.parentKey ? taskIds.get(task.parentKey) : null;
    if (
      task.parentKey &&
      (!parentId ||
        parentId === id ||
        snapshot.tasks.find((parent) => parent.key === task.parentKey)
          ?.parentKey)
    )
      throw new TemplateSnapshotError("Invalid template task parent");
    tasks.push({
      id,
      projectId,
      parentTaskId: parentId,
      columnId: columnIds.get(initial.key)!,
      status: initial.slug,
      title: task.title,
      description: task.description,
      priority: task.priority,
      cardColor: task.cardColor ?? null,
      position,
      number: position + 1,
      userId: null,
      startDate: null,
      dueDate: null,
      dueDateHasTime: false,
      revision: 0,
      archivedAt: null,
    });
    for (const field of fields) {
      if (field.type === "user") continue;
      const value =
        task.customValues?.find((value) => value.fieldKey === field.key)
          ?.value ?? field.defaultValue;
      // Templates may intentionally contain incomplete tasks. Values are filled
      // in their new project; no employee identities or dates are copied.
      if (value !== null)
        customValues.push({
          id: newId(),
          taskId: id,
          fieldId: fieldIds.get(field.key)!,
          value,
        });
    }
    for (const label of task.labels ?? [])
      labels.push({
        id: newId(),
        taskId: id,
        name: label.name,
        color: label.color,
      });
    for (const [listPosition, list] of task.checklists.entries()) {
      const checklistId = newId();
      checklists.push({
        id: checklistId,
        taskId: id,
        title: list.title,
        position: listPosition,
      });
      for (const [itemPosition, item] of list.items.entries())
        items.push({
          id: newId(),
          checklistId,
          text: item.text,
          done: false,
          position: itemPosition,
        });
    }
  }
  for (const relation of snapshot.relations) {
    const sourceTaskId = taskIds.get(relation.sourceKey),
      targetTaskId = taskIds.get(relation.targetKey);
    if (!sourceTaskId || !targetTaskId || sourceTaskId === targetTaskId)
      throw new TemplateSnapshotError("Invalid template relation");
    relations.push({
      id: newId(),
      sourceTaskId,
      targetTaskId,
      relationType: `doska.${relation.type}`,
    });
  }
  return {
    columns,
    tasks,
    checklists,
    items,
    relations,
    customFields,
    customValues,
    labels,
    lastTaskNumber: tasks.length,
  };
}
