import type { QueryClient, Query } from "@tanstack/react-query";
import { api, ApiError } from "./api";
const projectKeys = new Set([
  "resource-links",
  "resource-search",
  "resource-create-resolve",
  "project",
  "access",
  "columns",
  "tasks",
  "task",
  "members",
  "member-page",
  "management",
  "ownership-options",
  "employee-options",
  "column-settings",
  "project-fields",
  "labels",
  "comments",
  "checklists",
  "history",
  "attachments",
  "relations",
  "relation-access",
  "subtasks",
  "subtask-search",
  "relation-search",
  "template-selection",
  "template-preview",
  "project-invitations",
  "join-requests",
  "own-join-requests",
]);
const aggregates = new Set([
  "overview",
  "projects",
  "my-tasks",
  "task-search",
  "managed-projects",
  "relation-projects",
  "search-project-options",
  "templates",
  "template",
  "invitations",
  "notifications",
  "unread-count",
]);
function projectId(query: Query) {
  const key = query.queryKey;
  return key[0] === "doska" &&
    projectKeys.has(String(key[1])) &&
    typeof key[2] === "string"
    ? key[2]
    : undefined;
}
/** Remove data before notifying observers; resetQueries can restore initialData. */
export async function clearLiveData(
  client: QueryClient,
  active: () => boolean,
  includeContext = false,
  error = new ApiError(403, "Access unavailable"),
) {
  const predicate = (query: Query) =>
    query.queryKey[0] === "doska" &&
    (includeContext || query.queryKey[1] !== "context");
  await client.cancelQueries({ predicate });
  if (!active()) return;
  for (const query of client.getQueryCache().findAll({ predicate })) {
    query.setState({
      data: undefined,
      dataUpdatedAt: 0,
      error,
      status: "error",
      fetchStatus: "idle",
    });
    if (query.queryKey[1] !== "context")
      client.removeQueries({ queryKey: query.queryKey, exact: true });
  }
}

export async function reconcileLiveAccess(
  client: QueryClient,
  userId: string,
  active: () => boolean,
  source: Pick<typeof api, "getContext" | "getAccess"> = api,
  signal?: AbortSignal,
): Promise<"same-user" | "user-changed" | "obsolete"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const current = () => active() && !expired && !controller.signal.aborted;
  const job = async (): Promise<"same-user" | "user-changed" | "obsolete"> => {
    const context = await source.getContext({ signal: controller.signal });
    if (!current()) return "obsolete";
    if (context.user.id !== userId) {
      await clearLiveData(client, current);
      if (!current()) return "obsolete";
      client.setQueryData(["doska", "context"], context);
      return "user-changed";
    }
    const ids = [
      ...new Set(
        client
          .getQueryCache()
          .getAll()
          .map(projectId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const denied = new Set<string>();
    for (let offset = 0; offset < ids.length; offset += 4) {
      if (!current()) return "obsolete";
      await Promise.all(
        ids.slice(offset, offset + 4).map(async (id) => {
          try {
            const access = await source.getAccess(id, {
              signal: controller.signal,
            });
            if (!current()) return;
            if (!access.readContent) denied.add(id);
            else client.setQueryData(["doska", "access", id], access);
          } catch (error) {
            if (!current()) return;
            if (error instanceof ApiError && [403, 404].includes(error.status))
              denied.add(id);
            else throw error;
          }
        }),
      );
    }
    if (!current()) return "obsolete";
    const invalid = (query: Query) =>
      denied.has(projectId(query) ?? "") ||
      (query.queryKey[0] === "doska" &&
        aggregates.has(String(query.queryKey[1])));
    await client.cancelQueries({ predicate: invalid });
    if (!current()) return "obsolete";
    for (const query of client
      .getQueryCache()
      .findAll({ predicate: invalid })) {
      const inaccessible = denied.has(projectId(query) ?? "");
      query.setState({
        data: undefined,
        dataUpdatedAt: 0,
        error: inaccessible
          ? new ApiError(403, "Project access revoked")
          : null,
        status: inaccessible ? "error" : "pending",
        fetchStatus: "idle",
        isInvalidated: true,
      });
      if (inaccessible)
        client.removeQueries({ queryKey: query.queryKey, exact: true });
    }
    client.setQueryData(["doska", "context"], context);
    return "same-user";
  };
  try {
    return await Promise.race([
      job(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          controller.abort();
          reject(new Error("Access check timed out"));
        }, 5000);
      }),
    ]);
  } catch (error) {
    if (
      current() &&
      error instanceof ApiError &&
      [401, 403].includes(error.status)
    )
      await clearLiveData(client, current, true, error);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controller.abort();
  }
}
