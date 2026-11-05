import { and, asc, desc, eq, ilike, isNull } from "drizzle-orm";
import db from "../../database";
import { labelTable, taskTable } from "../../database/schema";
import { lockTaskContext, authorizeTaskProject } from "../tasks/transaction";
export async function listProjectLabels(
  actorId: string,
  projectId: string,
  input: { limit: number; offset: number; q?: string },
) {
  return db.transaction(async (tx) => {
    await lockTaskContext(tx, actorId, projectId, undefined, "readContent");
    const search = input.q?.replace(/[\\%_]/g, "\\$&");
    const rows = await tx
      .selectDistinctOn([labelTable.name], {
        name: labelTable.name,
        color: labelTable.color,
      })
      .from(labelTable)
      .innerJoin(taskTable, eq(taskTable.id, labelTable.taskId))
      .where(
        and(
          eq(taskTable.projectId, projectId),
          isNull(labelTable.deletionStartedAt),
          isNull(taskTable.archivedAt),
          search ? ilike(labelTable.name, `%${search}%`) : undefined,
        ),
      )
      .orderBy(
        asc(labelTable.name),
        desc(labelTable.updatedAt),
        asc(labelTable.id),
      )
      .limit(input.limit)
      .offset(input.offset);
    await authorizeTaskProject(tx, actorId, projectId, "readContent");
    return rows;
  });
}
