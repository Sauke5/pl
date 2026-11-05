import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vite-plus/test";
import { createLiveCacheScheduler, liveEventMatchesKey } from "./live-cache";
import type { LiveEvent } from "./live-events";
const event: Extract<LiveEvent, { type: "changed" }> = {
  type: "changed",
  version: 1,
  projectId: "p",
  taskIds: ["t"],
  scopes: ["tasks", "history"],
};
function deferred() {
  let resolve!: (value: number) => void;
  const promise = new Promise<number>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
};
describe("live cache", () => {
  it("maps project, task, aggregate and personal keys without matching other projects", () => {
    for (const key of [
      ["tasks", "p"],
      ["task", "p", "t"],
      ["subtasks", "p", "parent"],
      ["my-tasks", 0],
      ["task-search", {}],
      ["overview", 0],
    ])
      expect(liveEventMatchesKey(event, ["doska", ...key])).toBe(true);
    for (const key of [
      ["tasks", "other"],
      ["task", "p", "other"],
      ["context"],
      ["preferences"],
    ])
      expect(liveEventMatchesKey(event, ["doska", ...key])).toBe(false);
    expect(
      liveEventMatchesKey(
        { type: "personal", version: 1, scopes: ["templates"] },
        ["doska", "template", "id"],
      ),
    ).toBe(true);
  });
  it("refreshes notification badge and task aggregates for field/label changes", () => {
    const notification = {
      type: "personal" as const,
      version: 1 as const,
      scopes: ["notifications" as const],
    };
    for (const name of ["notifications", "unread-count"])
      expect(liveEventMatchesKey(notification, ["doska", name])).toBe(true);
    expect(
      liveEventMatchesKey(notification, ["doska", "notification-preferences"]),
    ).toBe(false);
    for (const scope of ["fields", "labels"] as const)
      for (const name of ["my-tasks", "task-search"])
        expect(
          liveEventMatchesKey({ ...event, scopes: [scope] }, ["doska", name]),
        ).toBe(true);
  });
  it("waits for an old fetch and fences a second event during the next response", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const replies = [deferred(), deferred(), deferred()];
    let calls = 0;
    const key = ["doska", "task", "p", "t"];
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: () => replies[calls++].promise,
    });
    const unsubscribe = observer.subscribe(() => {});
    const scheduler = createLiveCacheScheduler(client, {
      onResync: vi.fn(),
      delayMs: 0,
    });
    try {
      expect(calls).toBe(1);
      scheduler.resyncAvailableQueries();
      await tick();
      replies[0].resolve(1);
      await tick();
      expect(calls).toBe(2);
      scheduler.accept(event);
      replies[1].resolve(2);
      await tick();
      expect(calls).toBe(3);
      replies[2].resolve(3);
      await tick();
      expect(client.getQueryData(key)).toBe(3);
    } finally {
      scheduler.stop();
      unsubscribe();
      client.clear();
    }
  });
  it("coalesces bursts and marks inactive entries stale without fetching them", async () => {
    const client = new QueryClient();
    const key = ["doska", "tasks", "p"];
    const fn = vi.fn(async () => 2);
    client.setQueryData(key, 1);
    client.setQueryData(["doska", "history", "p", "t"], 1);
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: fn,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    const scheduler = createLiveCacheScheduler(client, {
      onResync: vi.fn(),
      delayMs: 0,
    });
    try {
      for (let i = 0; i < 20; i++) scheduler.accept(event);
      await tick();
      expect(fn).toHaveBeenCalledTimes(1);
      expect(
        client.getQueryState(["doska", "history", "p", "t"])?.isInvalidated,
      ).toBe(true);
    } finally {
      scheduler.stop();
      unsubscribe();
      client.clear();
    }
  });
  it("stop prevents a follow-up fetch after an already running request finishes", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const reply = deferred();
    const fn = vi.fn(() => reply.promise);
    const observer = new QueryObserver(client, {
      queryKey: ["doska", "task", "p", "t"],
      queryFn: fn,
    });
    const unsubscribe = observer.subscribe(() => {});
    const scheduler = createLiveCacheScheduler(client, {
      onResync: vi.fn(),
      delayMs: 0,
    });
    scheduler.accept(event);
    await tick();
    scheduler.stop();
    reply.resolve(1);
    await tick();
    expect(fn).toHaveBeenCalledTimes(1);
    unsubscribe();
    client.clear();
  });
  it("delegates ready/reset access reconciliation and stops queued work without clearing identity", async () => {
    const client = new QueryClient();
    client.setQueryData(["doska", "context"], { user: "me" });
    const onResync = vi.fn();
    const scheduler = createLiveCacheScheduler(client, {
      onResync,
      delayMs: 0,
    });
    scheduler.accept({ type: "ready", version: 1 });
    scheduler.accept({ type: "reset", version: 1, reason: "resync" });
    expect(onResync.mock.calls).toEqual([["ready"], ["reset"]]);
    scheduler.stop();
    scheduler.accept({ type: "ready", version: 1 });
    await tick();
    expect(onResync).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(["doska", "context"])).toEqual({ user: "me" });
    client.clear();
  });
  it("cancels hung old and refresh fetches, then accepts later events", async () => {
    vi.useFakeTimers();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const key = ["doska", "task", "p", "t"];
    const signals: AbortSignal[] = [];
    let calls = 0;
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: ({ signal }) => {
        signals.push(signal);
        calls++;
        return calls < 3 ? new Promise<number>(() => {}) : Promise.resolve(3);
      },
    });
    const off = observer.subscribe(() => {});
    const scheduler = createLiveCacheScheduler(client, {
      onResync: vi.fn(),
      delayMs: 0,
      fetchTimeoutMs: 100,
    });
    try {
      scheduler.accept(event);
      await vi.advanceTimersByTimeAsync(101);
      expect(signals[0].aborted).toBe(true);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(101);
      expect(signals[1].aborted).toBe(true);
      scheduler.accept(event);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.getQueryData(key)).toBe(3);
    } finally {
      scheduler.stop();
      off();
      client.clear();
      vi.useRealTimers();
    }
  });
  it("stop releases a hung wait without leaving its timeout or starting a refresh", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const fn = vi.fn(() => new Promise<number>(() => {}));
    const observer = new QueryObserver(client, {
      queryKey: ["doska", "task", "p", "t"],
      queryFn: fn,
    });
    const off = observer.subscribe(() => {});
    const scheduler = createLiveCacheScheduler(client, {
      onResync: vi.fn(),
      delayMs: 0,
      fetchTimeoutMs: 100,
    });
    scheduler.accept(event);
    await vi.advanceTimersByTimeAsync(1);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(101);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    client.clear();
    vi.useRealTimers();
  });
});
