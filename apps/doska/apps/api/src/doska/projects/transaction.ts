import { and, eq, gt, lte } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type db from "../../database";
import {
  platformDirectoryStateTable,
  platformUserIdentityTable,
  projectTable,
} from "../../database/schema";
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
// The publisher takes this row FOR UPDATE before modifying any directory rows.
export async function lockDirectory(tx: Transaction) {
  await tx
    .select({ id: platformDirectoryStateTable.id })
    .from(platformDirectoryStateTable)
    .where(eq(platformDirectoryStateTable.id, "directory"))
    .for("share");
}
export async function freshIdentity(
  database: Pick<typeof db, "select">,
  userId: string,
  now = new Date(),
) {
  const [identity] = await database
    .select({
      userId: platformUserIdentityTable.userId,
      departmentId: platformUserIdentityTable.primaryDepartmentId,
    })
    .from(platformUserIdentityTable)
    .innerJoin(
      platformDirectoryStateTable,
      eq(platformDirectoryStateTable.id, "directory"),
    )
    .where(
      and(
        eq(platformUserIdentityTable.userId, userId),
        eq(platformUserIdentityTable.active, true),
        lte(platformUserIdentityTable.observedAt, now),
        gt(platformUserIdentityTable.validUntil, now),
        lte(platformDirectoryStateTable.observedAt, now),
        gt(platformDirectoryStateTable.validUntil, now),
      ),
    )
    .limit(1);
  return identity;
}

export async function lockProject(tx: Transaction, projectId: string) {
  const [project] = await tx
    .select()
    .from(projectTable)
    .where(eq(projectTable.id, projectId))
    .for("update");
  if (!project) throw new HTTPException(404, { message: "Project not found" });
  return project;
}
export async function requireFreshIdentity(
  tx: Pick<typeof db, "select">,
  userId: string,
) {
  const identity = await freshIdentity(tx, userId);
  if (!identity)
    throw new HTTPException(403, {
      message: "Current Platform identity is required",
    });
  return identity;
}
