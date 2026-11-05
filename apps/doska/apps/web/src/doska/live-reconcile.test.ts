import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api, ApiError } from "./api";
import { reconcileLiveAccess } from "./live-reconcile";
const context = (id = "alice") =>
  ({ user: { id } }) as Awaited<ReturnType<typeof api.getContext>>;
const access = { readContent: true } as Awaited<
  ReturnType<typeof api.getAccess>
>;
const source = () => ({
  getContext: vi.fn(async (_options?: { signal?: AbortSignal }) => context()),
  getAccess: vi.fn(
    async (_id: string, _options?: { signal?: AbortSignal }) => access,
  ),
});
afterEach(() => vi.useRealTimers());
describe("live access reconciliation", () => {
  it("purges revoked initialData from observers and aggregates while preserving allowed drafts' query data", async () => {
    const client = new QueryClient();
    const key = ["doska", "task", "private", "t"];
    const observer = new QueryObserver(client, {
      queryKey: key,
      initialData: { title: "secret" },
      enabled: false,
    });
    const off = observer.subscribe(() => {});
    client.setQueryData(["doska", "task", "allowed", "t"], {
      title: "allowed",
    });
    client.setQueryData(["doska", "my-tasks"], [{ title: "secret" }]);
    client.setQueryData(["doska", "overview"], { total: 4 });
    const src = source();
    src.getAccess.mockImplementation(async (id?: string) => {
      if (id === "private") throw new ApiError(403, "denied");
      return access;
    });
    await expect(
      reconcileLiveAccess(client, "alice", () => true, src),
    ).resolves.toBe("same-user");
    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getQueryData(["doska", "my-tasks"])).toBeUndefined();
    expect(client.getQueryData(["doska", "overview"])).toBeUndefined();
    expect(client.getQueryData(["doska", "task", "allowed", "t"])).toEqual({
      title: "allowed",
    });
    off();
    client.clear();
  });
  it("clears private data on user change, even when project IDs overlap", async () => {
    const client = new QueryClient();
    client.setQueryData(["doska", "task", "p", "t"], "secret");
    const src = source();
    src.getContext.mockResolvedValue(context("bob"));
    expect(await reconcileLiveAccess(client, "alice", () => true, src)).toBe(
      "user-changed",
    );
    expect(client.getQueryData(["doska", "task", "p", "t"])).toBeUndefined();
    expect(client.getQueryData(["doska", "context"])).toEqual(context("bob"));
    expect(src.getAccess).not.toHaveBeenCalled();
    client.clear();
  });
  it("clears a blocked session and notifies its context observer", async () => {
    const client = new QueryClient();
    client.setQueryData(["doska", "context"], context());
    client.setQueryData(["doska", "notifications"], "secret");
    const src = source();
    src.getContext.mockRejectedValue(new ApiError(401, "blocked"));
    await expect(
      reconcileLiveAccess(client, "alice", () => true, src),
    ).rejects.toMatchObject({ status: 401 });
    expect(client.getQueryData(["doska", "context"])).toBeUndefined();
    expect(client.getQueryState(["doska", "context"])?.status).toBe("error");
    expect(client.getQueryData(["doska", "notifications"])).toBeUndefined();
    client.clear();
  });
  it("bounds a hung request and ignores its eventual context response", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const src = source();
    let resolve!: (value: ReturnType<typeof context>) => void;
    src.getContext.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const result = expect(
      reconcileLiveAccess(client, "alice", () => true, src),
    ).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(src.getContext.mock.calls[0]?.[0]?.signal?.aborted).toBe(true);
    resolve(context("bob"));
    await Promise.resolve();
    await Promise.resolve();
    expect(client.getQueryData(["doska", "context"])).toBeUndefined();
    client.clear();
  });
  it("ignores an obsolete access response after cleanup", async () => {
    const client = new QueryClient();
    client.setQueryData(["doska", "task", "p", "t"], "draft");
    const src = source();
    let active = true;
    src.getAccess.mockImplementation(async () => {
      active = false;
      return access;
    });
    expect(await reconcileLiveAccess(client, "alice", () => active, src)).toBe(
      "obsolete",
    );
    expect(client.getQueryData(["doska", "access", "p"])).toBeUndefined();
    expect(client.getQueryData(["doska", "task", "p", "t"])).toBe("draft");
    client.clear();
  });
  it("aborts an in-flight ACL fetch on cleanup", async () => {
    const client = new QueryClient();
    client.setQueryData(["doska", "task", "p", "t"], "private");
    const src = source();
    const controller = new AbortController();
    src.getAccess.mockImplementation(
      (_id, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const promise = reconcileLiveAccess(
      client,
      "alice",
      () => !controller.signal.aborted,
      src,
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    expect(await promise).toBe("obsolete");
    expect(src.getAccess.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    client.clear();
  });
});
