/**
 * Shared Doska capability vocabulary for project services and access checks.
 * Inputs must come from verified Platform identity and current project state.
 * Technical administrator roles deliberately confer no project permissions.
 */
export type ProjectActor = {
  userId: string;
  active: boolean;
  primaryDepartmentId?: string | null;
  /** IDs of departments this actor heads, supplied by the Platform. */
  departmentHeadIds: readonly string[];
};

export type ProjectPolicySubject = {
  ownerUserId: string;
  departmentId: string;
  visibility: "department" | "private";
  /** Explicit membership of the actor in this project. */
  membership?: "participant" | "observer" | null;
};

export type ProjectCapabilities = {
  readContent: boolean;
  workOnTasks: boolean;
  manageSettings: boolean;
  manageParticipants: boolean;
  deleteTask: boolean;
  transferOwnership: boolean;
  archiveProject: boolean;
  readManagementMetadata: boolean;
};

/** Creation is only allowed in the actor's resolved primary department. */
export function canCreateProject(
  actor: ProjectActor,
  departmentId: string,
): boolean {
  return Boolean(
    actor.active &&
    actor.primaryDepartmentId &&
    actor.primaryDepartmentId === departmentId,
  );
}

export function projectCapabilities(
  actor: ProjectActor,
  project: ProjectPolicySubject,
): ProjectCapabilities {
  const owner = actor.active && actor.userId === project.ownerUserId;
  const head =
    actor.active && actor.departmentHeadIds.includes(project.departmentId);
  const workOnTasks =
    actor.active && (owner || project.membership === "participant");
  const readContent =
    actor.active &&
    (workOnTasks ||
      project.membership === "observer" ||
      (project.visibility === "department" &&
        Boolean(actor.primaryDepartmentId) &&
        actor.primaryDepartmentId === project.departmentId));

  return {
    readContent,
    workOnTasks,
    manageSettings: owner,
    manageParticipants: owner,
    deleteTask: owner,
    transferOwnership: owner || head,
    archiveProject: owner || head,
    readManagementMetadata: readContent || head,
  };
}
