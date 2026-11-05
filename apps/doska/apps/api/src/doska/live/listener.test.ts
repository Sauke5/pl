import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LiveListener, type LiveClient } from "./listener";
import { LIVE_CHANNEL } from "./events";

class FakeClient extends EventEmitter {
  connect = vi.fn(async () => {});
  query = vi.fn(async () => {});
  end = vi.fn(async () => {});
  notify(
    payload = JSON.stringify({
      version: 1,
      kind: "project",
      projectId: "p",
      taskIds: ["t"],
      scopes: ["tasks"],
    }),
  ) {
    this.emit("notification", { channel: LIVE_CHANNEL, payload });
  }
}
const listeners: LiveListener[] = [];
function fixture(clients: FakeClient[], options = {}) {
  const listener = new LiveListener({
    createClient: () => clients.shift()! as unknown as LiveClient,
    reconnectMs: 10,
    ...options,
  });
  listeners.push(listener);
  return listener;
}
afterEach(async () => {
  for (const listener of listeners.splice(0)) await listener.stop();
  vi.useRealTimers();
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("shared LISTEN lifecycle", () => {
  it("does not admit streams before LISTEN, registers synchronously when ready", async () => {
    const client = new FakeClient();
    let accept!: () => void;
    client.query.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const listener = fixture([client]);
    const subscriber = { onEvent: vi.fn(), onInvalidated: vi.fn() };
    listener.start();
    await tick();
    expect(listener.subscribe(subscriber)).toBeUndefined();
    listener.observeState((state) => {
      if (state.ready) listener.subscribe(subscriber);
    });
    client.notify();
    accept();
    await tick();
    expect(subscriber.onEvent).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith("LISTEN doska_changes");
    await listener.stop();
    expect(subscriber.onInvalidated).toHaveBeenCalledTimes(1);
  });

  it("invalidates once on failure and reopens a new generation without stale delivery", async () => {
    const first = new FakeClient(),
      second = new FakeClient();
    const listener = fixture([first, second]);
    listener.start();
    await tick();
    const subscriber = { onEvent: vi.fn(), onInvalidated: vi.fn() };
    expect(listener.subscribe(subscriber)?.generation).toBe(1);
    first.emit("error", new Error("connection lost"));
    first.emit("end");
    expect(listener.getState().ready).toBe(false);
    expect(subscriber.onInvalidated).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listener.getState()).toEqual({ ready: true, generation: 2 });
    first.notify();
    second.notify();
    expect(subscriber.onEvent).not.toHaveBeenCalled();
    expect(first.end).toHaveBeenCalledTimes(1);
    expect(second.connect).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid payloads and isolates a throwing consumer", async () => {
    const client = new FakeClient();
    const listener = fixture([client]);
    listener.start();
    await tick();
    const bad = {
      onEvent: vi.fn(() => {
        throw new Error("subscriber bug");
      }),
      onInvalidated: vi.fn(),
    };
    const good = { onEvent: vi.fn(), onInvalidated: vi.fn() };
    listener.subscribe(bad);
    listener.subscribe(good);
    client.notify();
    expect(bad.onInvalidated).toHaveBeenCalledTimes(1);
    expect(good.onEvent).toHaveBeenCalledTimes(1);
    client.notify("invalid");
    expect(listener.getState().ready).toBe(false);
    expect(good.onInvalidated).toHaveBeenCalledTimes(1);
  });

  it("bounds stuck startup and shutdown and never overlaps a stuck closing socket", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.connect.mockImplementation(() => new Promise(() => {}));
    client.end.mockImplementation(() => new Promise(() => {}));
    const listener = fixture([client], { lifecycleTimeoutMs: 20 });
    listener.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(client.end).toHaveBeenCalledTimes(1);
    const stopped = listener.stop();
    await vi.advanceTimersByTimeAsync(20);
    await stopped;
    listener.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(listener.getState().ready).toBe(false);
  });
});
