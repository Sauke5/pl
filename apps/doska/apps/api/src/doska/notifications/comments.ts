import { publishLiveChanges } from "../live/publisher";
import { eq } from "drizzle-orm";
import { notificationTable, taskCoexecutorTable } from "../../database/schema";
import { getProjectCapabilities } from "../project-access";
import type { Task, Transaction } from "../tasks/transaction";

/** Persist in the comment transaction; edits notify only newly mentioned people. */
export async function persistCommentNotifications(
  tx: Transaction,
  actorId: string,
  task: Task,
  commentId: string,
  mentionIds: readonly string[],
  previousMentionIds?: readonly string[],
) {
  const recipients = new Map<string, "task_comment" | "task_mention">();
  if (previousMentionIds === undefined) {
    if (task.userId) recipients.set(task.userId, "task_comment");
    const coexecutors = await tx
      .select({ userId: taskCoexecutorTable.userId })
      .from(taskCoexecutorTable)
      .where(eq(taskCoexecutorTable.taskId, task.id));
    for (const { userId } of coexecutors)
      recipients.set(userId, "task_comment");
  }
  for (const userId of mentionIds) {
    if (!previousMentionIds?.includes(userId))
      recipients.set(userId, "task_mention");
  }
  recipients.delete(actorId);
  for (const [userId, type] of recipients) {
    if (
      !(await getProjectCapabilities(userId, task.projectId, { database: tx }))
        .readContent
    )
      continue;
    await tx.insert(notificationTable).values({
      userId,
      type: `doska.${type}`,
      resourceType: "doska.task",
      resourceId: task.id,
      eventData: { actorId, commentId },
    });
    await publishLiveChanges(tx, [
      { kind: "personal", userIds: [userId], scopes: ["notifications"] },
    ]);
  }
}
