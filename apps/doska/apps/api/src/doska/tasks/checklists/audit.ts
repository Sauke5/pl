import type { z } from "../../../openapi";
import type { checklistResponse } from "./schema";
import type { ChecklistAction } from "./service";
type Lists = z.infer<typeof checklistResponse>["checklists"];

// Preserve the affected content without copying every unrelated list into each event.
export function checklistAudit(
  action: ChecklistAction,
  before: Lists,
  after: Lists,
): { before: unknown; after: unknown } {
  if (action.type === "created")
    return {
      before: null,
      after: after.find((v) => !before.some((old) => old.id === v.id)),
    };
  if (action.type === "reordered")
    return {
      before: { ids: before.map((v) => v.id) },
      after: { ids: after.map((v) => v.id) },
    };
  const oldList = before.find((v) => v.id === action.checklistId)!;
  const newList = after.find((v) => v.id === action.checklistId);
  if (action.type === "deleted") return { before: oldList, after: null };
  if (action.type === "renamed")
    return {
      before: { id: oldList.id, title: oldList.title },
      after: { id: newList!.id, title: newList!.title },
    };
  if (action.type === "items.reordered")
    return {
      before: { checklistId: oldList.id, ids: oldList.items.map((v) => v.id) },
      after: { checklistId: oldList.id, ids: newList!.items.map((v) => v.id) },
    };
  if (action.type === "item.created")
    return {
      before: null,
      after: {
        checklistId: oldList.id,
        ...newList!.items.find(
          (v) => !oldList.items.some((old) => old.id === v.id),
        ),
      },
    };
  return {
    before: {
      checklistId: oldList.id,
      ...oldList.items.find((v) => v.id === action.itemId),
    },
    after:
      action.type === "item.deleted"
        ? null
        : {
            checklistId: oldList.id,
            ...newList!.items.find((v) => v.id === action.itemId),
          },
  };
}
