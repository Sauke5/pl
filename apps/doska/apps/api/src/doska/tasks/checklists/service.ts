import { checklistAudit } from "./audit";
import { and, asc, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../../database";
import {
  checklistTable,
  checklistItemTable,
  taskTable,
} from "../../../database/schema";
import {
  authorizeTaskProject,
  lockTaskContext,
  recordTaskActivity,
  type Transaction,
} from "../transaction";
import {
  titleBody,
  itemBody,
  updateItemBody,
  revisionBody,
  orderBody,
} from "./schema";

export type ChecklistAction =
  | { type: "created"; title: string }
  | { type: "renamed"; checklistId: string; title: string }
  | { type: "deleted"; checklistId: string }
  | { type: "reordered"; ids: string[] }
  | { type: "item.created"; checklistId: string; text: string }
  | {
      type: "item.updated";
      checklistId: string;
      itemId: string;
      text?: string;
      done?: boolean;
    }
  | { type: "item.deleted"; checklistId: string; itemId: string }
  | { type: "items.reordered"; checklistId: string; ids: string[] };
const bad = (message: string) => new HTTPException(400, { message });
async function snapshot(tx: Transaction, taskId: string, taskRevision: number) {
  const lists = await tx
    .select({
      id: checklistTable.id,
      title: checklistTable.title,
      position: checklistTable.position,
    })
    .from(checklistTable)
    .where(eq(checklistTable.taskId, taskId))
    .orderBy(asc(checklistTable.position), asc(checklistTable.id));
  const items = lists.length
    ? await tx
        .select({
          id: checklistItemTable.id,
          checklistId: checklistItemTable.checklistId,
          text: checklistItemTable.text,
          done: checklistItemTable.done,
          position: checklistItemTable.position,
        })
        .from(checklistItemTable)
        .where(
          inArray(
            checklistItemTable.checklistId,
            lists.map((v) => v.id),
          ),
        )
        .orderBy(asc(checklistItemTable.position), asc(checklistItemTable.id))
    : [];
  return {
    taskRevision,
    checklists: lists.map((list) => ({
      ...list,
      items: items
        .filter((v) => v.checklistId === list.id)
        .map(({ checklistId: _listId, ...item }) => item),
    })),
  };
}
export async function listChecklists(
  actorId: string,
  projectId: string,
  taskId: string,
) {
  return db.transaction(async (tx) => {
    const { task } = await lockTaskContext(
      tx,
      actorId,
      projectId,
      taskId,
      "readContent",
    );
    const result = await snapshot(tx, taskId, task!.revision);
    await authorizeTaskProject(tx, actorId, projectId, "readContent");
    return result;
  });
}
function validate(expectedRevision: number, action: ChecklistAction) {
  const schema =
    action.type === "created" || action.type === "renamed"
      ? titleBody
      : action.type === "item.created"
        ? itemBody
        : action.type === "item.updated"
          ? updateItemBody
          : action.type === "reordered" || action.type === "items.reordered"
            ? orderBody
            : revisionBody;
  const { type: _type, ...fields } = action;
  const {
    checklistId: _listId,
    itemId: _itemId,
    ...body
  } = fields as typeof fields & { checklistId?: string; itemId?: string };
  if (!schema.safeParse({ ...body, expectedRevision }).success)
    throw bad("Invalid checklist input");
}
function checkOrder(ids: string[], current: { id: string }[]) {
  if (ids.length !== current.length || current.some((v) => !ids.includes(v.id)))
    throw bad("Order must contain every current ID exactly once");
}
export async function mutateChecklist(
  actorId: string,
  projectId: string,
  taskId: string,
  expectedRevision: number,
  action: ChecklistAction,
) {
  validate(expectedRevision, action);
  return db.transaction(async (tx) => {
    const { task } = await lockTaskContext(tx, actorId, projectId, taskId);
    if (task!.archivedAt)
      throw new HTTPException(409, { message: "Task is archived" });
    if (task!.revision !== expectedRevision)
      throw new HTTPException(409, { message: "Task revision conflict" });
    const before = await snapshot(tx, taskId, task!.revision);
    const list =
      "checklistId" in action
        ? before.checklists.find((v) => v.id === action.checklistId)
        : undefined;
    if ("checklistId" in action && !list)
      throw new HTTPException(404, { message: "Checklist not found" });
    const item =
      "itemId" in action
        ? list!.items.find((v) => v.id === action.itemId)
        : undefined;
    if ("itemId" in action && !item)
      throw new HTTPException(404, { message: "Checklist item not found" });
    switch (action.type) {
      case "created":
        if (before.checklists.length >= 50)
          throw bad("Checklist limit reached");
        await tx.insert(checklistTable).values({
          taskId,
          title: action.title.trim(),
          position: before.checklists.length,
        });
        break;
      case "renamed":
        if (list!.title !== action.title.trim())
          await tx
            .update(checklistTable)
            .set({ title: action.title.trim() })
            .where(eq(checklistTable.id, list!.id));
        break;
      case "deleted":
        await tx.delete(checklistTable).where(eq(checklistTable.id, list!.id));
        for (const [position, remaining] of before.checklists
          .filter((v) => v.id !== list!.id)
          .entries())
          if (remaining.position !== position)
            await tx
              .update(checklistTable)
              .set({ position })
              .where(eq(checklistTable.id, remaining.id));
        break;
      case "reordered":
        checkOrder(action.ids, before.checklists);
        for (const [position, id] of action.ids.entries())
          if (before.checklists.find((v) => v.id === id)!.position !== position)
            await tx
              .update(checklistTable)
              .set({ position })
              .where(eq(checklistTable.id, id));
        break;
      case "item.created":
        if (list!.items.length >= 200)
          throw bad("Checklist item limit reached");
        await tx.insert(checklistItemTable).values({
          checklistId: list!.id,
          text: action.text.trim(),
          position: list!.items.length,
        });
        break;
      case "item.updated": {
        const text = action.text?.trim() ?? item!.text;
        const done = action.done ?? item!.done;
        if (text !== item!.text || done !== item!.done)
          await tx
            .update(checklistItemTable)
            .set({ text, done })
            .where(eq(checklistItemTable.id, item!.id));
        break;
      }
      case "item.deleted":
        await tx
          .delete(checklistItemTable)
          .where(eq(checklistItemTable.id, item!.id));
        for (const [position, remaining] of list!.items
          .filter((v) => v.id !== item!.id)
          .entries())
          if (remaining.position !== position)
            await tx
              .update(checklistItemTable)
              .set({ position })
              .where(eq(checklistItemTable.id, remaining.id));
        break;
      case "items.reordered":
        checkOrder(action.ids, list!.items);
        for (const [position, id] of action.ids.entries())
          if (list!.items.find((v) => v.id === id)!.position !== position)
            await tx
              .update(checklistItemTable)
              .set({ position })
              .where(eq(checklistItemTable.id, id));
        break;
    }
    const after = await snapshot(tx, taskId, task!.revision);
    if (
      JSON.stringify(before.checklists) !== JSON.stringify(after.checklists)
    ) {
      const updated = await tx
        .update(taskTable)
        .set({ revision: expectedRevision + 1 })
        .where(
          and(
            eq(taskTable.id, taskId),
            eq(taskTable.revision, expectedRevision),
          ),
        )
        .returning({ id: taskTable.id });
      if (!updated.length)
        throw new HTTPException(409, { message: "Task revision conflict" });
      after.taskRevision++;
      const audit = checklistAudit(action, before.checklists, after.checklists);
      await recordTaskActivity(
        tx,
        actorId,
        taskId,
        `doska.task.checklist.${action.type}`,
        audit.before,
        audit.after,
      );
    }
    await authorizeTaskProject(tx, actorId, projectId);
    return after;
  });
}
