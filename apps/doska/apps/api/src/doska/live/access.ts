import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../../database";
import { projectTable, taskTable } from "../../database/schema";
import { resolveDoskaIdentity } from "../http-identity";
import {
  getProjectCapabilities,
  visibleProjectCondition,
} from "../project-access";
import type { LiveEvent } from "./events";

export type LiveAccess = { validUntil: number; projects: Map<string, string> };
export type ProjectEvent = Extract<LiveEvent, { kind: "project" }>;
export type LiveAccessProvider = {
  snapshot(actorId: string, subject: string): Promise<LiveAccess>;
  filterProject(
    actorId: string,
    event: ProjectEvent,
  ): Promise<ProjectEvent | null>;
};
export const liveAccessProvider: LiveAccessProvider = {
  async snapshot(actorId, subject) {
    const identity = await resolveDoskaIdentity(subject);
    if (
      !identity ||
      !identity.active ||
      identity.user.id !== actorId ||
      identity.observedAt.getTime() > Date.now() ||
      identity.validUntil.getTime() <= Date.now()
    )
      throw new Error("Live identity unavailable");
    const rows = await db
      .select({
        id: projectTable.id,
        owner: projectTable.ownerUserId,
        department: projectTable.departmentId,
        visibility: projectTable.visibility,
        membership: sql<
          string | null
        >`(select role from project_member where project_id=${projectTable.id} and user_id=${actorId} limit 1)`,
        head: sql<boolean>`exists(select 1 from platform_department_head where department_id=${projectTable.departmentId} and user_id=${actorId})`,
      })
      .from(projectTable)
      .where(visibleProjectCondition(actorId))
      .limit(10001);
    if (rows.length > 10000) throw new Error("Live project capacity exceeded");
    return {
      validUntil: identity.validUntil.getTime(),
      projects: new Map(
        rows.map(({ id, ...access }) => [id, JSON.stringify(access)]),
      ),
    };
  },
  async filterProject(actorId, event) {
    if (!(await getProjectCapabilities(actorId, event.projectId)).readContent)
      return null;
    if (!event.taskIds.length) return event;
    const tasks = await db
      .select({ id: taskTable.id })
      .from(taskTable)
      .where(
        and(
          eq(taskTable.projectId, event.projectId),
          inArray(taskTable.id, event.taskIds),
        ),
      );
    // Missing/deleted IDs become project invalidation; never expose an ID belonging to another project.
    return { ...event, taskIds: tasks.map((task) => task.id) };
  },
};
