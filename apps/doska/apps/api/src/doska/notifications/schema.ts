import { pagingNumber, z } from "../../openapi";
import { participationTypes } from "./participation";
export const notificationTypes = [
  "doska.task_assigned",
  "doska.task_unassigned",
  "doska.task_role_changed",
  "doska.task_comment",
  "doska.task_mention",
  "doska.task_due_reminder",
  "doska.task_overdue",
  "doska.member_department_changed",
  ...participationTypes,
] as const;
export const notificationQuery = z.strictObject({
  limit: pagingNumber(1, 100, 50),
  cursor: z.string().min(1).max(1024).optional(),
});
export const notificationItem = z.strictObject({
  id: z.string(),
  type: z.enum(notificationTypes),
  isRead: z.boolean(),
  createdAt: z.string(),
  destination: z.enum(["task", "project", "invitations", "members"]),
  invitationId: z.string().nullable(),
  requestId: z.string().nullable(),
  affectedUserName: z.string().nullable(),
  taskId: z.string().nullable(),
  taskTitle: z.string().nullable(),
  taskNumber: z.number().nullable(),
  projectId: z.string(),
  projectName: z.string(),
});
export const notificationPage = z.strictObject({
  items: z.array(notificationItem),
  nextCursor: z.string().nullable(),
});
