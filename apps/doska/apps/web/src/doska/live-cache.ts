import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";
import type { LiveEvent, ProjectLiveScope } from "./live-events";

const projectKeys: Record<ProjectLiveScope, readonly string[]> = {
  fields: ["project-fields", "task", "tasks", "template-preview", "history"],
  labels: ["labels", "task", "tasks", "template-preview", "history"],
  tasks: [
    "resource-links",
    "tasks",
    "task",
    "subtasks",
    "subtask-search",
    "relation-search",
    "relations",
    "template-preview",
  ],
  columns: ["columns", "column-settings", "tasks", "task", "subtasks"],
  checklists: ["checklists", "tasks", "task", "template-preview"],
  comments: ["comments", "task"],
  history: ["history"],
  relations: ["relations", "task"],
  subtasks: ["subtasks", "subtask-search", "tasks", "task"],
  attachments: ["attachments", "task"],
  project: [
    "project",
    "management",
    "access",
    "resource-create-resolve",
    "resource-search",
    "resource-search-selection",
  ],
  access: [
    "resource-create-resolve",
    "resource-search",
    "resource-search-selection",
    "access",
    "relation-access",
    "management",
    "employee-options",
    "ownership-options",
  ],
  members: [
    "resource-create-resolve",
    "resource-search",
    "resource-search-selection",
    "members",
    "member-page",
    "employee-options",
    "ownership-options",
    "access",
    "relation-access",
  ],
  "template-selection": ["template-selection", "template-preview"],
  invitations: ["project-invitations", "members", "member-page"],
  "join-requests": [
    "join-requests",
    "own-join-requests",
    "members",
    "member-page",
  ],
};
const taskKeys = new Set([
  "resource-links",
  "task",
  "checklists",
  "comments",
  "history",
  "relations",
  "attachments",
]);
const taskAggregates = new Set([
  "fields",
  "labels",
  "tasks",
  "columns",
  "checklists",
  "comments",
  "subtasks",
  "members",
]);
const projectLists = new Set([
  "projects",
  "managed-projects",
  "relation-projects",
  "search-project-options",
  "overview",
]);

export function liveEventMatchesKey(
  event: Extract<LiveEvent, { type: "changed" | "personal" }>,
  key: QueryKey,
) {
  if (key[0] !== "doska" || typeof key[1] !== "string") return false;
  const name = key[1];
  if (event.type === "personal")
    return event.scopes.some((scope) => {
      if (scope === "projects") return projectLists.has(name);
      if (scope === "notifications")
        return name === "notifications" || name === "unread-count";
      if (scope === "templates")
        return name === "templates" || name === "template";
      return name === scope;
    });
  if (
    event.scopes.some((scope) => taskAggregates.has(scope)) &&
    (name === "my-tasks" || name === "task-search" || name === "overview")
  )
    return true;
  if (
    event.scopes.some(
      (scope) =>
        scope === "project" || scope === "access" || scope === "members",
    ) &&
    projectLists.has(name)
  )
    return true;
  if (
    key[2] !== event.projectId ||
    !event.scopes.some((scope) => projectKeys[scope].includes(name))
  )
    return false;
  // Parent lists can change when a child is moved; do not narrow them to child IDs.
  return (
    !taskKeys.has(name) ||
    !event.taskIds?.length ||
    event.taskIds.includes(String(key[3]))
  );
}

/** No writes to task data: dirty editor state and drag previews remain owned by their components. */
export function createLiveCacheScheduler(
  client: QueryClient,
  options: {
    onResync: (reason: "ready" | "reset") => void;
    delayMs?: number;
    fetchTimeoutMs?: number;
  },
) {
  let stopped = false;
  const waiting = new Set<() => void>();
  async function bounded(promise: Promise<unknown> | undefined, query: Query) {
    if (!promise) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finish!: () => void;
    try {
      return await Promise.race([
        promise.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => {
          finish = () => resolve(false);
          waiting.add(finish);
          timer = setTimeout(() => {
            if (
              !stopped &&
              client.getQueryCache().get(query.queryHash) === query
            )
              void client.cancelQueries({
                queryKey: query.queryKey,
                exact: true,
              });
            resolve(false);
          }, options.fetchTimeoutMs ?? 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      waiting.delete(finish);
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<Query, { generation: number; running: boolean }>();
  const schedule = () => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      for (const [query, state] of pending)
        if (!state.running) void refresh(query, state);
    }, options.delayMs ?? 40);
  };
  async function refresh(
    query: Query,
    state: { generation: number; running: boolean },
  ) {
    state.running = true;
    try {
      do {
        const generation = state.generation;
        // Joining a fetch started before this event is insufficient: its snapshot may be old.
        if (query.state.fetchStatus === "fetching")
          await bounded(query.promise, query);
        if (stopped) return;
        if (client.getQueryCache().get(query.queryHash) !== query) return;
        await client.invalidateQueries({
          queryKey: query.queryKey,
          exact: true,
          refetchType: "none",
        });
        const completed = await bounded(
          client.refetchQueries(
            { queryKey: query.queryKey, exact: true, type: "active" },
            { cancelRefetch: false },
          ),
          query,
        );
        if (!completed) return;
        if (stopped || generation === state.generation) return;
      } while (query.isActive());
    } finally {
      pending.delete(query);
    }
  }
  function enqueue(predicate: (query: Query) => boolean) {
    if (stopped) return;
    void client.invalidateQueries({ predicate, refetchType: "none" });
    for (const query of client.getQueryCache().findAll({ predicate })) {
      const state = pending.get(query);
      if (state) state.generation++;
      else if (query.isActive())
        pending.set(query, { generation: 1, running: false });
    }
    if (pending.size) schedule();
  }
  return {
    accept(event: LiveEvent) {
      if (stopped) return;
      if (event.type === "ready" || event.type === "reset") {
        options.onResync(event.type);
        return;
      }
      enqueue((query) => liveEventMatchesKey(event, query.queryKey));
    },
    /** Call after the owner has reconciled identity/access and evicted denied entries. */
    resyncAvailableQueries() {
      enqueue(
        (query) =>
          query.queryKey[0] === "doska" && query.queryKey[1] !== "context",
      );
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const finish of waiting) finish();
      waiting.clear();
      pending.clear();
    },
  };
}
