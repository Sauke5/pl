import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LiveAdmission, openLiveStream } from "./stream";
import type { LiveListener, LiveSubscriber } from "./listener";
import type { LiveEvent } from "./events";
import type { LiveAccessProvider } from "./access";

class Listener {
  subscribers = new Set<LiveSubscriber>();
  ready = true;
  immediate?: LiveEvent;
  subscribe(subscriber: LiveSubscriber) {
    if (!this.ready) return;
    this.subscribers.add(subscriber);
    if (this.immediate) subscriber.onEvent(this.immediate);
    return {
      generation: 1,
      unsubscribe: () => {
        this.subscribers.delete(subscriber);
      },
    };
  }
  emit(event: LiveEvent) {
    for (const subscriber of this.subscribers) subscriber.onEvent(event);
  }
  fail() {
    for (const subscriber of [...this.subscribers]) subscriber.onInvalidated();
  }
}
const streams: ReadableStreamDefaultReader<Uint8Array>[] = [];
afterEach(async () => {
  await Promise.all(streams.splice(0).map((reader) => reader.cancel()));
  vi.useRealTimers();
});
const projectEvent = (projectId = "visible"): LiveEvent => ({
  version: 1,
  kind: "project",
  projectId,
  taskIds: ["task"],
  scopes: ["tasks"],
});
function fixture() {
  const listener = new Listener();
  const abort = new AbortController();
  let visible = true;
  const access: LiveAccessProvider = {
    snapshot: vi.fn(async () => ({
      validUntil: Date.now() + 60000,
      projects: new Map(visible ? [["visible", "participant"]] : []),
    })),
    filterProject: vi.fn(async (_actor, event) => (visible ? event : null)),
  };
  const admission = new LiveAdmission(1, 1);
  const input = {
    request: new Request("http://localhost/api/doska/events", {
      signal: abort.signal,
    }),
    actorId: "actor",
    subject: "subject",
    listener: listener as unknown as LiveListener,
    access,
    admission,
    timing: { leaseMs: 200, refreshMs: 50, heartbeatMs: 1000 },
  };
  return {
    listener,
    abort,
    access,
    admission,
    input,
    revoke: () => {
      visible = false;
    },
  };
}
async function open(input: Parameters<typeof openLiveStream>[0]) {
  const response = await openLiveStream(input);
  const reader = response.body!.getReader();
  streams.push(reader);
  return reader;
}
async function read(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const result = await reader.read();
  return result.done ? null : new TextDecoder().decode(result.value);
}

describe("bounded authenticated live stream", () => {
  it("ready precedes an event received synchronously during registration", async () => {
    const f = fixture();
    f.listener.immediate = projectEvent();
    const reader = await open(f.input);
    expect(await read(reader)).toContain("event: ready");
    expect(await read(reader)).toContain('"projectId":"visible"');
  });
  it("foreign project and personal bursts never reach queue limits or emit frames", async () => {
    const f = fixture();
    const reader = await open(f.input);
    await read(reader);
    for (let i = 0; i < 200; i++) {
      f.listener.emit(projectEvent("secret"));
      f.listener.emit({
        version: 1,
        kind: "personal",
        userIds: ["other"],
        scopes: ["notifications"],
      });
    }
    expect(f.access.filterProject).not.toHaveBeenCalled();
    f.listener.emit(projectEvent());
    expect(await read(reader)).toContain('"projectId":"visible"');
    expect(f.listener.subscribers.size).toBe(1);
  });
  it("rechecks queued access when reader resumes; no revoked IDs escape", async () => {
    const f = fixture();
    const reader = await open(f.input);
    await read(reader);
    f.listener.emit(projectEvent());
    await Promise.resolve();
    await Promise.resolve();
    f.revoke();
    const frame = await read(reader);
    expect(frame).not.toContain("visible");
    expect(frame).not.toContain("taskIds");
  });
  it("periodic ACL changes cause an ID-free reset even without task events", async () => {
    const f = fixture();
    const reader = await open(f.input);
    await read(reader);
    f.revoke();
    expect(await read(reader)).toBe(
      'event: reset\ndata: {"version":1,"reason":"resync"}\n\n',
    );
  });
  it("a hanging lease refresh closes the stream and releases admission", async () => {
    const f = fixture();
    const reader = await open(f.input);
    await read(reader);
    vi.mocked(f.access.snapshot).mockImplementation(
      () => new Promise(() => {}),
    );
    expect(await read(reader)).toBeNull();
    expect(f.listener.subscribers.size).toBe(0);
    expect(() => f.admission.acquire("subject")()).not.toThrow();
  });
  it("listener failure and request abort clean up subscriptions and admission", async () => {
    for (const mode of ["listener", "abort"] as const) {
      const f = fixture();
      const reader = await open(f.input);
      await read(reader);
      if (mode === "listener") f.listener.fail();
      else f.abort.abort();
      expect(await read(reader)).toBeNull();
      expect(f.listener.subscribers.size).toBe(0);
      expect(() => f.admission.acquire("subject")()).not.toThrow();
    }
  });
  it("refuses an unavailable listener and bounds an authorized slow-reader queue", async () => {
    const f = fixture();
    f.listener.ready = false;
    await expect(openLiveStream(f.input)).rejects.toMatchObject({
      status: 503,
    });
    f.listener.ready = true;
    const reader = await open(f.input);
    await read(reader);
    for (let i = 0; i < 34; i++)
      f.listener.emit({
        version: 1,
        kind: "personal",
        userIds: ["actor"],
        scopes: ["notifications"],
      });
    expect(await read(reader)).toBeNull();
    expect(f.listener.subscribers.size).toBe(0);
  });
});
