/** Database policy foundation. HTTP, WebSocket and upstream queries must opt in. */
import { and, asc, eq, sql, type SQLWrapper } from "drizzle-orm";
import db from "../database";
import { projectTable } from "../database/schema";
import {
  projectCapabilities,
  type ProjectCapabilities,
} from "./project-policy";

type AccessDatabase = Pick<typeof db, "select">;

// Explicit qualification survives Drizzle's single-table SELECT rewriting;
// otherwise nested queries can resolve "id" against their own inner table.
const projectIdColumn = sql.raw('"project"."id"');
const departmentIdColumn = sql.raw('"project"."department_id"');
const ownerIdColumn = sql.raw('"project"."owner_user_id"');
const visibilityColumn = sql.raw('"project"."visibility"');

function freshDepartment(departmentId: SQLWrapper, now: Date) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM platform_department AS doska_department
    WHERE doska_department.id = ${departmentId}
      AND doska_department.active = true
      AND doska_department.observed_at <= ${now.toISOString()}
      AND doska_department.valid_until > ${now.toISOString()}
  )`;
}

function freshIdentity(userId: string, now: Date) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM platform_user_identity AS doska_identity
    WHERE doska_identity.user_id = ${userId}
      AND doska_identity.active = true
      AND doska_identity.observed_at <= ${now.toISOString()}
      AND doska_identity.valid_until > ${now.toISOString()}
      AND EXISTS (
        SELECT 1 FROM platform_directory_state AS doska_stream
        WHERE doska_stream.id = 'directory'
          AND doska_stream.observed_at <= ${now.toISOString()}
          AND doska_stream.valid_until > ${now.toISOString()}
      )
  )`;
}

function headsProjectDepartment(userId: string, now: Date) {
  return sql<boolean>`(
    ${freshDepartment(departmentIdColumn, now)} AND EXISTS (
      SELECT 1 FROM platform_department_head AS doska_head
      INNER JOIN platform_user_identity AS doska_head_identity
        ON doska_head_identity.user_id = doska_head.user_id
      INNER JOIN platform_department AS doska_head_department
        ON doska_head_department.id = doska_head.department_id
      WHERE doska_head.user_id = ${userId}
        AND doska_head.department_id = ${departmentIdColumn}
        AND doska_head_identity.head_department_ids ? doska_head.department_id
        AND doska_head_department.head_subjects ? doska_head_identity.subject
    )
  )`;
}

function resolvedProject() {
  return sql<boolean>`(
    ${ownerIdColumn} IS NOT NULL
    AND ${departmentIdColumn} IS NOT NULL
    AND ${visibilityColumn} IN ('department', 'private')
  )`;
}

/** Embed in the project query WHERE, before counts, limits or offsets. */
export function visibleProjectCondition(userId: string, now = new Date()) {
  return sql<boolean>`(
    ${resolvedProject()} AND ${freshIdentity(userId, now)} AND (
      ${ownerIdColumn} = ${userId}
      OR EXISTS (
        SELECT 1 FROM project_member AS doska_member
        WHERE doska_member.project_id = ${projectIdColumn}
          AND doska_member.user_id = ${userId}
          AND doska_member.role IN ('participant', 'observer')
      )
      OR (
        ${visibilityColumn} = 'department'
        AND ${freshDepartment(departmentIdColumn, now)}
        AND EXISTS (
          SELECT 1 FROM platform_user_identity AS doska_primary
          WHERE doska_primary.user_id = ${userId}
            AND doska_primary.primary_department_id = ${departmentIdColumn}
        )
      )
    )
  )`;
}

/** Owners and current department heads only; content readers do not qualify. */
export function managedProjectCondition(userId: string, now = new Date()) {
  return sql<boolean>`(
    ${resolvedProject()} AND ${freshIdentity(userId, now)} AND (
      ${ownerIdColumn} = ${userId} OR ${headsProjectDepartment(userId, now)}
    )
  )`;
}

/** Denied and nonexistent projects intentionally produce the same capability map. */
export async function getProjectCapabilities(
  userId: string,
  projectId: string,
  options: { now?: Date; database?: AccessDatabase } = {},
): Promise<ProjectCapabilities> {
  const { now = new Date(), database = db } = options;
  const [project] = await database
    .select({
      ownerUserId: projectTable.ownerUserId,
      departmentId: projectTable.departmentId,
      visibility: projectTable.visibility,
      primaryDepartmentId: sql<string | null>`(
      SELECT identity.primary_department_id FROM platform_user_identity AS identity
      WHERE identity.user_id = ${userId}
        AND ${freshDepartment(departmentIdColumn, now)}
    )`,
      membership: sql<"participant" | "observer" | null>`(
      SELECT member.role FROM project_member AS member
      WHERE member.project_id = ${projectIdColumn} AND member.user_id = ${userId}
    )`,
      head: headsProjectDepartment(userId, now),
    })
    .from(projectTable)
    .where(
      and(
        eq(projectTable.id, projectId),
        resolvedProject(),
        freshIdentity(userId, now),
        sql`(${visibleProjectCondition(userId, now)} OR ${headsProjectDepartment(userId, now)})`,
      ),
    )
    .limit(1);

  if (!project?.ownerUserId || !project.departmentId || !project.visibility) {
    return projectCapabilities(
      { userId, active: false, departmentHeadIds: [] },
      { ownerUserId: "", departmentId: "", visibility: "private" },
    );
  }
  return projectCapabilities(
    {
      userId,
      active: true,
      primaryDepartmentId: project.primaryDepartmentId,
      departmentHeadIds: project.head ? [project.departmentId] : [],
    },
    {
      ownerUserId: project.ownerUserId,
      departmentId: project.departmentId,
      visibility: project.visibility,
      membership: project.membership,
    },
  );
}

/** Content-visible project IDs only; heads without participation are excluded. */
export async function listVisibleProjectIds(
  userId: string,
  options: {
    now?: Date;
    database?: AccessDatabase;
    limit?: number;
    offset?: number;
  } = {},
): Promise<string[]> {
  const { now = new Date(), database = db, limit = 100, offset = 0 } = options;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    throw new RangeError(
      "Project pagination requires limit 1..1000 and nonnegative offset",
    );
  }
  const rows = await database
    .select({ id: projectTable.id })
    .from(projectTable)
    .where(visibleProjectCondition(userId, now))
    .orderBy(asc(projectTable.id))
    .limit(limit)
    .offset(offset);
  return rows.map((row) => row.id);
}
