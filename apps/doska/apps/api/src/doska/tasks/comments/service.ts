import { and, asc, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../../database";
import {
  commentTable,
  projectMemberTable,
  taskTable,
  userTable,
} from "../../../database/schema";
import { freshIdentity } from "../../projects/transaction";
import { persistCommentNotifications } from "../../notifications/comments";
import {
  authorizeTaskProject,
  lockTaskContext,
  recordTaskActivity,
  type Task,
  type Transaction,
} from "../transaction";
import {
  createCommentBody,
  deleteCommentBody,
  updateCommentBody,
} from "./schema";

type Comment = typeof commentTable.$inferSelect;
type Content = { content: string; mentionIds?: string[] };
function parse<T>(
  schema: {
    safeParse: (
      input: unknown,
    ) => { success: true; data: T } | { success: false };
  },
  input: unknown,
): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new HTTPException(400, { message: "Invalid comment request" });
  return result.data;
}
async function validateMentions(
  tx: Transaction,
  projectId: string,
  ownerId: string | null,
  ids: string[],
) {
  for (const userId of ids) {
    if (!(await freshIdentity(tx, userId)))
      throw new HTTPException(400, {
        message: "Mentioned user is unavailable",
      });
    if (userId === ownerId) continue;
    const [member] = await tx
      .select({ id: projectMemberTable.id })
      .from(projectMemberTable)
      .where(
        and(
          eq(projectMemberTable.projectId, projectId),
          eq(projectMemberTable.userId, userId),
          inArray(projectMemberTable.role, ["participant", "observer"]),
        ),
      );
    if (!member)
      throw new HTTPException(400, {
        message: "Mentioned user is not a project member",
      });
  }
}
async function dtos(tx: Transaction, comments: Comment[]) {
  const ids = [
    ...new Set(
      comments.flatMap((comment) => [
        comment.userId,
        ...(comment.deletedAt ? [] : comment.mentionIds),
      ]),
    ),
  ];
  const users = ids.length
    ? await tx
        .select({ id: userTable.id, name: userTable.name })
        .from(userTable)
        .where(inArray(userTable.id, ids))
    : [];
  const names = new Map(users.map((user) => [user.id, user.name]));
  return comments.map((comment) => ({
    ...comment,
    authorName: names.get(comment.userId) ?? null,
    content: comment.deletedAt ? null : comment.content,
    mentionIds: comment.deletedAt ? [] : comment.mentionIds,
    mentions: comment.deletedAt
      ? []
      : comment.mentionIds.map((userId) => ({
          userId,
          name: names.get(userId) ?? null,
        })),
  }));
}
function snapshot(comment: Comment) {
  return {
    commentId: comment.id,
    content: comment.deletedAt ? null : comment.content,
    mentionIds: comment.deletedAt ? [] : comment.mentionIds,
    userId: comment.userId,
    revision: comment.revision,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    deletedAt: comment.deletedAt,
    deletedBy: comment.deletedBy,
  };
}
async function changed(
  tx: Transaction,
  actorId: string,
  task: Task,
  operation: "created" | "updated" | "deleted",
  before: Comment | null,
  after: Comment,
) {
  if (task.revision >= 2_147_483_647)
    throw new HTTPException(409, { message: "Task revision limit reached" });
  await tx
    .update(taskTable)
    .set({ revision: task.revision + 1 })
    .where(eq(taskTable.id, task.id));
  await recordTaskActivity(
    tx,
    actorId,
    task.id,
    `doska.task.comment.${operation}`,
    before ? snapshot(before) : null,
    snapshot(after),
  );
}
function activeTask(task: Task | undefined): asserts task is Task {
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  if (task.archivedAt)
    throw new HTTPException(409, { message: "Task is archived" });
}
export async function listTaskComments(
  actorId: string,
  projectId: string,
  taskId: string,
  page: { limit: number; offset: number },
) {
  return db.transaction(async (tx) => {
    await lockTaskContext(tx, actorId, projectId, taskId, "readContent");
    if (
      !Number.isInteger(page.limit) ||
      page.limit < 1 ||
      page.limit > 100 ||
      !Number.isInteger(page.offset) ||
      page.offset < 0
    )
      throw new HTTPException(400, { message: "Invalid pagination" });
    const rows = await tx
      .select()
      .from(commentTable)
      .where(eq(commentTable.taskId, taskId))
      .orderBy(asc(commentTable.createdAt), asc(commentTable.id))
      .limit(page.limit)
      .offset(page.offset);
    const result = await dtos(tx, rows);
    await authorizeTaskProject(tx, actorId, projectId, "readContent");
    return result;
  });
}
export async function createTaskComment(
  actorId: string,
  projectId: string,
  taskId: string,
  input: Content,
) {
  const data = parse(createCommentBody, input);
  return db.transaction(async (tx) => {
    const { project, task } = await lockTaskContext(
      tx,
      actorId,
      projectId,
      taskId,
    );
    activeTask(task);
    await validateMentions(tx, projectId, project.ownerUserId, data.mentionIds);
    const [comment] = await tx
      .insert(commentTable)
      .values({ taskId, userId: actorId, ...data })
      .returning();
    await changed(tx, actorId, task, "created", null, comment!);
    await persistCommentNotifications(
      tx,
      actorId,
      task,
      comment!.id,
      data.mentionIds,
    );
    const [result] = await dtos(tx, [comment!]);
    await validateMentions(tx, projectId, project.ownerUserId, data.mentionIds);
    await authorizeTaskProject(tx, actorId, projectId);
    return result!;
  });
}
export async function updateTaskComment(
  actorId: string,
  projectId: string,
  taskId: string,
  commentId: string,
  input: Content & { expectedRevision: number },
) {
  const data = parse(updateCommentBody, input);
  return mutate(
    actorId,
    projectId,
    taskId,
    commentId,
    data.expectedRevision,
    data,
  );
}
export async function deleteTaskComment(
  actorId: string,
  projectId: string,
  taskId: string,
  commentId: string,
  input: { expectedRevision: number },
) {
  const data = parse(deleteCommentBody, input);
  return mutate(actorId, projectId, taskId, commentId, data.expectedRevision);
}
async function mutate(
  actorId: string,
  projectId: string,
  taskId: string,
  commentId: string,
  revision: number,
  data?: { content: string; mentionIds: string[] },
) {
  return db.transaction(async (tx) => {
    const { project, task } = await lockTaskContext(
      tx,
      actorId,
      projectId,
      taskId,
    );
    activeTask(task);
    const [before] = await tx
      .select()
      .from(commentTable)
      .where(
        and(eq(commentTable.id, commentId), eq(commentTable.taskId, taskId)),
      )
      .for("update");
    if (!before) throw new HTTPException(404, { message: "Comment not found" });
    if (before.userId !== actorId && (data || project.ownerUserId !== actorId))
      throw new HTTPException(403, {
        message: "Comment operation is not permitted",
      });
    if (before.revision !== revision)
      throw new HTTPException(409, { message: "Comment revision conflict" });
    if (data && before.deletedAt)
      throw new HTTPException(409, { message: "Comment is deleted" });
    if (data)
      await validateMentions(
        tx,
        projectId,
        project.ownerUserId,
        data.mentionIds,
      );
    const same = data
      ? before.content === data.content &&
        [...before.mentionIds].sort().join("\0") ===
          [...data.mentionIds].sort().join("\0")
      : !!before.deletedAt;
    let after = before;
    if (!same) {
      [after] = (await tx
        .update(commentTable)
        .set(
          data
            ? {
                content: data.content,
                mentionIds: data.mentionIds,
                revision: revision + 1,
              }
            : {
                deletedAt: new Date(),
                deletedBy: actorId,
                revision: revision + 1,
              },
        )
        .where(eq(commentTable.id, commentId))
        .returning()) as [Comment];
      await changed(
        tx,
        actorId,
        task,
        data ? "updated" : "deleted",
        before,
        after,
      );
      if (data)
        await persistCommentNotifications(
          tx,
          actorId,
          task,
          after.id,
          data.mentionIds,
          before.mentionIds,
        );
    }
    const [result] = await dtos(tx, [after]);
    if (data)
      await validateMentions(
        tx,
        projectId,
        project.ownerUserId,
        data.mentionIds,
      );
    await authorizeTaskProject(tx, actorId, projectId);
    return result!;
  });
}
