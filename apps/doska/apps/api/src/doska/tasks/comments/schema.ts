import {
  nullableResponseTimestamp,
  responseTimestamp,
  z,
} from "../../../openapi";
import { taskParams } from "../schema";
const userId = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
export const commentParams = taskParams.extend({
  commentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});
export const createCommentBody = z.strictObject({
  content: z
    .string()
    .min(1)
    .max(20_000)
    .refine((value) => value.trim().length > 0, "Comment cannot be blank"),
  mentionIds: z
    .array(userId)
    .max(50)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Mentions must be unique",
    )
    .default([]),
});
export const deleteCommentBody = z.strictObject({
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
});
export const updateCommentBody = createCommentBody.extend({
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
});
export const commentSchema = z.strictObject({
  id: z.string(),
  taskId: z.string(),
  userId: z.string(),
  authorName: z.string().nullable(),
  content: z.string().nullable(),
  mentionIds: z.array(z.string()),
  mentions: z.array(
    z.strictObject({ userId: z.string(), name: z.string().nullable() }),
  ),
  revision: z.number().int(),
  deletedAt: nullableResponseTimestamp,
  deletedBy: z.string().nullable(),
  createdAt: responseTimestamp,
  updatedAt: responseTimestamp,
});
