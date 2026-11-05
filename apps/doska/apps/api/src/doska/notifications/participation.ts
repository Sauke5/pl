import { publishLiveChanges } from "../live/publisher";
import { sql } from "drizzle-orm";
import { notificationTable } from "../../database/schema";
import { getProjectCapabilities } from "../project-access";
import { readProjectCondition } from "../read-project-condition";
import { freshIdentity, type Transaction } from "../projects/transaction";
export const participationTypes = [
  "doska.invitation_created",
  "doska.invitation_accepted",
  "doska.invitation_declined",
  "doska.join_requested",
  "doska.join_approved",
  "doska.join_rejected",
] as const;
export function participationAccess(userId: string) {
  return sql`(
    EXISTS (SELECT 1 FROM platform_user_identity ni CROSS JOIN platform_directory_state ns
      WHERE ni.user_id=${userId} AND ni.active=true AND ni.observed_at<=timezone('utc',statement_timestamp()) AND ni.valid_until>timezone('utc',statement_timestamp())
      AND ns.id='directory' AND ns.observed_at<=timezone('utc',statement_timestamp()) AND ns.valid_until>timezone('utc',statement_timestamp()))
    AND (
      (${notificationTable.resourceType}='doska.invitation' AND EXISTS (
        SELECT 1 FROM project_invitation ni JOIN project np ON np.id=ni.project_id
        WHERE ni.id=${notificationTable.resourceId} AND (
          (${notificationTable.type}='doska.invitation_created' AND ni.invitee_user_id=${userId} AND (
            ni.status='pending' OR (ni.status='accepted' AND ${readProjectCondition(userId, sql`np.id`)})
          )) OR (
            np.owner_user_id=${userId} AND ${readProjectCondition(userId, sql`np.id`)} AND (
              (${notificationTable.type}='doska.invitation_accepted' AND ni.status='accepted') OR
              (${notificationTable.type}='doska.invitation_declined' AND ni.status='declined')
            )
          )
        )
      )) OR (${notificationTable.resourceType}='doska.join_request' AND EXISTS (
        SELECT 1 FROM project_join_request nr JOIN project np ON np.id=nr.project_id
        WHERE nr.id=${notificationTable.resourceId} AND (
          (${notificationTable.type}='doska.join_requested' AND nr.status='pending' AND np.owner_user_id=${userId}
            AND ${readProjectCondition(userId, sql`np.id`)} AND np.visibility='department' AND np.archived_at IS NULL
            AND np.owner_user_id<>nr.applicant_user_id
            AND ${readProjectCondition(sql`nr.applicant_user_id`, sql`np.id`)}
            AND EXISTS (SELECT 1 FROM platform_user_identity na WHERE na.user_id=nr.applicant_user_id AND na.primary_department_id=np.department_id)
            AND NOT EXISTS (SELECT 1 FROM project_member nm WHERE nm.project_id=np.id AND nm.user_id=nr.applicant_user_id))
          OR (nr.applicant_user_id=${userId} AND ${readProjectCondition(userId, sql`np.id`)} AND (
            (${notificationTable.type}='doska.join_approved' AND nr.status='approved') OR
            (${notificationTable.type}='doska.join_rejected' AND nr.status='rejected')
          ))
        )
      ))
    )
  )`;
}
export async function persistParticipationNotification(
  tx: Transaction,
  input: {
    actorId: string;
    userId: string | null;
    projectId: string;
    resourceId: string;
    type: (typeof participationTypes)[number];
  },
) {
  if (
    !input.userId ||
    input.userId === input.actorId ||
    !(await freshIdentity(tx, input.userId))
  )
    return;
  if (
    input.type !== "doska.invitation_created" &&
    !(
      await getProjectCapabilities(input.userId, input.projectId, {
        database: tx,
      })
    ).readContent
  )
    return;
  await tx.insert(notificationTable).values({
    userId: input.userId,
    type: input.type,
    resourceType: input.type.startsWith("doska.invitation_")
      ? "doska.invitation"
      : "doska.join_request",
    resourceId: input.resourceId,
    eventData: { actorId: input.actorId },
  });
  await publishLiveChanges(tx, [
    { kind: "personal", userIds: [input.userId], scopes: ["notifications"] },
  ]);
}
