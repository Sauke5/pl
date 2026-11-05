import { describe, expect, it } from "vite-plus/test";
import {
  adaptedDoskaScope,
  isAdaptedDoskaRead,
  attachmentUploadRoute,
} from "./route-policy";

describe("integrated route boundary", () => {
  it.each([
    "/api/doska/context",
    "/api/doska/preferences",
    "/api/doska/notifications/preferences",
    "/api/doska/projects/p1",
    "/api/doska/my-tasks",
    "/api/doska/overview",
    "/api/doska/task-search",
    "/api/doska/projects/p1/access",
    "/api/doska/projects/p1/columns",
    "/api/doska/projects/p1/fields",
    "/api/doska/projects/p1/labels",
    "/api/doska/projects/p1/tasks/t1/relations",
    "/api/doska/projects/p1/tasks",
    "/api/doska/projects/p1/tasks/t1",
    "/api/doska/projects/p1/tasks/t1/history",
    "/api/doska/projects",
    "/api/doska/managed-projects",
    "/api/doska/projects/p1/employee-options",
    "/api/doska/invitations",
    "/api/doska/projects/p-1/invitations",
    "/api/doska/projects/p-1/join-requests",
    "/api/doska/projects/p-1/members",
    "/api/doska/projects/p-1/management",
    "/api/project",
    "/api/project/",
    "/api/project/p-1",
    "/api/task/tasks/p1",
    "/api/task/t1",
  ])("allows adapted GET %s", (path) => {
    expect(isAdaptedDoskaRead("GET", path)).toBe(true);
    expect(isAdaptedDoskaRead("POST", path)).toBe(false);
    expect(isAdaptedDoskaRead("HEAD", path)).toBe(false);
  });
  it.each([
    "/api/auth/get-session",
    "/api/public-project/p1",
    "/api/admin/users",
    "/api/mcp",
    "/api/task/assigned",
    "/api/task/export/p1",
    "/api/task/t1/description",
    "/api/project/p1/background",
    "/api/search",
    "/api/doska/employees",
    "/api/doska/projects/p1/employee-options/",
    "/api/doska/projects/p1/employee-options/u1",
    "/api/ws/user",
    "/api/project//p1",
    "/api/project/%70",
    "/api/project/p1/",
    "/api/task/../t1",
  ])("denies unadapted or ambiguous %s", (path) => {
    expect(isAdaptedDoskaRead("GET", path)).toBe(false);
  });
});

describe("integrated mutation scope", () => {
  it.each([
    ["POST", "/api/doska/projects"],
    ["PATCH", "/api/doska/preferences"],
    ["PATCH", "/api/doska/notifications/preferences"],
    ["POST", "/api/doska/projects/p1/fields"],
    ["POST", "/api/doska/projects/p1/fields/reorder"],
    ["PATCH", "/api/doska/projects/p1/fields/settings"],
    ["PATCH", "/api/doska/projects/p1/fields/f1"],
    ["POST", "/api/doska/projects/p1/columns"],
    ["POST", "/api/doska/projects/p1/columns/reorder"],
    ["PATCH", "/api/doska/projects/p1/columns/c1"],
    ["DELETE", "/api/doska/projects/p1/columns/c1"],
    ["POST", "/api/doska/projects/p1/tasks/t1/relations"],
    ["DELETE", "/api/doska/projects/p1/tasks/t1/relations/r1"],
    ["POST", "/api/doska/projects/p1/tasks"],
    ["PATCH", "/api/doska/projects/p1/tasks/t1"],
    ["DELETE", "/api/doska/projects/p1/tasks/t1"],
    ["POST", "/api/doska/projects/p1/tasks/t1/archive"],
    ["PATCH", "/api/doska/projects/p1"],
    ["POST", "/api/doska/projects/p1/archive"],
    ["POST", "/api/doska/projects/p1/owner"],
    ["POST", "/api/doska/projects/p1/invitations"],
    ["POST", "/api/doska/projects/p1/invitations/i1/respond"],
    ["POST", "/api/doska/projects/p1/invitations/i1/revoke"],
    ["POST", "/api/doska/projects/p1/join-requests"],
    ["POST", "/api/doska/projects/p1/join-requests/r1/resolve"],
    ["POST", "/api/doska/projects/p1/join-requests/r1/cancel"],
    ["PATCH", "/api/doska/projects/p1/members/m1"],
    ["DELETE", "/api/doska/projects/p1/members/m1"],
  ])("requires write scope for %s %s", (method, path) => {
    expect(adaptedDoskaScope(method, path)).toBe("doska:write");
    expect(adaptedDoskaScope("PUT", path)).toBeNull();
  });
  it.each([
    ["POST", "/api/project"],
    ["PATCH", "/api/doska/projects/p1/tasks/t1/relations/r1"],
    ["POST", "/api/doska/projects/p1/columns/c1"],
    ["GET", "/api/doska/projects/p1/columns/reorder"],
    ["DELETE", "/api/doska/projects/p1/tasks/t1/relations"],
    ["POST", "/api/doska/projects/p1/tasks/t1"],
    ["DELETE", "/api/doska/projects/p1/tasks"],
    ["PATCH", "/api/doska/projects/p1/tasks/t1/history"],
    ["POST", "/api/doska/projects/p1/tasks/t1/archive/"],
    ["PUT", "/api/doska/projects/p1"],
    ["POST", "/api/doska/projects/"],
    ["POST", "/api/doska/projects/p1/owner/"],
    ["POST", "/api/doska/projects/p1/members"],
    ["POST", "/api/doska/projects/%70/owner"],
    ["GET", "/api/doska/projects/p1/owner"],
    ["POST", "/api/doska/projects/p1/members/m1"],
    ["DELETE", "/api/doska/projects/p1/invitations/i1"],
    ["POST", "/api/doska/projects/p1/invitations/i1/accept"],
    ["POST", "/api/doska/projects/p1/join-requests/r1/respond"],
    ["POST", "/api/doska/projects/p1/invitations/"],
    ["PATCH", "/api/doska/projects/p1/members/%6d1"],
    ["GET", "/api/doska/projects/p1/members/m1"],
  ])("keeps unadapted mutation closed: %s %s", (method, path) => {
    expect(adaptedDoskaScope(method, path)).toBeNull();
  });
});

describe("task discussion and checklist boundary", () => {
  const base = "/api/doska/projects/p/tasks/t/";
  it.each([
    ["GET", "comments", "doska:read"],
    ["GET", "checklists", "doska:read"],
    ["POST", "comments", "doska:write"],
    ["PATCH", "comments/c", "doska:write"],
    ["DELETE", "comments/c", "doska:write"],
    ["POST", "checklists", "doska:write"],
    ["PATCH", "checklists/c", "doska:write"],
    ["DELETE", "checklists/c", "doska:write"],
    ["PUT", "checklists/order", "doska:write"],
    ["POST", "checklists/c/items", "doska:write"],
    ["PATCH", "checklists/c/items/i", "doska:write"],
    ["DELETE", "checklists/c/items/i", "doska:write"],
    ["PUT", "checklists/c/items/order", "doska:write"],
    ["PUT", "comments/c", null],
    ["POST", "checklists/c/items/i", null],
    ["GET", "comments/c", null],
    ["DELETE", "comments", null],
    ["POST", "comments/", null],
    ["PUT", "checklists/c/order", null],
    ["PATCH", "checklists/c/items/i/extra", null],
  ])("%s %s has scope %s", (method, path, scope) => {
    expect(adaptedDoskaScope(method, base + path)).toBe(scope);
  });
});

describe("template route boundary", () => {
  it.each([
    ["GET", "/api/doska/templates", "doska:read"],
    ["GET", "/api/doska/templates/t1", "doska:read"],
    ["GET", "/api/doska/projects/p1/template-selection", "doska:read"],
    ["POST", "/api/doska/templates", "doska:write"],
    ["POST", "/api/doska/templates/t1/projects", "doska:write"],
    ["POST", "/api/doska/projects/p1/template-preview", "doska:write"],
    ["PATCH", "/api/doska/projects/p1/template-selection/t1", "doska:write"],
  ])("allows only adapted %s %s", (method, path, scope) => {
    expect(adaptedDoskaScope(method, path)).toBe(scope);
    expect(adaptedDoskaScope(method, `${path}/`)).toBeNull();
    expect(adaptedDoskaScope("DELETE", path)).toBeNull();
    expect(adaptedDoskaScope("PUT", path)).toBeNull();
  });
  it.each([
    ["GET", "/api/doska/projects/p1/template-preview"],
    ["GET", "/api/doska/templates/t1/projects"],
    ["PATCH", "/api/doska/templates/t1"],
    ["POST", "/api/doska/templates/t1"],
    ["POST", "/api/doska/projects/p1/template-selection/t1"],
    ["PATCH", "/api/doska/projects/p1/template-selection"],
    ["GET", "/api/doska/templates/%74"],
  ])("rejects unsupported %s %s", (method, path) => {
    expect(adaptedDoskaScope(method, path)).toBeNull();
  });
});

describe("notification routes", () => {
  it.each([
    ["GET", "/api/doska/notifications", "doska:read"],
    ["GET", "/api/doska/notifications/unread-count", "doska:read"],
    ["PATCH", "/api/doska/notifications/n1/read", "doska:write"],
    ["POST", "/api/doska/notifications/read-all", "doska:write"],
  ])("allows %s %s", (method, path, scope) => {
    expect(adaptedDoskaScope(method, path)).toBe(scope);
  });
  it.each([
    ["POST", "/api/doska/notifications"],
    ["DELETE", "/api/doska/notifications/n1"],
    ["GET", "/api/doska/notifications/n1"],
    ["GET", "/api/notification"],
    ["PATCH", "/api/doska/notifications/n1/read/"],
  ])("rejects %s %s", (method, path) => {
    expect(adaptedDoskaScope(method, path)).toBeNull();
  });
});

describe("attachment route isolation", () => {
  const base = "/api/doska/projects/p1/tasks/t1";
  it("dispatches only the exact PUT content route", () => {
    expect(
      attachmentUploadRoute("PUT", `${base}/attachment-uploads/u1/content`),
    ).toEqual({ projectId: "p1", taskId: "t1", uploadId: "u1" });
    for (const method of ["GET", "POST", "PATCH", "DELETE", "HEAD"])
      expect(
        attachmentUploadRoute(method, `${base}/attachment-uploads/u1/content`),
      ).toBeNull();
    for (const suffix of ["/", "?x=1", "/extra", "%2f", "#x"])
      expect(
        attachmentUploadRoute(
          "PUT",
          `${base}/attachment-uploads/u1/content${suffix}`,
        ),
      ).toBeNull();
    expect(
      adaptedDoskaScope("PUT", `${base}/attachment-uploads/u1/content`),
    ).toBe("doska:write");
  });
  it.each([
    ["GET", "/attachments", "doska:read"],
    ["GET", "/attachments/a1/content", "doska:read"],
    ["POST", "/attachment-uploads", "doska:write"],
    ["POST", "/attachment-uploads/u1/finalize", "doska:write"],
    ["DELETE", "/attachment-uploads/u1", "doska:write"],
    ["DELETE", "/attachments/a1", "doska:write"],
    ["HEAD", "/attachments/a1/content", null],
    ["PUT", "/attachments/a1/content", null],
    ["GET", "/attachment-uploads/u1", null],
    ["POST", "/attachments", null],
  ])("restricts %s %s", (method, suffix, scope) => {
    expect(adaptedDoskaScope(method!, `${base}${suffix}`)).toBe(scope);
  });
});

describe("resource-link gateway routes", () => {
  it.each([
    ["GET", "/api/doska/projects/p/resource-link-capabilities", "doska:read"],
    ["GET", "/api/doska/projects/p/tasks/t/resource-links", "doska:read"],
    ["POST", "/api/doska/projects/p/tasks/t/resource-links", "doska:write"],
    ["DELETE", "/api/doska/projects/p/tasks/t/resource-links/l", "doska:write"],
    ["POST", "/api/doska/projects/p/tasks/from-resource", "doska:write"],
    ["POST", "/api/doska/catalog/task-links", "doska:write"],
    ["GET", "/api/doska/catalog/search", null],
    ["POST", "/api/doska/catalog/resolve", null],
    ["GET", "/api/doska/catalog/task-links", null],
    ["GET", "/api/doska/projects/p/tasks/t/resource-links/l", null],
    ["PATCH", "/api/doska/projects/p/tasks/t/resource-links", null],
  ])("restricts %s %s", (method, path, expected) => {
    expect(adaptedDoskaScope(method!, path!)).toBe(expected);
    expect(adaptedDoskaScope(method!, `${path}/`)).toBeNull();
  });
});
