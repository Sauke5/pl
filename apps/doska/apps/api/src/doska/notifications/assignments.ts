import { publishLiveChanges } from "../live/publisher";
import { notificationTable } from "../../database/schema";
import { getProjectCapabilities } from "../project-access";
import type { Transaction } from "../projects/transaction";
import { getAssignmentRecipients, type TaskAssignees } from "./recipients";

/** Called within the task mutation transaction, which locks directory and project. */
export async function persistAssignmentNotifications(
  tx: Transaction,
  input: {
    actorId: string;
    projectId: string;
    taskId: string;
    before: TaskAssignees;
    after: TaskAssignees;
  },
) {
  for (const recipient of getAssignmentRecipients(
    input.actorId,
    input.before,
    input.after,
  )) {
    const capabilities = await getProjectCapabilities(
      recipient.userId,
      input.projectId,
      { database: tx },
    );
    if (!capabilities.readContent) continue;
    await tx.insert(notificationTable).values({
      userId: recipient.userId,
      type: `doska.task_${recipient.kind}`,
      resourceType: "doska.task",
      resourceId: input.taskId,
      eventData: {
        actorId: input.actorId,
        role: recipient.role,
        beforeRole: recipient.previousRole,
      },
    });
    await publishLiveChanges(tx, [
      {
        kind: "personal",
        userIds: [recipient.userId],
        scopes: ["notifications"],
      },
    ]);
  }
}
