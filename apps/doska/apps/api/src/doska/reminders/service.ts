import { publishLiveChanges } from "../live/publisher";
import { and, asc, desc, eq, gt, isNotNull, lte } from "drizzle-orm";
import db from "../../database";
import {
  columnTable,
  notificationTable,
  projectTable,
  taskCoexecutorTable,
  taskReminderSentTable,
  taskTable,
  userNotificationPreferenceTable,
} from "../../database/schema";
import { getProjectCapabilities } from "../project-access";
import { lockDirectory } from "../projects/transaction";
import { moscowDate } from "../tasks/dates";
import { isRussianWorkingDay } from "./calendar";
import { getReminderSchedule } from "./timing";
import { pendingReminder } from "./pending";

export async function runDoskaReminders(
  now = new Date(),
): Promise<{ degraded: boolean }> {
  if (!Number.isFinite(now.getTime()))
    throw new RangeError("Invalid reminder run time");
  const startedAt = Date.now();
  const accessTime = () => new Date(now.getTime() + Date.now() - startedAt);
  let degraded = false;
  const [ceiling] = await db
    .select({ id: taskTable.id })
    .from(taskTable)
    .where(isNotNull(taskTable.dueDate))
    .orderBy(desc(taskTable.id))
    .limit(1);
  if (!ceiling) return { degraded };
  let cursor: string | undefined;
  for (;;) {
    const candidates = await db
      .select({ id: taskTable.id, projectId: taskTable.projectId })
      .from(taskTable)
      .where(
        and(
          isNotNull(taskTable.dueDate),
          lte(taskTable.id, ceiling.id),
          cursor ? gt(taskTable.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(taskTable.id))
      .limit(100);
    if (!candidates.length) break;
    for (const candidate of candidates) {
      try {
        await db.transaction(async (tx) => {
          await lockDirectory(tx);
          const [project] = await tx
            .select()
            .from(projectTable)
            .where(eq(projectTable.id, candidate.projectId))
            .for("update");
          if (!project || project.archivedAt) return;
          const [task] = await tx
            .select()
            .from(taskTable)
            .where(
              and(
                eq(taskTable.id, candidate.id),
                eq(taskTable.projectId, project.id),
              ),
            )
            .for("update");
          if (!task?.dueDate || task.archivedAt || task.status === "archived")
            return;
          const [column] = await tx
            .select({ state: columnTable.semanticState })
            .from(columnTable)
            .where(
              task.columnId
                ? eq(columnTable.id, task.columnId)
                : and(
                    eq(columnTable.projectId, project.id),
                    eq(columnTable.slug, task.status),
                  ),
            )
            .limit(1);
          if (column?.state === "completed") return;
          const due = task.dueDate;
          const overdue = task.dueDateHasTime
            ? due
            : new Date(
                moscowDate(
                  new Date(due.getTime() + 10_800_000)
                    .toISOString()
                    .slice(0, 10),
                ).getTime() + 86_400_000,
              );
          let kind: "before" | "overdue" | null =
            now >= overdue ? "overdue" : null;
          if (!kind) {
            try {
              kind = pendingReminder(
                getReminderSchedule(
                  due,
                  task.dueDateHasTime,
                  isRussianWorkingDay,
                ),
                now,
              );
            } catch {
              degraded = true;
              return;
            }
          }
          if (!kind) return;
          const coexecutors = await tx
            .select({ userId: taskCoexecutorTable.userId })
            .from(taskCoexecutorTable)
            .where(eq(taskCoexecutorTable.taskId, task.id));
          const recipients = [
            ...new Set([
              ...(task.userId ? [task.userId] : []),
              ...coexecutors.map((row) => row.userId),
            ]),
          ].sort();
          for (const userId of recipients) {
            const [preference] = await tx
              .select({
                enabled: userNotificationPreferenceTable.dueDateReminderEnabled,
              })
              .from(userNotificationPreferenceTable)
              .where(eq(userNotificationPreferenceTable.userId, userId));
            if (
              preference?.enabled === false ||
              !(
                await getProjectCapabilities(userId, project.id, {
                  database: tx,
                  now: accessTime(),
                })
              ).readContent
            )
              continue;
            const [claim] = await tx
              .insert(taskReminderSentTable)
              .values({
                taskId: task.id,
                reminderType: `doska:${kind}:${userId}`,
              })
              .onConflictDoNothing()
              .returning({ id: taskReminderSentTable.id });
            if (!claim) continue;
            await tx.insert(notificationTable).values({
              userId,
              type:
                kind === "before"
                  ? "doska.task_due_reminder"
                  : "doska.task_overdue",
              resourceType: "doska.task",
              resourceId: task.id,
              eventData: {
                dueDateISO: due.toISOString(),
                dueDateHasTime: task.dueDateHasTime,
              },
            });
            await publishLiveChanges(tx, [
              {
                kind: "personal",
                userIds: [userId],
                scopes: ["notifications"],
              },
            ]);
          }
        });
      } catch {
        degraded = true;
      }
    }
    cursor = candidates.at(-1)!.id;
  }
  if (degraded)
    console.warn(
      "Doska reminder run incomplete; failed tasks or unavailable calendar will retry",
    );
  return { degraded };
}
