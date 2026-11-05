export const projectLiveScopes = [
  "tasks",
  "columns",
  "checklists",
  "comments",
  "history",
  "relations",
  "subtasks",
  "attachments",
  "project",
  "access",
  "members",
  "template-selection",
  "invitations",
  "join-requests",
  "fields",
  "labels",
] as const;
export const personalLiveScopes = [
  "projects",
  "templates",
  "invitations",
  "notifications",
  "preferences",
  "notification-preferences",
] as const;
export type ProjectLiveScope = (typeof projectLiveScopes)[number];
export type PersonalLiveScope = (typeof personalLiveScopes)[number];
export type LiveEvent =
  | { type: "ready"; version: 1 }
  | {
      type: "changed";
      version: 1;
      projectId: string;
      taskIds?: string[];
      scopes: ProjectLiveScope[];
    }
  | { type: "personal"; version: 1; scopes: PersonalLiveScope[] }
  | { type: "reset"; version: 1; reason: "resync" };
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
function list<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= allowed.length &&
    new Set(value).size === value.length &&
    value.every((item) => allowed.includes(item))
  );
}
/** Parses one EventSource data field, not a raw SSE stream. */
export function parseLiveEvent(type: string, data: string): LiveEvent | null {
  if (data.length > 4096 || new TextEncoder().encode(data).length > 4096)
    return null;
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const body = value as Record<string, unknown>;
    if (body.version !== 1) return null;
    const keys = (allowed: string[]) =>
      Object.keys(body).every((key) => allowed.includes(key));
    if (type === "ready" && keys(["version"])) return { type, version: 1 };
    if (
      type === "reset" &&
      keys(["version", "reason"]) &&
      body.reason === "resync"
    )
      return { type, version: 1, reason: "resync" };
    if (
      type === "personal" &&
      keys(["version", "scopes"]) &&
      list(body.scopes, personalLiveScopes)
    )
      return { type, version: 1, scopes: body.scopes };
    if (
      type !== "changed" ||
      !keys(["version", "projectId", "taskIds", "scopes"]) ||
      typeof body.projectId !== "string" ||
      !idPattern.test(body.projectId) ||
      !list(body.scopes, projectLiveScopes)
    )
      return null;
    if (
      body.taskIds !== undefined &&
      (!Array.isArray(body.taskIds) ||
        body.taskIds.length > 32 ||
        new Set(body.taskIds).size !== body.taskIds.length ||
        !body.taskIds.every(
          (id) => typeof id === "string" && idPattern.test(id),
        ))
    )
      return null;
    return {
      type,
      version: 1,
      projectId: body.projectId,
      scopes: body.scopes,
      ...(body.taskIds === undefined
        ? {}
        : { taskIds: body.taskIds as string[] }),
    };
  } catch {
    return null;
  }
}
