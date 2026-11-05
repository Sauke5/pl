import { sql } from "drizzle-orm";
import { notificationTable } from "../../database/schema";
import { readProjectCondition } from "../read-project-condition";

export function transferNotificationAccess(userId: string) {
  return sql`(${notificationTable.type}='doska.member_department_changed'
    AND ${notificationTable.resourceType}='doska.project'
    AND EXISTS (SELECT 1 FROM project np
      JOIN project_member nm ON nm.project_id=np.id
      WHERE np.id=${notificationTable.resourceId} AND np.owner_user_id=${userId}
        AND nm.user_id=${notificationTable.eventData}->>'userId'
        AND nm.role IN ('participant','observer')
        AND ${readProjectCondition(userId, sql`np.id`)}))`;
}
