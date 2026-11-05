import { and, eq, inArray, or } from "drizzle-orm";
import {
  platformUserIdentityTable,
  projectMemberTable,
  taskRelationTable,
  taskTable,
} from "../../database/schema";
import type { Transaction } from "../projects/transaction";
import { publishLiveChanges } from "./publisher";

type ProjectAudience = {
  id: string;
  ownerUserId: string | null;
  departmentId: string | null;
  visibility: string | null;
};
export async function publishProjectMutation(
  tx: Transaction,
  before: ProjectAudience | null,
  after: ProjectAudience,
) {
  const members = await tx
    .select({ userId: projectMemberTable.userId })
    .from(projectMemberTable)
    .where(eq(projectMemberTable.projectId, after.id));
  const departments = [before, after].flatMap((project) =>
    project?.visibility === "department" && project.departmentId
      ? [project.departmentId]
      : [],
  );
  const colleagues = departments.length
    ? await tx
        .select({ userId: platformUserIdentityTable.userId })
        .from(platformUserIdentityTable)
        .where(
          and(
            eq(platformUserIdentityTable.active, true),
            inArray(platformUserIdentityTable.primaryDepartmentId, departments),
          ),
        )
    : [];
  const users = [...members, ...colleagues].map((row) => row.userId);
  for (const project of [before, after])
    if (project?.ownerUserId) users.push(project.ownerUserId);
  await publishLiveChanges(tx, [
    {
      kind: "project",
      projectId: after.id,
      scopes: ["project", "access", "members", "tasks"],
    },
    { kind: "personal", userIds: users, scopes: ["projects", "access"] },
  ]);
}

export async function publishTaskDeletion(
  tx: Transaction,
  task: { id: string; projectId: string },
) {
  const relations = await tx
    .select()
    .from(taskRelationTable)
    .where(
      or(
        eq(taskRelationTable.sourceTaskId, task.id),
        eq(taskRelationTable.targetTaskId, task.id),
      ),
    );
  const ids = relations.map((row) =>
    row.sourceTaskId === task.id ? row.targetTaskId : row.sourceTaskId,
  );
  const others = ids.length
    ? await tx
        .select({ id: taskTable.id, projectId: taskTable.projectId })
        .from(taskTable)
        .where(inArray(taskTable.id, ids))
    : [];
  await publishLiveChanges(tx, [
    {
      kind: "project",
      projectId: task.projectId,
      scopes: ["tasks", "subtasks", "relations", "history"],
    },
    ...others.map((other) => ({
      kind: "project" as const,
      projectId: other.projectId,
      taskIds: [other.id],
      scopes: ["tasks", "relations", "history"] as (
        | "tasks"
        | "relations"
        | "history"
      )[],
    })),
  ]);
}
