import { describe, expect, it } from "vite-plus/test";
import {
  canCreateProject,
  projectCapabilities,
  type ProjectActor,
  type ProjectPolicySubject,
} from "./project-policy";

const actor: ProjectActor = {
  userId: "employee",
  active: true,
  primaryDepartmentId: "it",
  departmentHeadIds: [],
};
const project: ProjectPolicySubject = {
  ownerUserId: "owner",
  departmentId: "it",
  visibility: "private",
};
const denied = {
  readContent: false,
  workOnTasks: false,
  manageSettings: false,
  manageParticipants: false,
  deleteTask: false,
  transferOwnership: false,
  archiveProject: false,
  readManagementMetadata: false,
};
const reader = { ...denied, readContent: true, readManagementMetadata: true };
const participant = { ...reader, workOnTasks: true };
const owner = {
  readContent: true,
  workOnTasks: true,
  manageSettings: true,
  manageParticipants: true,
  deleteTask: true,
  transferOwnership: true,
  archiveProject: true,
  readManagementMetadata: true,
};
const head = {
  ...denied,
  transferOwnership: true,
  archiveProject: true,
  readManagementMetadata: true,
};

const cases: {
  name: string;
  actor?: Partial<ProjectActor>;
  membership?: ProjectPolicySubject["membership"];
  privateExpected: typeof denied;
  departmentExpected: typeof denied;
}[] = [
  {
    name: "department colleague",
    privateExpected: denied,
    departmentExpected: reader,
  },
  {
    name: "outsider",
    actor: { primaryDepartmentId: "sales" },
    privateExpected: denied,
    departmentExpected: denied,
  },
  {
    name: "unresolved department",
    actor: { primaryDepartmentId: undefined },
    privateExpected: denied,
    departmentExpected: denied,
  },
  {
    name: "owner",
    actor: { userId: "owner" },
    privateExpected: owner,
    departmentExpected: owner,
  },
  {
    name: "participant",
    membership: "participant",
    privateExpected: participant,
    departmentExpected: participant,
  },
  {
    name: "observer",
    membership: "observer",
    privateExpected: reader,
    departmentExpected: reader,
  },
  {
    name: "cross-department participant",
    actor: { primaryDepartmentId: "sales" },
    membership: "participant",
    privateExpected: participant,
    departmentExpected: participant,
  },
  {
    name: "cross-department observer",
    actor: { primaryDepartmentId: "sales" },
    membership: "observer",
    privateExpected: reader,
    departmentExpected: reader,
  },
  {
    name: "participant without resolved department",
    actor: { primaryDepartmentId: null },
    membership: "participant",
    privateExpected: participant,
    departmentExpected: participant,
  },
  {
    name: "owner without resolved department",
    actor: { userId: "owner", primaryDepartmentId: null },
    privateExpected: owner,
    departmentExpected: owner,
  },
  {
    name: "department head",
    actor: { departmentHeadIds: ["it"] },
    privateExpected: head,
    departmentExpected: { ...reader, ...head, readContent: true },
  },
  {
    name: "head who observes",
    actor: { departmentHeadIds: ["it"] },
    membership: "observer",
    privateExpected: { ...head, readContent: true },
    departmentExpected: { ...head, readContent: true },
  },
  {
    name: "other department head",
    actor: { primaryDepartmentId: "sales", departmentHeadIds: ["sales"] },
    privateExpected: denied,
    departmentExpected: denied,
  },
];

describe("Doska project capabilities", () => {
  for (const entry of cases) {
    for (const visibility of ["private", "department"] as const) {
      it(`${entry.name}: ${visibility}`, () => {
        expect(
          projectCapabilities(
            { ...actor, ...entry.actor },
            { ...project, visibility, membership: entry.membership },
          ),
        ).toEqual(
          visibility === "private"
            ? entry.privateExpected
            : entry.departmentExpected,
        );
      });
      it(`blocked ${entry.name}: ${visibility}`, () => {
        expect(
          projectCapabilities(
            { ...actor, ...entry.actor, active: false },
            { ...project, visibility, membership: entry.membership },
          ),
        ).toEqual(denied);
      });
    }
  }

  it("technical administrator metadata never grants project access", () => {
    const administrator = {
      ...actor,
      primaryDepartmentId: "sales",
      role: "admin",
      workspaceRole: "owner",
    };
    expect(projectCapabilities(administrator, project)).toEqual(denied);
  });

  it("department transfer removes derived read but retains explicit participation", () => {
    const openProject = { ...project, visibility: "department" as const };
    const transferred = { ...actor, primaryDepartmentId: "sales" };
    expect(projectCapabilities(actor, openProject)).toEqual(reader);
    expect(projectCapabilities(transferred, openProject)).toEqual(denied);
    expect(
      projectCapabilities(transferred, {
        ...openProject,
        membership: "participant",
      }),
    ).toEqual(participant);
  });
});

describe("Doska project creation", () => {
  it.each([
    [true, "it", "it", true],
    [true, "sales", "it", false],
    [true, null, "it", false],
    [true, undefined, "it", false],
    [true, "", "", false],
    [false, "it", "it", false],
  ] as const)(
    "active=%s primary=%s target=%s permits=%s",
    (active, primaryDepartmentId, target, expected) => {
      expect(
        canCreateProject(
          { ...actor, active, primaryDepartmentId, departmentHeadIds: ["it"] },
          target,
        ),
      ).toBe(expected);
    },
  );
});
