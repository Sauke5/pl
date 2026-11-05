import { z } from "zod";

export const LIVE_CHANNEL = "doska_changes";
export const MAX_LIVE_PAYLOAD_BYTES = 4096;
export const liveScopes = [
  "tasks",
  "fields",
  "labels",
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
  "projects",
  "templates",
  "template-selection",
  "invitations",
  "join-requests",
  "notifications",
  "preferences",
  "notification-preferences",
] as const;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const userId = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const scopes = z.array(z.enum(liveScopes)).min(1).max(liveScopes.length);
const unique = (values: readonly string[]) =>
  new Set(values).size === values.length;
const project = z
  .object({
    version: z.literal(1),
    kind: z.literal("project"),
    projectId: id,
    taskIds: z.array(id).max(32).refine(unique),
    scopes: scopes.refine(unique),
  })
  .strict();
const personal = z
  .object({
    version: z.literal(1),
    kind: z.literal("personal"),
    userIds: z.array(userId).min(1).max(64).refine(unique),
    scopes: scopes.refine(unique),
  })
  .strict();
export const liveEventSchema = z.discriminatedUnion("kind", [
  project,
  personal,
]);
export type LiveEvent = z.infer<typeof liveEventSchema>;
export type LiveScope = (typeof liveScopes)[number];
export type LiveChange =
  | {
      kind: "project";
      projectId: string;
      taskIds?: string[];
      scopes: LiveScope[];
    }
  | { kind: "personal"; userIds: string[]; scopes: LiveScope[] };

export function parseLiveEvent(payload: string): LiveEvent | undefined {
  if (Buffer.byteLength(payload, "utf8") > MAX_LIVE_PAYLOAD_BYTES) return;
  try {
    const result = liveEventSchema.safeParse(JSON.parse(payload));
    return result.success ? result.data : undefined;
  } catch {
    return;
  }
}

// Aggregate task IDs only within the same project. Personal audiences must never
// widen to all users: split them into bounded notifications instead.
export function encodeLiveChanges(changes: readonly LiveChange[]): string[] {
  const projects = new Map<
    string,
    { tasks: Set<string>; scopes: Set<LiveScope>; all: boolean }
  >();
  const people = new Map<string, Set<LiveScope>>();
  for (const change of changes) {
    scopes.parse(change.scopes);
    if (change.kind === "project") {
      id.parse(change.projectId);
      const item = projects.get(change.projectId) ?? {
        tasks: new Set<string>(),
        scopes: new Set<LiveScope>(),
        all: false,
      };
      if (!change.taskIds?.length) item.all = true;
      for (const taskId of change.taskIds ?? []) {
        id.parse(taskId);
        item.tasks.add(taskId);
      }
      for (const scope of change.scopes) item.scopes.add(scope);
      projects.set(change.projectId, item);
    } else {
      for (const recipientId of change.userIds) {
        userId.parse(recipientId);
        const item = people.get(recipientId) ?? new Set<LiveScope>();
        for (const scope of change.scopes) item.add(scope);
        people.set(recipientId, item);
      }
    }
  }
  const result: string[] = [];
  for (const [projectId, item] of projects) {
    const event: LiveEvent = {
      version: 1,
      kind: "project",
      projectId,
      taskIds: item.all || item.tasks.size > 32 ? [] : [...item.tasks],
      scopes: [...item.scopes],
    };
    if (Buffer.byteLength(JSON.stringify(event)) > MAX_LIVE_PAYLOAD_BYTES)
      event.taskIds = [];
    result.push(JSON.stringify(liveEventSchema.parse(event)));
  }
  const audiences = new Map<string, string[]>();
  for (const [userId, item] of people) {
    const key = JSON.stringify([...item].sort());
    const audience = audiences.get(key) ?? [];
    audience.push(userId);
    audiences.set(key, audience);
  }
  for (const [key, userIds] of audiences) {
    let event: Extract<LiveEvent, { kind: "personal" }> = {
      version: 1,
      kind: "personal",
      userIds: [],
      scopes: JSON.parse(key) as LiveScope[],
    };
    for (const userId of userIds) {
      const next = { ...event, userIds: [...event.userIds, userId] };
      if (
        next.userIds.length > 64 ||
        Buffer.byteLength(JSON.stringify(next)) > MAX_LIVE_PAYLOAD_BYTES
      ) {
        result.push(JSON.stringify(liveEventSchema.parse(event)));
        event = { ...event, userIds: [userId] };
      } else event = next;
    }
    result.push(JSON.stringify(liveEventSchema.parse(event)));
  }
  return result;
}
