import { z } from "../../../openapi";
import { taskParams, deleteTaskBody } from "../schema";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const checklistParams = taskParams.extend({ checklistId: id });
export const itemParams = checklistParams.extend({ itemId: id });
export const revisionBody = deleteTaskBody;
export const titleBody = revisionBody.extend({
  title: z.string().trim().min(1).max(200),
});
export const itemBody = revisionBody.extend({
  text: z.string().trim().min(1).max(2000),
});
export const updateItemBody = revisionBody
  .extend({
    text: z.string().trim().min(1).max(2000).optional(),
    done: z.boolean().optional(),
  })
  .refine(
    (v) => v.text !== undefined || v.done !== undefined,
    "No changes supplied",
  );
export const orderBody = revisionBody.extend({
  ids: z
    .array(id)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate ID"),
});
export const checklistResponse = z.strictObject({
  taskRevision: z.number().int(),
  checklists: z.array(
    z.strictObject({
      id: z.string(),
      title: z.string(),
      position: z.number().int(),
      items: z.array(
        z.strictObject({
          id: z.string(),
          text: z.string(),
          done: z.boolean(),
          position: z.number().int(),
        }),
      ),
    }),
  ),
});
