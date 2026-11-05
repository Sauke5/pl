import { publishLiveChanges } from "../live/publisher";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  notificationTable,
  projectTable,
  taskTable,
  projectInvitationTable,
  projectJoinRequestTable,
} from "../../database/schema";
import { readProjectCondition } from "../read-project-condition";

import { participationAccess } from "./participation";
import { transferNotificationAccess } from "./transfer-access";
import { notificationTypes } from "./schema";

/** The same predicate governs rows, counts and read-state changes. */
function accessible(userId: string) {
  return and(
    eq(notificationTable.userId, userId),
    inArray(notificationTable.type, notificationTypes),
    sql`(${and(
      sql`(${notificationTable.resourceType}='doska.task' AND ${notificationTable.type} IN ('doska.task_assigned','doska.task_unassigned','doska.task_role_changed','doska.task_comment','doska.task_mention','doska.task_due_reminder','doska.task_overdue'))`,
      sql`(${notificationTable.type} NOT IN ('doska.task_comment', 'doska.task_mention') OR EXISTS (
      SELECT 1 FROM comment AS notification_comment
      WHERE notification_comment.id = ${notificationTable.eventData}->>'commentId'
        AND notification_comment.task_id = ${notificationTable.resourceId}
        AND notification_comment.deleted_at IS NULL
        AND (${notificationTable.type} <> 'doska.task_mention' OR notification_comment.mention_ids ? ${userId})
    ))`,
      sql`EXISTS (SELECT 1 FROM task AS notification_task
      WHERE notification_task.id = ${notificationTable.resourceId}
        AND ${readProjectCondition(userId, sql`notification_task.project_id`)})`,
    )} OR ${participationAccess(userId)} OR ${transferNotificationAccess(userId)})`,
  );
}

function decodeCursor(cursor: string) {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).sort().join() !== "at,id" ||
      typeof row.at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.at) ||
      !Number.isFinite(Date.parse(row.at)) ||
      new Date(row.at).toISOString().slice(0, 23) !== row.at.slice(0, 23) ||
      typeof row.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(row.id)
    )
      throw new Error();
    return { at: row.at, id: row.id };
  } catch {
    throw new HTTPException(400, { message: "Invalid notification cursor" });
  }
}
export async function listTaskNotificationPage(
  userId: string,
  limit = 50,
  cursor?: string,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new HTTPException(400, { message: "Invalid notification limit" });
  const position = cursor === undefined ? null : decodeCursor(cursor);
  // Read current names only after authorization; stored notification text is not exposed.
  const rows = await db
    .select({
      id: notificationTable.id,
      type: sql<(typeof notificationTypes)[number]>`${notificationTable.type}`,
      isRead: sql<boolean>`coalesce(${notificationTable.isRead}, false)`,
      createdAt: sql<string>`to_char(${notificationTable.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      destination: sql<"task" | "project" | "invitations" | "members">`CASE
        WHEN ${notificationTable.resourceType}='doska.task' THEN 'task'
        WHEN ${notificationTable.type}='doska.invitation_created' AND ${projectInvitationTable.status}='pending' THEN 'invitations'
        WHEN ${notificationTable.type} IN ('doska.join_requested','doska.invitation_accepted','doska.invitation_declined','doska.member_department_changed') THEN 'members'
        ELSE 'project' END`,
      invitationId: projectInvitationTable.id,
      requestId: projectJoinRequestTable.id,
      affectedUserName: sql<
        string | null
      >`CASE WHEN ${notificationTable.type}='doska.member_department_changed'
        THEN (SELECT name FROM "user" WHERE id=${notificationTable.eventData}->>'userId') ELSE NULL END`,
      taskId: taskTable.id,
      taskTitle: taskTable.title,
      taskNumber: taskTable.number,
      projectId: projectTable.id,
      projectName: projectTable.name,
    })
    .from(notificationTable)
    .leftJoin(
      taskTable,
      and(
        eq(notificationTable.resourceType, "doska.task"),
        eq(taskTable.id, notificationTable.resourceId),
      ),
    )
    .leftJoin(
      projectInvitationTable,
      and(
        eq(notificationTable.resourceType, "doska.invitation"),
        eq(projectInvitationTable.id, notificationTable.resourceId),
      ),
    )
    .leftJoin(
      projectJoinRequestTable,
      and(
        eq(notificationTable.resourceType, "doska.join_request"),
        eq(projectJoinRequestTable.id, notificationTable.resourceId),
      ),
    )
    .innerJoin(
      projectTable,
      sql`${projectTable.id}=coalesce(${taskTable.projectId},${projectInvitationTable.projectId},${projectJoinRequestTable.projectId},CASE WHEN ${notificationTable.resourceType}='doska.project' THEN ${notificationTable.resourceId} ELSE NULL END)`,
    )
    .where(
      and(
        accessible(userId),
        position
          ? sql`(${notificationTable.createdAt}, ${notificationTable.id}) < (${position.at}::timestamptz, ${position.id})`
          : undefined,
      ),
    )
    .orderBy(desc(notificationTable.createdAt), desc(notificationTable.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({ at: last.createdAt, id: last.id }),
          ).toString("base64url")
        : null,
  };
}

export async function countUnreadTaskNotifications(userId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::integer` })
    .from(notificationTable)
    .where(
      and(
        accessible(userId),
        sql`coalesce(${notificationTable.isRead}, false) = false`,
      ),
    );
  return row!.count;
}

export async function markTaskNotificationRead(userId: string, id: string) {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ id: notificationTable.id, isRead: notificationTable.isRead })
      .from(notificationTable)
      .where(and(accessible(userId), eq(notificationTable.id, id)))
      .for("update");
    if (!before)
      throw new HTTPException(404, { message: "Notification not found" });
    if (!before.isRead) {
      const [updated] = await tx
        .update(notificationTable)
        .set({ isRead: true })
        .where(and(accessible(userId), eq(notificationTable.id, id)))
        .returning({ id: notificationTable.id });
      if (!updated)
        throw new HTTPException(404, { message: "Notification not found" });
      await publishLiveChanges(tx, [
        { kind: "personal", userIds: [userId], scopes: ["notifications"] },
      ]);
    }
    return { id: before.id };
  });
}

export async function listTaskNotifications(userId: string, limit = 50) {
  return (await listTaskNotificationPage(userId, limit)).items;
}
export async function markAllTaskNotificationsRead(userId: string) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(notificationTable)
      .set({ isRead: true })
      .where(
        and(
          accessible(userId),
          sql`coalesce(${notificationTable.isRead}, false) = false`,
        ),
      )
      .returning({ id: notificationTable.id });
    if (rows.length)
      await publishLiveChanges(tx, [
        { kind: "personal", userIds: [userId], scopes: ["notifications"] },
      ]);
    return { count: rows.length };
  });
}
