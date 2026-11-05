import {
  and,
  asc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
} from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { projectTable } from "../../database/schema";
import {
  managedProjectCondition,
  visibleProjectCondition,
} from "../project-access";
import { lockDirectory, requireFreshIdentity } from "./transaction";

export type ListProjectsInput = {
  limit: number;
  offset: number;
  archived: boolean;
  q?: string;
};
const managementFields = {
  id: projectTable.id,
  name: projectTable.name,
  ownerUserId: projectTable.ownerUserId,
  archivedAt: projectTable.archivedAt,
  revision: projectTable.revision,
};
const contentFields = {
  ...managementFields,
  slug: projectTable.slug,
  icon: projectTable.icon,
  description: projectTable.description,
  departmentId: projectTable.departmentId,
  visibility: projectTable.visibility,
};

async function list(
  userId: string,
  input: ListProjectsInput,
  fields: typeof contentFields | typeof managementFields,
  managed: boolean,
) {
  const { limit, offset, archived, q } = input;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 10_000_000 ||
    typeof archived !== "boolean"
  ) {
    throw new RangeError(
      "Project listing requires limit 1..100, offset 0..10000000 and archived boolean",
    );
  }
  const pattern =
    q === undefined ? undefined : `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const policy = managed ? managedProjectCondition : visibleProjectCondition;
  return db.transaction(async (tx) => {
    await lockDirectory(tx);
    await requireFreshIdentity(tx, userId);
    const rows = await tx
      .select(fields as typeof contentFields)
      .from(projectTable)
      .$dynamic()
      .where(
        and(
          policy(userId),
          archived
            ? isNotNull(projectTable.archivedAt)
            : isNull(projectTable.archivedAt),
          pattern === undefined
            ? undefined
            : managed
              ? ilike(projectTable.name, pattern)
              : or(
                  ilike(projectTable.name, pattern),
                  ilike(projectTable.slug, pattern),
                ),
        ),
      )
      .orderBy(asc(projectTable.name), asc(projectTable.id))
      .limit(limit)
      .offset(offset);
    await requireFreshIdentity(tx, userId);
    // Leases can expire while the SELECT runs, even with the publisher locked.
    if (!rows.length) return rows;
    const allowed = await tx
      .select({ id: projectTable.id })
      .from(projectTable)
      .$dynamic()
      .where(
        and(
          policy(userId),
          inArray(
            projectTable.id,
            rows.map((row) => row.id),
          ),
        ),
      );
    const ids = new Set(allowed.map((row) => row.id));
    return rows.filter((row) => ids.has(row.id));
  });
}

export const listProjects = async (
  userId: string,
  input: ListProjectsInput,
) => {
  const rows = await list(userId, input, contentFields, false);
  // resolvedProject in the SQL policy excludes unbackfilled projects.
  return rows.map((row) => ({
    ...row,
    ownerUserId: row.ownerUserId!,
    departmentId: row.departmentId!,
    visibility: row.visibility!,
  }));
};
export const listManagedProjects = async (
  userId: string,
  input: ListProjectsInput,
) => {
  const rows = await list(userId, input, managementFields, true);
  return rows.map(({ id, name, ownerUserId, archivedAt, revision }) => ({
    id,
    name,
    ownerUserId: ownerUserId!,
    archivedAt,
    revision,
  }));
};

/** Read metadata only after current content authorization, including archived projects. */
export async function getContentProject(userId: string, projectId: string) {
  return db.transaction(async (tx) => {
    await lockDirectory(tx);
    await requireFreshIdentity(tx, userId);
    const [row] = await tx
      .select(contentFields)
      .from(projectTable)
      .where(
        and(eq(projectTable.id, projectId), visibleProjectCondition(userId)),
      )
      .for("share");
    if (!row) throw new HTTPException(404, { message: "Project not found" });
    await requireFreshIdentity(tx, userId);
    const [allowed] = await tx
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(
        and(eq(projectTable.id, projectId), visibleProjectCondition(userId)),
      );
    if (!allowed)
      throw new HTTPException(404, { message: "Project not found" });
    return {
      ...row,
      ownerUserId: row.ownerUserId!,
      departmentId: row.departmentId!,
      visibility: row.visibility!,
    };
  });
}
