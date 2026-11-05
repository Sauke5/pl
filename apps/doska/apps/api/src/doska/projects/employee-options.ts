import { and, asc, eq, gt, lte, ne, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { platformUserIdentityTable, userTable } from "../../database/schema";
import { getProjectCapabilities } from "../project-access";
import {
  lockDirectory,
  lockProject,
  requireFreshIdentity,
  type Transaction,
} from "./transaction";

type Options = {
  purpose: "invitation" | "ownership";
  q?: string;
  limit: number;
  offset: number;
};

async function authorize(
  tx: Transaction,
  actorId: string,
  projectId: string,
  purpose: Options["purpose"],
) {
  await requireFreshIdentity(tx, actorId);
  const capabilities = await getProjectCapabilities(actorId, projectId, {
    database: tx,
  });
  if (!capabilities.readManagementMetadata)
    throw new HTTPException(404, { message: "Project not found" });
  if (
    !(purpose === "invitation"
      ? capabilities.manageParticipants
      : capabilities.transferOwnership)
  )
    throw new HTTPException(403, {
      message: "Project operation is not permitted",
    });
}

export async function listEmployeeOptions(
  actorId: string,
  projectId: string,
  options: Options,
): Promise<{ userId: string; name: string; departmentId: string | null }[]> {
  if (
    !["invitation", "ownership"].includes(options.purpose) ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100 ||
    !Number.isSafeInteger(options.offset) ||
    options.offset < 0 ||
    options.offset > 10_000_000 ||
    (options.q !== undefined &&
      (typeof options.q !== "string" || options.q.length > 200))
  )
    throw new HTTPException(400, { message: "Invalid employee options query" });

  return db.transaction(async (tx) => {
    await lockDirectory(tx);
    const project = await lockProject(tx, projectId);
    await authorize(tx, actorId, projectId, options.purpose);
    if (options.purpose === "invitation" && project.archivedAt)
      throw new HTTPException(409, {
        message: "Invitation conflicts with current project state",
      });

    const now = new Date();
    const rows = await tx
      .select({
        userId: platformUserIdentityTable.userId,
        name: userTable.name,
        departmentId: platformUserIdentityTable.primaryDepartmentId,
        validUntil: platformUserIdentityTable.validUntil,
      })
      .from(platformUserIdentityTable)
      .innerJoin(userTable, eq(userTable.id, platformUserIdentityTable.userId))
      .where(
        and(
          eq(platformUserIdentityTable.active, true),
          lte(platformUserIdentityTable.observedAt, now),
          gt(platformUserIdentityTable.validUntil, now),
          ne(platformUserIdentityTable.userId, project.ownerUserId!),
          options.q
            ? sql`strpos(lower(${userTable.name}), lower(${options.q})) > 0`
            : undefined,
          options.purpose === "invitation"
            ? sql`NOT EXISTS (
                SELECT 1 FROM project_member AS member
                WHERE member.project_id = ${projectId}
                  AND member.user_id = ${platformUserIdentityTable.userId}
              ) AND NOT EXISTS (
                SELECT 1 FROM project_invitation AS invitation
                WHERE invitation.project_id = ${projectId}
                  AND invitation.invitee_user_id = ${platformUserIdentityTable.userId}
                  AND invitation.status = 'pending'
              )`
            : undefined,
        ),
      )
      .orderBy(asc(userTable.name), asc(platformUserIdentityTable.userId))
      .limit(options.limit)
      .offset(options.offset);
    await authorize(tx, actorId, projectId, options.purpose);
    const completedAt = new Date();
    return rows
      .filter((row) => row.validUntil > completedAt)
      .map(({ userId, name, departmentId }) => ({
        userId,
        name,
        departmentId,
      }));
  });
}
