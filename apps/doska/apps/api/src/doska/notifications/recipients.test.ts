import { describe, expect, it } from "vite-plus/test";
import { getAssignmentRecipients, type TaskAssignees } from "./recipients";

const empty: TaskAssignees = { userId: null, coexecutorIds: [] };
describe("assignment notification recipients", () => {
  it("notifies newly assigned responsible and coexecutors once each", () => {
    expect(
      getAssignmentRecipients("actor", empty, {
        userId: "lead",
        coexecutorIds: ["helper-b", "helper-a"],
      }),
    ).toEqual([
      {
        userId: "helper-a",
        kind: "assigned",
        previousRole: null,
        role: "coexecutor",
      },
      {
        userId: "helper-b",
        kind: "assigned",
        previousRole: null,
        role: "coexecutor",
      },
      {
        userId: "lead",
        kind: "assigned",
        previousRole: null,
        role: "responsible",
      },
    ]);
  });
  it("notifies removed assignees with their previous role", () => {
    expect(
      getAssignmentRecipients(
        "actor",
        { userId: "lead", coexecutorIds: ["helper"] },
        empty,
      ),
    ).toEqual([
      {
        userId: "helper",
        kind: "unassigned",
        previousRole: "coexecutor",
        role: null,
      },
      {
        userId: "lead",
        kind: "unassigned",
        previousRole: "responsible",
        role: null,
      },
    ]);
  });
  it("emits one role change per person when responsibility is exchanged", () => {
    expect(
      getAssignmentRecipients(
        "actor",
        { userId: "a", coexecutorIds: ["b", "unchanged"] },
        { userId: "b", coexecutorIds: ["unchanged", "a"] },
      ),
    ).toEqual([
      {
        userId: "a",
        kind: "role_changed",
        previousRole: "responsible",
        role: "coexecutor",
      },
      {
        userId: "b",
        kind: "role_changed",
        previousRole: "coexecutor",
        role: "responsible",
      },
    ]);
  });
  it("excludes the actor for additions, removals and role changes", () => {
    expect(
      getAssignmentRecipients("actor", empty, {
        userId: "actor",
        coexecutorIds: [],
      }),
    ).toEqual([]);
    expect(
      getAssignmentRecipients(
        "actor",
        { userId: null, coexecutorIds: ["actor"] },
        empty,
      ),
    ).toEqual([]);
    expect(
      getAssignmentRecipients(
        "actor",
        { userId: "actor", coexecutorIds: [] },
        { userId: null, coexecutorIds: ["actor"] },
      ),
    ).toEqual([]);
  });
  it("ignores unchanged assignees regardless of coexecutor ordering", () => {
    expect(
      getAssignmentRecipients(
        "actor",
        { userId: "lead", coexecutorIds: ["a", "b"] },
        { userId: "lead", coexecutorIds: ["b", "a"] },
      ),
    ).toEqual([]);
    expect(getAssignmentRecipients("actor", empty, empty)).toEqual([]);
  });
  it("combines additions, removals and stable assignees without changing inputs", () => {
    const before = Object.freeze({
      userId: "old",
      coexecutorIds: Object.freeze(["stays", "removed"]),
    });
    const after = Object.freeze({
      userId: "new",
      coexecutorIds: Object.freeze(["added", "stays"]),
    });
    const results = getAssignmentRecipients("actor", before, after);
    expect(results.map(({ userId, kind }) => ({ userId, kind }))).toEqual([
      { userId: "added", kind: "assigned" },
      { userId: "new", kind: "assigned" },
      { userId: "old", kind: "unassigned" },
      { userId: "removed", kind: "unassigned" },
    ]);
    expect(before.coexecutorIds).toEqual(["stays", "removed"]);
    expect(after.coexecutorIds).toEqual(["added", "stays"]);
  });
});
