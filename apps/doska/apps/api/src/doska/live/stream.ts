import { HTTPException } from "hono/http-exception";
import type { LiveListener } from "./listener";
import type { LiveEvent } from "./events";
import {
  liveAccessProvider,
  type LiveAccess,
  type LiveAccessProvider,
  type ProjectEvent,
} from "./access";

const projectScopes = new Set([
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
  "template-selection",
  "invitations",
  "join-requests",
]);
const personalScopes = new Set([
  "projects",
  "templates",
  "invitations",
  "notifications",
  "preferences",
  "notification-preferences",
]);
type Frame = {
  name: "ready" | "reset" | "personal" | "changed";
  data: Record<string, unknown>;
  project?: ProjectEvent;
};
const reset: Frame = { name: "reset", data: { version: 1, reason: "resync" } };
const encoder = new TextEncoder();
export class LiveAdmission {
  private subjects = new Map<string, number>();
  private count = 0;
  constructor(
    private readonly total = 32,
    private readonly perSubject = 4,
  ) {}
  acquire(subject: string) {
    const count = this.subjects.get(subject) ?? 0;
    if (this.count >= this.total || count >= this.perSubject)
      throw new HTTPException(429, { message: "live_capacity" });
    this.count++;
    this.subjects.set(subject, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.count--;
      const remaining = (this.subjects.get(subject) ?? 1) - 1;
      if (remaining) this.subjects.set(subject, remaining);
      else this.subjects.delete(subject);
    };
  }
}

export async function openLiveStream(input: {
  request: Request;
  actorId: string;
  subject: string;
  listener: LiveListener;
  admission: LiveAdmission;
  access?: LiveAccessProvider;
  timing?: {
    leaseMs?: number;
    refreshMs?: number;
    heartbeatMs?: number;
    lifetimeMs?: number;
  };
}): Promise<Response> {
  const access = input.access ?? liveAccessProvider;
  const leaseMs = Math.min(5000, input.timing?.leaseMs ?? 5000);
  const refreshMs = Math.min(
    2000,
    input.timing?.refreshMs ?? 2000,
    leaseMs / 2,
  );
  const release = input.admission.acquire(input.subject);
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let subscription: ReturnType<LiveListener["subscribe"]>;
  let snapshot: LiveAccess | undefined;
  let deadline = Date.now() + leaseMs;
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  let authorizing = 0;
  const queue: Frame[] = [];
  const abort = new AbortController();
  const finish = () => {
    if (closed) {
      subscription?.unsubscribe();
      return;
    }
    closed = true;
    abort.abort();
    clearTimeout(leaseTimer);
    clearTimeout(refreshTimer);
    clearTimeout(lifetime);
    clearInterval(heartbeat);
    input.request.signal.removeEventListener("abort", finish);
    subscription?.unsubscribe();
    queue.length = 0;
    release();
    wake?.();
    try {
      controller?.close();
    } catch {
      /* Reader may already have cancelled. */
    }
  };
  input.request.signal.addEventListener("abort", finish, { once: true });
  const valid = () => {
    if (Date.now() >= deadline || input.request.signal.aborted) finish();
    return !closed;
  };
  const arm = () => {
    clearTimeout(leaseTimer);
    leaseTimer = setTimeout(finish, Math.max(0, deadline - Date.now()));
    leaseTimer.unref();
  };
  const bounded = <T>(pending: Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const stopped = () => reject(new Error("Live stream closed"));
      abort.signal.addEventListener("abort", stopped, { once: true });
      if (closed) stopped();
      void pending
        .then(resolve, reject)
        .finally(() => abort.signal.removeEventListener("abort", stopped));
    });
  const enqueue = (frame: Frame) => {
    if (!valid()) return;
    if (queue.length >= 32) {
      finish();
      return;
    }
    queue.push(frame);
    wake?.();
  };
  const refresh = async () => {
    try {
      const next = await bounded(access.snapshot(input.actorId, input.subject));
      if (!valid() || next.validUntil <= Date.now()) {
        finish();
        return;
      }
      const changed =
        snapshot &&
        (snapshot.projects.size !== next.projects.size ||
          [...snapshot.projects].some(
            ([id, stamp]) => next.projects.get(id) !== stamp,
          ));
      snapshot = next;
      deadline = Math.min(Date.now() + leaseMs, next.validUntil);
      arm();
      if (changed) {
        // Drop queued project IDs before announcing changed permissions.
        for (let i = queue.length - 1; i >= 0; i--)
          if (queue[i]?.project) queue.splice(i, 1);
        enqueue(reset);
      }
      refreshTimer = setTimeout(() => void refresh(), refreshMs);
      refreshTimer.unref();
    } catch {
      finish();
    }
  };
  arm();
  try {
    if (!valid()) throw new HTTPException(503, { message: "live_unavailable" });
    snapshot = await bounded(access.snapshot(input.actorId, input.subject));
    if (!valid() || snapshot.validUntil <= Date.now())
      throw new HTTPException(403, { message: "live_identity_unavailable" });
    deadline = Math.min(Date.now() + leaseMs, snapshot.validUntil);
    arm();
    subscription = input.listener.subscribe({
      onInvalidated: finish,
      onEvent(event: LiveEvent) {
        if (!valid()) return;
        if (event.kind === "personal") {
          if (!event.userIds.includes(input.actorId)) return;
          const scopes = event.scopes.filter((scope) =>
            personalScopes.has(scope),
          );
          if (scopes.length !== event.scopes.length) enqueue(reset);
          else enqueue({ name: "personal", data: { version: 1, scopes } });
          return;
        }
        // Foreign activity never reaches the authorization queue or its limits.
        if (!snapshot?.projects.has(event.projectId)) return;
        if (++authorizing > 32) {
          finish();
          return;
        }
        void bounded(access.filterProject(input.actorId, event))
          .then((allowed) => {
            if (!valid()) return;
            if (!allowed) {
              finish();
              return;
            }
            const scopes = allowed.scopes.filter((scope) =>
              projectScopes.has(scope),
            );
            if (scopes.length)
              enqueue({
                name: "changed",
                data: {},
                project: { ...allowed, scopes },
              });
          }, finish)
          .finally(() => {
            authorizing--;
          });
      },
    });
    if (!subscription || !valid())
      throw new HTTPException(503, { message: "live_listener_unavailable" });
    queue.unshift({ name: "ready", data: { version: 1 } });
    refreshTimer = setTimeout(() => void refresh(), refreshMs);
    refreshTimer.unref();
    lifetime = setTimeout(
      finish,
      Math.min(300000, input.timing?.lifetimeMs ?? 300000),
    );
    lifetime.unref();
    let heartbeatPending = false;
    heartbeat = setInterval(() => {
      heartbeatPending = true;
      wake?.();
    }, input.timing?.heartbeatMs ?? 15000);
    heartbeat.unref();
    const body = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
        },
        async pull(value) {
          while (valid()) {
            let frame = queue.shift();
            if (!frame && !heartbeatPending) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = undefined;
              continue;
            }
            if (frame?.project) {
              let allowed: ProjectEvent | null;
              try {
                allowed = await bounded(
                  access.filterProject(input.actorId, frame.project),
                );
              } catch {
                finish();
                return;
              }
              if (!valid()) return;
              if (!allowed || !snapshot?.projects.has(allowed.projectId))
                frame = reset;
              else
                frame = {
                  name: "changed",
                  data: {
                    version: 1,
                    projectId: allowed.projectId,
                    taskIds: allowed.taskIds,
                    scopes: allowed.scopes,
                  },
                };
            }
            if (!valid()) return;
            const bytes = frame
              ? encoder.encode(
                  `event: ${frame.name}\ndata: ${JSON.stringify(frame.data)}\n\n`,
                )
              : encoder.encode(": heartbeat\n\n");
            if (bytes.byteLength > 4096) {
              finish();
              return;
            }
            if (!frame) heartbeatPending = false;
            value.enqueue(bytes);
            return;
          }
        },
        cancel: finish,
      },
      { highWaterMark: 0 },
    );
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    finish();
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(503, { message: "live_unavailable" });
  }
}
