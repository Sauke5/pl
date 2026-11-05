import type { ProjectActor } from "../project-policy";

export type TemplateVisibility = "private" | "department" | "company";
export type TemplatePolicySubject = {
  ownerUserId: string;
  departmentId: string;
  visibility: TemplateVisibility;
};

/** Actor identity and department freshness are verified by the calling service. */
export function templateCapabilities(
  actor: ProjectActor,
  template: TemplatePolicySubject,
) {
  const manage = actor.active && actor.userId === template.ownerUserId;
  const read =
    actor.active &&
    (manage ||
      template.visibility === "company" ||
      (template.visibility === "department" &&
        actor.primaryDepartmentId === template.departmentId));
  return {
    read,
    manage,
    createProject: read && Boolean(actor.primaryDepartmentId),
  };
}
