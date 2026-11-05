import { publishLiveChanges } from "../live/publisher";
import { and, eq, inArray } from "drizzle-orm";
import {
  notificationTable,
  projectMemberTable,
  projectTable,
} from "../../database/schema";
import { getProjectCapabilities } from "../project-access";
import type { Transaction } from "../projects/transaction";
export type DepartmentTransfer = {
  userId: string;
  fromDepartmentId: string | null;
  toDepartmentId: string | null;
  identityRevision: number;
};
/** Directory publication holds its exclusive lock through this transaction. */
export async function persistDepartmentTransfers(
  tx: Transaction,
  changes: readonly DepartmentTransfer[],
  now = new Date(),
) {
  for (const change of changes) {
    const projects = await tx
      .select({ id: projectTable.id, ownerUserId: projectTable.ownerUserId })
      .from(projectTable)
      .innerJoin(
        projectMemberTable,
        eq(projectMemberTable.projectId, projectTable.id),
      )
      .where(
        and(
          eq(projectMemberTable.userId, change.userId),
          inArray(projectMemberTable.role, ["participant", "observer"]),
        ),
      );
    for (const project of projects) {
      if (!project.ownerUserId || project.ownerUserId === change.userId)
        continue;
      if (
        !(
          await getProjectCapabilities(project.ownerUserId, project.id, {
            database: tx,
            now,
          })
        ).readContent
      )
        continue;
      await tx.insert(notificationTable).values({
        userId: project.ownerUserId,
        type: "doska.member_department_changed",
        resourceType: "doska.project",
        resourceId: project.id,
        eventData: {
          userId: change.userId,
          fromDepartmentId: change.fromDepartmentId,
          toDepartmentId: change.toDepartmentId,
          identityRevision: change.identityRevision,
        },
      });
      await publishLiveChanges(tx, [
        {
          kind: "personal",
          userIds: [project.ownerUserId],
          scopes: ["notifications"],
        },
      ]);
    }
  }
}
