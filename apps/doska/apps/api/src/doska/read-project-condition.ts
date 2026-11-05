import { sql, type SQLWrapper } from "drizzle-orm";

/** Outer IDs stay outside the subquery so Drizzle can safely alias them. */
export function readProjectCondition(
  userId: string | SQLWrapper,
  projectId: string | SQLWrapper,
) {
  return sql<boolean>`(${projectId}, ${userId}) IN (
    SELECT doska_project.id, doska_identity.user_id
    FROM project AS doska_project
    CROSS JOIN platform_user_identity AS doska_identity
    WHERE doska_identity.active = true
      AND doska_identity.observed_at <= (statement_timestamp() AT TIME ZONE 'utc')
      AND doska_identity.valid_until > (statement_timestamp() AT TIME ZONE 'utc')
      AND EXISTS (
        SELECT 1 FROM platform_directory_state AS doska_stream
        WHERE doska_stream.id = 'directory'
          AND doska_stream.observed_at <= (statement_timestamp() AT TIME ZONE 'utc')
          AND doska_stream.valid_until > (statement_timestamp() AT TIME ZONE 'utc')
      )
      AND doska_project.owner_user_id IS NOT NULL
      AND doska_project.department_id IS NOT NULL
      AND doska_project.visibility IN ('department', 'private')
      AND (
        doska_project.owner_user_id = doska_identity.user_id
        OR EXISTS (
          SELECT 1 FROM project_member AS doska_member
          WHERE doska_member.project_id = doska_project.id
            AND doska_member.user_id = doska_identity.user_id
            AND doska_member.role IN ('participant', 'observer')
        )
        OR (
          doska_project.visibility = 'department'
          AND doska_identity.primary_department_id = doska_project.department_id
          AND EXISTS (
            SELECT 1 FROM platform_department AS doska_department
            WHERE doska_department.id = doska_project.department_id
              AND doska_department.active = true
              AND doska_department.observed_at <= (statement_timestamp() AT TIME ZONE 'utc')
              AND doska_department.valid_until > (statement_timestamp() AT TIME ZONE 'utc')
          )
        )
      )
  )`;
}
