import { describe, expect, it } from "vite-plus/test";
import { templateCapabilities, type TemplatePolicySubject } from "./policy";
import type { ProjectActor } from "../project-policy";

const employee: ProjectActor = {
  userId: "employee",
  active: true,
  primaryDepartmentId: "it",
  departmentHeadIds: [],
};
const template: TemplatePolicySubject = {
  ownerUserId: "owner",
  departmentId: "it",
  visibility: "private",
};
describe("template access", () => {
  it("keeps personal snapshots private even from department heads", () => {
    expect(
      templateCapabilities(
        { ...employee, departmentHeadIds: ["it"] },
        template,
      ),
    ).toEqual({ read: false, manage: false, createProject: false });
  });
  it("allows the owner to retain the snapshot after a department transfer", () => {
    expect(
      templateCapabilities(
        { ...employee, userId: "owner", primaryDepartmentId: "sales" },
        template,
      ),
    ).toEqual({ read: true, manage: true, createProject: true });
  });
  it("limits department publication to the current primary department", () => {
    const published = { ...template, visibility: "department" as const };
    expect(templateCapabilities(employee, published)).toEqual({
      read: true,
      manage: false,
      createProject: true,
    });
    expect(
      templateCapabilities(
        {
          ...employee,
          primaryDepartmentId: "sales",
          departmentHeadIds: ["it"],
        },
        published,
      ),
    ).toEqual({ read: false, manage: false, createProject: false });
  });
  it("allows company snapshots across departments without granting management", () => {
    expect(
      templateCapabilities(
        { ...employee, primaryDepartmentId: "sales" },
        { ...template, visibility: "company" },
      ),
    ).toEqual({ read: true, manage: false, createProject: true });
  });
  it("allows reading a company snapshot before department resolution but not creating a project", () => {
    expect(
      templateCapabilities(
        { ...employee, primaryDepartmentId: null },
        { ...template, visibility: "company" },
      ),
    ).toEqual({ read: true, manage: false, createProject: false });
  });
  it.each(["private", "department", "company"] as const)(
    "denies blocked owners of %s snapshots",
    (visibility) => {
      expect(
        templateCapabilities(
          { ...employee, userId: "owner", active: false },
          { ...template, visibility },
        ),
      ).toEqual({ read: false, manage: false, createProject: false });
    },
  );
});
