import { publishLiveChanges } from "../live/publisher";
import { and, asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  projectAuditTable,
  projectInvitationTable,
  projectMemberTable,
  projectTable,
  userTable,
} from "../../database/schema";
import { persistParticipationNotification } from "../notifications/participation";
import { getProjectCapabilities } from "../project-access";
import {
  lockDirectory,
  lockProject,
  requireFreshIdentity,
  type Transaction,
} from "./transaction";

type Invitation = typeof projectInvitationTable.$inferSelect;
type Page = { limit: number; offset: number };
const fields = {
  inviteeName: userTable.name,
  id: projectInvitationTable.id,
  projectId: projectInvitationTable.projectId,
  inviteeUserId: projectInvitationTable.inviteeUserId,
  role: projectInvitationTable.role,
  status: projectInvitationTable.status,
  createdAt: projectInvitationTable.createdAt,
  resolvedAt: projectInvitationTable.resolvedAt,
};
const dto = async (tx: Transaction, row: Invitation) => {
  const [user] = await tx
    .select({ name: userTable.name })
    .from(userTable)
    .where(eq(userTable.id, row.inviteeUserId))
    .limit(1);
  return {
    inviteeName: user?.name ?? null,
    id: row.id,
    projectId: row.projectId,
    inviteeUserId: row.inviteeUserId,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
};
function pagination({ limit, offset }: Page) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new HTTPException(400, {
      message: "Pagination requires limit 1..100 and nonnegative offset",
    });
}
async function owner(tx: Transaction, actorId: string, projectId: string) {
  await requireFreshIdentity(tx, actorId);
  const caps = await getProjectCapabilities(actorId, projectId, {
    database: tx,
  });
  if (!caps.readManagementMetadata)
    throw new HTTPException(404, { message: "Project not found" });
  if (!caps.manageParticipants)
    throw new HTTPException(403, {
      message: "Project operation is not permitted",
    });
}
function conflict() {
  return new HTTPException(409, {
    message: "Invitation conflicts with current project state",
  });
}
async function noMembership(
  tx: Transaction,
  project: typeof projectTable.$inferSelect,
  userId: string,
) {
  if (project.ownerUserId === userId) throw conflict();
  const [member] = await tx
    .select({ id: projectMemberTable.id })
    .from(projectMemberTable)
    .where(
      and(
        eq(projectMemberTable.projectId, project.id),
        eq(projectMemberTable.userId, userId),
      ),
    )
    .limit(1);
  if (member) throw conflict();
}
async function audit(
  tx: Transaction,
  actorId: string,
  invitation: Invitation,
  before: string | null,
) {
  await tx.insert(projectAuditTable).values({
    projectId: invitation.projectId,
    actorUserId: actorId,
    operation: `project.invitation.${invitation.status === "pending" ? "created" : invitation.status}`,
    payload: {
      invitationId: invitation.id,
      inviteeUserId: invitation.inviteeUserId,
      role: invitation.role,
      before,
      after: invitation.status,
    },
  });
  await publishLiveChanges(tx, [
    {
      kind: "project",
      projectId: invitation.projectId,
      scopes: ["invitations", "members", "access"],
    },
    {
      kind: "personal",
      userIds: [invitation.inviteeUserId, actorId],
      scopes: ["invitations", "projects", "access"],
    },
  ]);
}
export async function inviteProject(
  actorId: string,
  projectId: string,
  input: { inviteeUserId: string; role: "participant" | "observer" },
) {
  if (!["participant", "observer"].includes(input.role))
    throw new HTTPException(400, { message: "Invalid invitation role" });
  return db.transaction(async (tx) => {
    await lockDirectory(tx);
    const project = await lockProject(tx, projectId);
    await owner(tx, actorId, projectId);
    await requireFreshIdentity(tx, input.inviteeUserId);
    if (project.archivedAt) throw conflict();
    await noMembership(tx, project, input.inviteeUserId);
    const [invitation] = await tx
      .insert(projectInvitationTable)
      .values({
        projectId,
        inviteeUserId: input.inviteeUserId,
        role: input.role,
        createdBy: actorId,
      })
      .onConflictDoNothing()
      .returning();
    if (!invitation) throw conflict();
    const result = await dto(tx, invitation);
    await audit(tx, actorId, invitation, null);
    await persistParticipationNotification(tx, {
      actorId,
      userId: invitation.inviteeUserId,
      projectId,
      resourceId: invitation.id,
      type: "doska.invitation_created",
    });
    await owner(tx, actorId, projectId);
    await requireFreshIdentity(tx, input.inviteeUserId);
    return result;
  });
}
async function resolve(
  actorId: string,
  projectId: string,
  invitationId: string,
  status: "accepted" | "declined" | "revoked",
) {
  return db.transaction(async (tx) => {
    await lockDirectory(tx);
    const project = await lockProject(tx, projectId);
    await requireFreshIdentity(tx, actorId);
    if (status === "revoked") await owner(tx, actorId, projectId);
    const [invitation] = await tx
      .select()
      .from(projectInvitationTable)
      .where(
        and(
          eq(projectInvitationTable.id, invitationId),
          eq(projectInvitationTable.projectId, projectId),
          status === "revoked"
            ? undefined
            : eq(projectInvitationTable.inviteeUserId, actorId),
        ),
      )
      .limit(1);
    if (!invitation)
      throw new HTTPException(404, { message: "Invitation not found" });
    if (invitation.status !== "pending") throw conflict();
    if (status === "accepted") {
      await requireFreshIdentity(tx, invitation.inviteeUserId);
      if (project.archivedAt) throw conflict();
      await noMembership(tx, project, actorId);
      const [member] = await tx
        .insert(projectMemberTable)
        .values({ projectId, userId: actorId, role: invitation.role })
        .onConflictDoNothing()
        .returning({ id: projectMemberTable.id });
      if (!member) throw conflict();
    }
    const [updated] = await tx
      .update(projectInvitationTable)
      .set({ status, resolvedAt: new Date() })
      .where(eq(projectInvitationTable.id, invitationId))
      .returning();
    if (!updated) throw conflict();
    const result = await dto(tx, updated);
    await audit(tx, actorId, updated, invitation.status);
    if (status !== "revoked")
      await persistParticipationNotification(tx, {
        actorId,
        userId: project.ownerUserId,
        projectId,
        resourceId: updated.id,
        type:
          status === "accepted"
            ? "doska.invitation_accepted"
            : "doska.invitation_declined",
      });
    await requireFreshIdentity(tx, actorId);
    if (status === "accepted")
      await requireFreshIdentity(tx, invitation.inviteeUserId);
    if (status === "revoked") await owner(tx, actorId, projectId);
    return result;
  });
}
export async function respondInvitation(
  actorId: string,
  projectId: string,
  invitationId: string,
  input: { accept: boolean },
) {
  return resolve(
    actorId,
    projectId,
    invitationId,
    input.accept ? "accepted" : "declined",
  );
}
export async function revokeInvitation(
  actorId: string,
  projectId: string,
  invitationId: string,
) {
  return resolve(actorId, projectId, invitationId, "revoked");
}
export async function listProjectInvitations(
  actorId: string,
  projectId: string,
  page: Page,
) {
  pagination(page);
  return db.transaction(async (tx) => {
    await lockDirectory(tx);
    await lockProject(tx, projectId);
    await owner(tx, actorId, projectId);
    const rows = await tx
      .select(fields)
      .from(projectInvitationTable)
      .leftJoin(
        userTable,
        eq(userTable.id, projectInvitationTable.inviteeUserId),
      )
      .where(
        and(
          eq(projectInvitationTable.projectId, projectId),
          eq(projectInvitationTable.status, "pending"),
        ),
      )
      .orderBy(
        asc(projectInvitationTable.createdAt),
        asc(projectInvitationTable.id),
      )
      .limit(page.limit)
      .offset(page.offset);
    await owner(tx, actorId, projectId);
    return rows;
  });
}
export async function listMyInvitations(actorId: string, page: Page) {
  pagination(page);
  return db.transaction(async (tx) => {
    await lockDirectory(tx);
    await requireFreshIdentity(tx, actorId);
    const rows = await tx
      .select({
        ...fields,
        projectName: projectTable.name,
        projectArchivedAt: projectTable.archivedAt,
      })
      .from(projectInvitationTable)
      .leftJoin(
        userTable,
        eq(userTable.id, projectInvitationTable.inviteeUserId),
      )
      .innerJoin(
        projectTable,
        eq(projectTable.id, projectInvitationTable.projectId),
      )
      .where(
        and(
          eq(projectInvitationTable.inviteeUserId, actorId),
          eq(projectInvitationTable.status, "pending"),
        ),
      )
      .orderBy(
        asc(projectInvitationTable.createdAt),
        asc(projectInvitationTable.id),
      )
      .limit(page.limit)
      .offset(page.offset);
    await requireFreshIdentity(tx, actorId);
    return rows;
  });
}
