import { publishProjectMutation } from "../live/publications";
import { and, eq, gt, lte } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  columnTable,
  platformDepartmentTable,
  projectAuditTable,
  projectMemberTable,
  projectTable,
  workspaceTable,
} from "../../database/schema";
import {
  lockProjectOrdering,
  nextProjectPosition,
} from "../../project/controllers/project-placement";
import { findProjectKeyConflict } from "../../project/project-key";
import { getProjectCapabilities } from "../project-access";
import { removeProjectTaskAssignments } from "../tasks/remove-assignments";
import type { ProjectCapabilities } from "../project-policy";
import { lockDirectory, freshIdentity, type Transaction } from "./transaction";

export const DOSKA_WORKSPACE_ID = "doska-platform";
export type CreateProjectInput = {
  name: string;
  slug: string;
  icon: string;
  visibility: "department" | "private";
  description?: string;
};
export type UpdateProjectInput = {
  expectedRevision: number;
  name?: string;
  icon?: string;
  description?: string | null;
  visibility?: "department" | "private";
};

type Project = typeof projectTable.$inferSelect;
type Capability =
  | "manageSettings"
  | "archiveProject"
  | "transferOwnership"
  | "readManagementMetadata";
const metadata = (project: Project) => ({
  id: project.id,
  name: project.name,
  ownerUserId: project.ownerUserId!,
  archivedAt: project.archivedAt,
  revision: project.revision,
});
const unavailable = () =>
  new HTTPException(404, { message: "Project not found" });
const expired = () =>
  new HTTPException(403, { message: "Current Platform identity is required" });

export async function creationContext(
  database: Pick<typeof db, "select">,
  userId: string,
) {
  const now = new Date();
  const identity = await freshIdentity(database, userId, now);
  const [department] = identity?.departmentId
    ? await database
        .select({ id: platformDepartmentTable.id })
        .from(platformDepartmentTable)
        .where(
          and(
            eq(platformDepartmentTable.id, identity.departmentId),
            eq(platformDepartmentTable.active, true),
            lte(platformDepartmentTable.observedAt, now),
            gt(platformDepartmentTable.validUntil, now),
          ),
        )
        .limit(1)
    : [];
  return {
    workspaceId: DOSKA_WORKSPACE_ID,
    canCreateProject: Boolean(department),
    departmentId: department?.id ?? null,
  };
}
export async function getCreationContext(userId: string) {
  return creationContext(db, userId);
}
function authorize(capabilities: ProjectCapabilities, capability: Capability) {
  if (!capabilities.readManagementMetadata) throw unavailable();
  if (!capabilities[capability])
    throw new HTTPException(403, {
      message: "Project operation is not permitted",
    });
}
async function lockedProject(
  tx: Transaction,
  userId: string,
  projectId: string,
  capability: Capability,
  expectedRevision?: number,
) {
  await lockDirectory(tx);
  const [project] = await tx
    .select()
    .from(projectTable)
    .where(eq(projectTable.id, projectId))
    .for("update");
  const capabilities = await getProjectCapabilities(userId, projectId, {
    database: tx,
  });
  authorize(capabilities, capability);
  if (!project) throw unavailable();
  if (expectedRevision !== undefined && project.revision !== expectedRevision)
    throw new HTTPException(409, { message: "Project revision conflict" });
  return project;
}
async function audit(
  tx: Transaction,
  userId: string,
  operation: string,
  before: Project | null,
  after: Project,
) {
  await tx.insert(projectAuditTable).values({
    projectId: after.id,
    actorUserId: userId,
    operation,
    payload: {
      before: before ? metadata(before) : null,
      after: metadata(after),
    },
  });
  await publishProjectMutation(tx, before, after);
}
async function recheck(
  tx: Transaction,
  userId: string,
  before: Project,
  capability: Capability,
) {
  // Ownership may have just been transferred. The locked original owner remains
  // authorized for this operation, but its identity and directory lease must live.
  if (before.ownerUserId === userId) {
    if (!(await freshIdentity(tx, userId))) throw expired();
  } else {
    authorize(
      await getProjectCapabilities(userId, before.id, { database: tx }),
      capability,
    );
  }
}
export async function createProject(userId: string, input: CreateProjectInput) {
  return db.transaction((tx) => createProjectInTransaction(tx, userId, input));
}

/** Caller owns the transaction and must recheck freshness after any further writes. */
export async function createProjectInTransaction(
  tx: Transaction,
  userId: string,
  input: CreateProjectInput,
  options: { initializeColumns?: boolean } = {},
) {
  await lockDirectory(tx);
  const context = await creationContext(tx, userId);
  if (!context.canCreateProject || !context.departmentId) throw expired();
  await tx
    .insert(workspaceTable)
    .values({
      id: DOSKA_WORKSPACE_ID,
      slug: DOSKA_WORKSPACE_ID,
      name: "Doska",
      createdAt: new Date(),
    })
    .onConflictDoNothing({ target: workspaceTable.id });
  await lockProjectOrdering(tx, DOSKA_WORKSPACE_ID);
  if (await findProjectKeyConflict(tx, DOSKA_WORKSPACE_ID, input.slug))
    throw new HTTPException(409, { message: "Project key unavailable" });
  const [project] = await tx
    .insert(projectTable)
    .values({
      ...input,
      workspaceId: DOSKA_WORKSPACE_ID,
      ownerUserId: userId,
      departmentId: context.departmentId,
      position: await nextProjectPosition(tx, DOSKA_WORKSPACE_ID),
    })
    .returning();
  if (!project) throw new Error("Project insert failed");
  if (options.initializeColumns !== false) {
    const columns = [
      {
        name: "Запланировано",
        slug: "planned",
        semanticState: "planned" as const,
      },
      { name: "К работе", slug: "ready", semanticState: "planned" as const },
      {
        name: "В работе",
        slug: "in-progress",
        semanticState: "active" as const,
      },
      { name: "На проверке", slug: "review", semanticState: "active" as const },
      { name: "Готово", slug: "done", semanticState: "completed" as const },
    ];
    await tx.insert(columnTable).values(
      columns.map((column, position) => ({
        ...column,
        projectId: project.id,
        position,
        isFinal: column.semanticState === "completed",
      })),
    );
  }
  await audit(tx, userId, "project.created", null, project);
  const latest = await creationContext(tx, userId);
  if (!latest.canCreateProject || latest.departmentId !== context.departmentId)
    throw expired();
  return metadata(project);
}
async function mutate(
  userId: string,
  projectId: string,
  expectedRevision: number,
  capability: Capability,
  operation: string,
  changes: (
    tx: Transaction,
    project: Project,
  ) => Promise<Partial<typeof projectTable.$inferInsert>>,
) {
  return db.transaction(async (tx) => {
    const before = await lockedProject(
      tx,
      userId,
      projectId,
      capability,
      expectedRevision,
    );
    const patch = await changes(tx, before);
    const changed = Object.entries(patch).some(([key, value]) => {
      const old = before[key as keyof Project];
      return old instanceof Date && value instanceof Date
        ? old.getTime() !== value.getTime()
        : old !== value;
    });
    if (!changed) {
      await recheck(tx, userId, before, capability);
      return metadata(before);
    }
    const [after] = await tx
      .update(projectTable)
      .set({ ...patch, revision: before.revision + 1 })
      .where(eq(projectTable.id, projectId))
      .returning();
    if (!after) throw unavailable();
    if (before.ownerUserId && after.ownerUserId !== before.ownerUserId) {
      const [participant] = await tx
        .select({ id: projectMemberTable.id })
        .from(projectMemberTable)
        .where(
          and(
            eq(projectMemberTable.projectId, projectId),
            eq(projectMemberTable.userId, before.ownerUserId),
            eq(projectMemberTable.role, "participant"),
          ),
        );
      if (!participant)
        await removeProjectTaskAssignments(
          tx,
          userId,
          projectId,
          before.ownerUserId,
        );
    }
    await audit(tx, userId, operation, before, after);
    await recheck(tx, userId, before, capability);
    // A target identity can expire while a slow audit insertion is executing.
    if (
      after.ownerUserId !== before.ownerUserId &&
      !(await freshIdentity(tx, after.ownerUserId!))
    )
      throw expired();
    return metadata(after);
  });
}
export async function updateProject(
  userId: string,
  projectId: string,
  input: UpdateProjectInput,
) {
  const { expectedRevision, ...patch } = input;
  return mutate(
    userId,
    projectId,
    expectedRevision,
    "manageSettings",
    "project.updated",
    async () =>
      Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      ),
  );
}
export async function archiveProject(
  userId: string,
  projectId: string,
  input: { expectedRevision: number; archived: boolean },
) {
  return mutate(
    userId,
    projectId,
    input.expectedRevision,
    "archiveProject",
    input.archived ? "project.archived" : "project.restored",
    async (_tx, project) => ({
      archivedAt: input.archived ? (project.archivedAt ?? new Date()) : null,
    }),
  );
}
export async function transferProject(
  userId: string,
  projectId: string,
  input: { expectedRevision: number; newOwnerUserId: string },
) {
  return mutate(
    userId,
    projectId,
    input.expectedRevision,
    "transferOwnership",
    "project.ownership_transferred",
    async (tx) => {
      if (!(await freshIdentity(tx, input.newOwnerUserId)))
        throw new HTTPException(400, { message: "Owner identity unavailable" });
      return { ownerUserId: input.newOwnerUserId };
    },
  );
}
export async function getManagementMetadata(userId: string, projectId: string) {
  return db.transaction(async (tx) => {
    const project = await lockedProject(
      tx,
      userId,
      projectId,
      "readManagementMetadata",
    );
    await recheck(tx, userId, project, "readManagementMetadata");
    return metadata(project);
  });
}
