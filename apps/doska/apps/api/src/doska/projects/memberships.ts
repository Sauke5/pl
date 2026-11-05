import { publishLiveChanges } from "../live/publisher";
import { and, asc, eq, gt, lte, getTableColumns } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  platformDepartmentTable,
  projectAuditTable,
  projectJoinRequestTable,
  projectMemberTable,
  projectTable,
  userTable,
} from "../../database/schema";
import { persistParticipationNotification } from "../notifications/participation";
import { getProjectCapabilities } from "../project-access";
import { removeProjectTaskAssignments } from "../tasks/remove-assignments";
import {
  freshIdentity,
  lockDirectory,
  lockProject,
  requireFreshIdentity,
  type Transaction,
} from "./transaction";

type Project = typeof projectTable.$inferSelect;
type Role = "participant" | "observer";
type Page = { limit: number; offset: number };
const missing = () =>
  new HTTPException(404, { message: "Project resource not found" });
const conflict = () =>
  new HTTPException(409, { message: "Project participation state conflict" });
function pagination({ limit, offset }: Page) {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0
  )
    throw new HTTPException(400, { message: "Invalid pagination" });
}
async function locked(tx: Transaction, actorId: string, projectId: string) {
  await lockDirectory(tx);
  const project = await lockProject(tx, projectId);
  await requireFreshIdentity(tx, actorId);
  return project;
}
async function owner(tx: Transaction, actorId: string, projectId: string) {
  const capabilities = await getProjectCapabilities(actorId, projectId, {
    database: tx,
  });
  if (!capabilities.readManagementMetadata) throw missing();
  if (!capabilities.manageParticipants)
    throw new HTTPException(403, {
      message: "Only the project owner can manage participation",
    });
}
async function member(tx: Transaction, projectId: string, userId: string) {
  const [row] = await tx
    .select()
    .from(projectMemberTable)
    .where(
      and(
        eq(projectMemberTable.projectId, projectId),
        eq(projectMemberTable.userId, userId),
      ),
    );
  return row;
}
async function eligible(
  tx: Transaction,
  project: Project,
  userId: string,
  membershipGranted = false,
) {
  const now = new Date();
  const identity = await freshIdentity(tx, userId, now);
  if (
    !identity ||
    !project.departmentId ||
    identity.departmentId !== project.departmentId ||
    project.visibility !== "department" ||
    project.archivedAt ||
    project.ownerUserId === userId
  )
    return false;
  const [department] = await tx
    .select({ id: platformDepartmentTable.id })
    .from(platformDepartmentTable)
    .where(
      and(
        eq(platformDepartmentTable.id, project.departmentId),
        eq(platformDepartmentTable.active, true),
        lte(platformDepartmentTable.observedAt, now),
        gt(platformDepartmentTable.validUntil, now),
      ),
    );
  return (
    Boolean(department) &&
    (membershipGranted || !(await member(tx, project.id, userId)))
  );
}
async function audit(
  tx: Transaction,
  actorId: string,
  projectId: string,
  operation: string,
  payload: Record<string, unknown>,
) {
  await tx
    .insert(projectAuditTable)
    .values({ actorUserId: actorId, projectId, operation, payload });
  const affected = [actorId, payload.userId, payload.applicantUserId].filter(
    (id): id is string => typeof id === "string",
  );
  await publishLiveChanges(tx, [
    {
      kind: "project",
      projectId,
      scopes: ["members", "access", "join-requests", "project"],
    },
    { kind: "personal", userIds: affected, scopes: ["access", "projects"] },
  ]);
}
async function requestById(
  tx: Transaction,
  projectId: string,
  requestId: string,
) {
  const [request] = await tx
    .select()
    .from(projectJoinRequestTable)
    .where(
      and(
        eq(projectJoinRequestTable.projectId, projectId),
        eq(projectJoinRequestTable.id, requestId),
      ),
    );
  if (!request) throw missing();
  return request;
}
async function joinRequestDTO(
  tx: Transaction,
  row: typeof projectJoinRequestTable.$inferSelect,
) {
  const [user] = await tx
    .select({ name: userTable.name })
    .from(userTable)
    .where(eq(userTable.id, row.applicantUserId))
    .limit(1);
  return { ...row, applicantName: user?.name ?? null };
}

export async function requestProjectJoin(actorId: string, projectId: string) {
  return db.transaction(async (tx) => {
    const project = await locked(tx, actorId, projectId);
    if (
      project.ownerUserId === actorId ||
      (await member(tx, projectId, actorId))
    )
      throw conflict();
    const capabilities = await getProjectCapabilities(actorId, projectId, {
      database: tx,
    });
    if (!capabilities.readContent) throw missing();
    if (!(await eligible(tx, project, actorId))) throw conflict();
    const [existing] = await tx
      .select({ id: projectJoinRequestTable.id })
      .from(projectJoinRequestTable)
      .where(
        and(
          eq(projectJoinRequestTable.projectId, projectId),
          eq(projectJoinRequestTable.applicantUserId, actorId),
          eq(projectJoinRequestTable.status, "pending"),
        ),
      );
    if (existing) throw conflict();
    const [request] = await tx
      .insert(projectJoinRequestTable)
      .values({ projectId, applicantUserId: actorId })
      .returning();
    if (!request) throw new Error("Join request insert failed");
    await audit(tx, actorId, projectId, "project.join_requested", {
      requestId: request.id,
      applicantUserId: actorId,
    });
    await persistParticipationNotification(tx, {
      actorId,
      userId: project.ownerUserId,
      projectId,
      resourceId: request.id,
      type: "doska.join_requested",
    });
    const result = await joinRequestDTO(tx, request);
    await requireFreshIdentity(tx, actorId);
    if (!(await eligible(tx, project, actorId))) throw conflict();
    return result;
  });
}
export async function resolveProjectJoin(
  actorId: string,
  projectId: string,
  requestId: string,
  { approve }: { approve: boolean },
) {
  return db.transaction(async (tx) => {
    const project = await locked(tx, actorId, projectId);
    await owner(tx, actorId, projectId);
    const request = await requestById(tx, projectId, requestId);
    if (request.status !== "pending") throw conflict();
    if (approve && !(await eligible(tx, project, request.applicantUserId)))
      throw conflict();
    const [resolved] = await tx
      .update(projectJoinRequestTable)
      .set({
        status: approve ? "approved" : "rejected",
        resolvedBy: actorId,
        resolvedAt: new Date(),
      })
      .where(eq(projectJoinRequestTable.id, requestId))
      .returning();
    // Recheck eligibility after the audit, before inserting membership: eligibility excludes members.
    await audit(
      tx,
      actorId,
      projectId,
      approve ? "project.join_approved" : "project.join_rejected",
      { requestId, applicantUserId: request.applicantUserId },
    );
    if (approve) {
      if (!(await eligible(tx, project, request.applicantUserId)))
        throw conflict();
      await tx.insert(projectMemberTable).values({
        projectId,
        userId: request.applicantUserId,
        role: "participant",
      });
      if (!(await eligible(tx, project, request.applicantUserId, true)))
        throw conflict();
    }
    await persistParticipationNotification(tx, {
      actorId,
      userId: request.applicantUserId,
      projectId,
      resourceId: request.id,
      type: approve ? "doska.join_approved" : "doska.join_rejected",
    });
    const result = await joinRequestDTO(tx, resolved!);
    await requireFreshIdentity(tx, actorId);
    return result;
  });
}
export async function cancelProjectJoin(
  actorId: string,
  projectId: string,
  requestId: string,
) {
  return db.transaction(async (tx) => {
    await locked(tx, actorId, projectId);
    const request = await requestById(tx, projectId, requestId);
    if (request.applicantUserId !== actorId) throw missing();
    if (request.status !== "pending") throw conflict();
    const [resolved] = await tx
      .update(projectJoinRequestTable)
      .set({ status: "cancelled", resolvedBy: actorId, resolvedAt: new Date() })
      .where(eq(projectJoinRequestTable.id, requestId))
      .returning();
    await audit(tx, actorId, projectId, "project.join_cancelled", {
      requestId,
      applicantUserId: actorId,
    });
    const result = await joinRequestDTO(tx, resolved!);
    await requireFreshIdentity(tx, actorId);
    return result;
  });
}
export async function listProjectJoinRequests(
  actorId: string,
  projectId: string,
  page: Page,
) {
  pagination(page);
  return db.transaction(async (tx) => {
    await locked(tx, actorId, projectId);
    const capabilities = await getProjectCapabilities(actorId, projectId, {
      database: tx,
    });
    if (!capabilities.readContent) throw missing();
    const rows = await tx
      .select({
        ...getTableColumns(projectJoinRequestTable),
        applicantName: userTable.name,
      })
      .from(projectJoinRequestTable)
      .leftJoin(
        userTable,
        eq(userTable.id, projectJoinRequestTable.applicantUserId),
      )
      .where(
        and(
          eq(projectJoinRequestTable.projectId, projectId),
          eq(projectJoinRequestTable.status, "pending"),
          capabilities.manageParticipants
            ? undefined
            : eq(projectJoinRequestTable.applicantUserId, actorId),
        ),
      )
      .orderBy(
        asc(projectJoinRequestTable.createdAt),
        asc(projectJoinRequestTable.id),
      )
      .limit(page.limit)
      .offset(page.offset);
    await requireFreshIdentity(tx, actorId);
    return rows;
  });
}
const memberFields = {
  id: projectMemberTable.id,
  projectId: projectMemberTable.projectId,
  userId: projectMemberTable.userId,
  name: userTable.name,
  role: projectMemberTable.role,
  createdAt: projectMemberTable.createdAt,
};
export async function listProjectMembers(
  actorId: string,
  projectId: string,
  page: Page,
) {
  pagination(page);
  return db.transaction(async (tx) => {
    const project = await locked(tx, actorId, projectId);
    if (
      !(await getProjectCapabilities(actorId, projectId, { database: tx }))
        .readContent
    )
      throw missing();
    const rows = await tx
      .select(memberFields)
      .from(projectMemberTable)
      .innerJoin(userTable, eq(userTable.id, projectMemberTable.userId))
      .where(eq(projectMemberTable.projectId, projectId))
      .orderBy(asc(projectMemberTable.createdAt), asc(projectMemberTable.id))
      .limit(page.limit)
      .offset(page.offset);
    const [projectOwner] = await tx
      .select({ userId: userTable.id, name: userTable.name })
      .from(userTable)
      .where(eq(userTable.id, project.ownerUserId!));
    if (!projectOwner) throw missing();
    await requireFreshIdentity(tx, actorId);
    if (
      !(await getProjectCapabilities(actorId, projectId, { database: tx }))
        .readContent
    )
      throw missing();
    return { owner: projectOwner, members: rows };
  });
}
async function membership(
  tx: Transaction,
  project: Project,
  memberId: string,
  expectedRole: Role,
) {
  const [row] = await tx
    .select(memberFields)
    .from(projectMemberTable)
    .innerJoin(userTable, eq(userTable.id, projectMemberTable.userId))
    .where(
      and(
        eq(projectMemberTable.id, memberId),
        eq(projectMemberTable.projectId, project.id),
      ),
    );
  if (!row) throw missing();
  if (row.userId === project.ownerUserId || row.role !== expectedRole)
    throw conflict();
  return row;
}
export async function changeProjectMember(
  actorId: string,
  projectId: string,
  memberId: string,
  { expectedRole, role }: { expectedRole: Role; role: Role },
) {
  if (!["participant", "observer"].includes(role))
    throw new HTTPException(400, { message: "Invalid member role" });
  return db.transaction(async (tx) => {
    const project = await locked(tx, actorId, projectId);
    await owner(tx, actorId, projectId);
    const before = await membership(tx, project, memberId, expectedRole);
    if (before.role !== role) {
      if (role === "participant") await requireFreshIdentity(tx, before.userId);
      await tx
        .update(projectMemberTable)
        .set({ role })
        .where(eq(projectMemberTable.id, memberId));
      await audit(tx, actorId, projectId, "project.member_role_changed", {
        memberId,
        userId: before.userId,
        before: before.role,
        after: role,
      });
      if (role === "observer")
        await removeProjectTaskAssignments(
          tx,
          actorId,
          projectId,
          before.userId,
        );
      if (role === "participant") await requireFreshIdentity(tx, before.userId);
    }
    await requireFreshIdentity(tx, actorId);
    return { ...before, role };
  });
}
export async function removeProjectMember(
  actorId: string,
  projectId: string,
  memberId: string,
  { expectedRole }: { expectedRole: Role },
) {
  return db.transaction(async (tx) => {
    const project = await locked(tx, actorId, projectId);
    await owner(tx, actorId, projectId);
    const before = await membership(tx, project, memberId, expectedRole);
    await tx
      .delete(projectMemberTable)
      .where(eq(projectMemberTable.id, memberId));
    await audit(tx, actorId, projectId, "project.member_removed", {
      memberId,
      userId: before.userId,
      role: before.role,
    });
    await removeProjectTaskAssignments(tx, actorId, projectId, before.userId);
    await requireFreshIdentity(tx, actorId);
    return { id: memberId, status: "removed" as const };
  });
}
