import type { HttpBindings } from "@hono/node-server";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { DirectoryClientError, type PlatformDirectoryClient } from "./client";
import {
  DirectoryProjectionError,
  type PostgresDirectoryProjection,
} from "./projection";
import { DirectoryWorker, directoryReadyFetch } from "./worker";

// The injected projection owns persistence in these tests; never create a pool.
vi.mock("../../database", () => ({ default: {} }));

const workers: DirectoryWorker[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T10:00:00Z"));
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const client = {
    departments: vi
      .fn<PlatformDirectoryClient["departments"]>()
      .mockResolvedValue({
        schema_version: 1,
        items: [],
        next_cursor: "",
        changes_cursor: "D",
      }),
    employees: vi.fn<PlatformDirectoryClient["employees"]>().mockResolvedValue({
      schema_version: 1,
      items: [],
      next_cursor: "",
      changes_cursor: "E",
    }),
    changes: vi
      .fn<PlatformDirectoryClient["changes"]>()
      .mockImplementation(async (cursor) => ({
        schema_version: 1,
        items: [],
        next_cursor: cursor ?? "",
      })),
  };
  const projection = {
    revision: vi
      .fn<PostgresDirectoryProjection["revision"]>()
      .mockResolvedValue(7),
    publish: vi
      .fn<PostgresDirectoryProjection["publish"]>()
      .mockImplementation(async (_generation, expected) => expected + 1),
  };
  const report = vi.fn();
  const worker = new DirectoryWorker(
    client,
    projection,
    () => new Date(),
    report,
  );
  workers.push(worker);
  return { worker, client, projection, report };
}

async function start(worker: DirectoryWorker) {
  worker.start();
  await vi.advanceTimersByTimeAsync(0);
}

describe("directory worker", () => {
  it("starts cold even with an existing durable revision and waits for publication", async () => {
    const f = fixture();
    const publication = deferred<number>();
    f.projection.publish.mockReturnValueOnce(publication.promise);
    expect(f.worker.ready()).toBe(false);
    await start(f.worker);
    expect(f.projection.revision).toHaveBeenCalledOnce();
    expect(f.projection.publish).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "D" }),
      7,
    );
    expect(f.worker.ready()).toBe(false);
    publication.resolve(8);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.worker.ready()).toBe(true);
  });

  it("polls the published state and advances CAS only after successful publication", async () => {
    const f = fixture();
    await start(f.worker);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.projection.publish.mock.calls.map((call) => call[1])).toEqual([
      7, 8,
    ]);
    expect(f.projection.revision).toHaveBeenCalledOnce();
    expect(f.client.departments).toHaveBeenCalledOnce();
    expect(f.client.changes.mock.calls).toEqual([["D"], ["D"]]);
    expect(f.worker.ready()).toBe(true);
  });

  it("does not extend readiness on request failures and expires at the original deadline", async () => {
    const f = fixture();
    await start(f.worker);
    f.client.changes.mockRejectedValue(new DirectoryClientError("unavailable"));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.worker.ready()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.worker.ready()).toBe(false);
    expect(f.projection.publish).toHaveBeenCalledOnce();
    expect(f.report).toHaveBeenCalledWith("unavailable");
  });

  it("publication failures preserve the prior CAS and do not extend readiness", async () => {
    const f = fixture();
    await start(f.worker);
    f.projection.publish.mockRejectedValueOnce(new Error("database offline"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.report).toHaveBeenCalledWith("synchronization_failed");
    const retry = deferred<number>();
    f.projection.publish.mockReturnValueOnce(retry.promise);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.worker.ready()).toBe(false);
    expect(f.projection.publish.mock.calls.map((call) => call[1])).toEqual([
      7, 8, 8,
    ]);
    retry.resolve(9);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.worker.ready()).toBe(true);
  });

  it.each(["resync_required", "conflict"] as const)(
    "%s immediately clears readiness and reacquires CAS with a full bootstrap",
    async (code) => {
      const f = fixture();
      await start(f.worker);
      if (code === "resync_required")
        f.client.changes.mockRejectedValueOnce(
          new DirectoryClientError(code, 410),
        );
      else
        f.projection.publish.mockRejectedValueOnce(
          new DirectoryProjectionError(code),
        );
      await vi.advanceTimersByTimeAsync(15_000);
      expect(f.worker.ready()).toBe(false);
      expect(f.report).toHaveBeenCalledWith(code);
      f.projection.revision.mockResolvedValueOnce(99);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(f.projection.revision).toHaveBeenCalledTimes(2);
      expect(f.client.departments).toHaveBeenCalledTimes(2);
      expect(f.client.employees).toHaveBeenCalledTimes(2);
      expect(f.projection.publish.mock.calls.at(-1)?.[1]).toBe(99);
      expect(f.worker.ready()).toBe(true);
    },
  );

  it("repeated start is idempotent and never overlaps a slow request", async () => {
    const f = fixture();
    const request =
      deferred<Awaited<ReturnType<PlatformDirectoryClient["changes"]>>>();
    f.client.changes.mockReturnValueOnce(request.promise);
    f.worker.start();
    f.worker.start();
    await vi.advanceTimersByTimeAsync(0);
    f.worker.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.client.changes).toHaveBeenCalledOnce();
    expect(f.projection.publish).not.toHaveBeenCalled();
    request.resolve({ schema_version: 1, items: [], next_cursor: "D" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.worker.ready()).toBe(true);
    expect(f.projection.publish).toHaveBeenCalledTimes(2);
    expect(f.projection.publish.mock.calls.map((call) => call[1])).toEqual([
      7, 8,
    ]);
  });

  it("stop waits for an in-flight read, discards it and never renews readiness", async () => {
    const f = fixture();
    await start(f.worker);
    const request =
      deferred<Awaited<ReturnType<PlatformDirectoryClient["changes"]>>>();
    f.client.changes.mockReturnValueOnce(request.promise);
    await vi.advanceTimersByTimeAsync(15_000);
    let stopped = false;
    const stopping = f.worker.stop().then(() => {
      stopped = true;
    });
    expect(f.worker.ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    expect(() => f.worker.start()).toThrow("stopping");
    request.resolve({ schema_version: 1, items: [], next_cursor: "D" });
    await stopping;
    expect(f.projection.publish).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.client.changes).toHaveBeenCalledTimes(2);
    expect(f.worker.ready()).toBe(false);
    expect(f.report).not.toHaveBeenCalled();
    await start(f.worker);
    expect(f.client.departments).toHaveBeenCalledTimes(2);
    expect(f.projection.revision).toHaveBeenCalledTimes(2);
    expect(f.worker.ready()).toBe(true);
  });

  it("clock rollback within an otherwise valid lease immediately fails closed", async () => {
    const f = fixture();
    await start(f.worker);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.worker.ready()).toBe(true);
    vi.setSystemTime(new Date("2026-10-23T10:00:09Z"));
    expect(f.worker.ready()).toBe(false);
    vi.setSystemTime(new Date("2026-10-23T10:00:10Z"));
    expect(f.worker.ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.projection.publish).toHaveBeenCalledTimes(2);
    expect(f.worker.ready()).toBe(true);
  });

  it("stop also awaits an in-flight publication without restoring readiness", async () => {
    const f = fixture();
    const publication = deferred<number>();
    f.projection.publish.mockReturnValueOnce(publication.promise);
    await start(f.worker);
    let stopped = false;
    const stopping = f.worker.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    publication.resolve(8);
    await stopping;
    expect(f.worker.ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.client.changes).toHaveBeenCalledOnce();
  });
});

describe("directory readiness HTTP gate", () => {
  it("blocks a cold process with no-store 503 without invoking the application", async () => {
    const app = vi.fn(() => new Response("application"));
    const fetcher = directoryReadyFetch(() => false, app);
    const env = {} as HttpBindings;
    const response = await fetcher(
      new Request("http://localhost/doska/api/project"),
      env,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Retry-After")).toBe("15");
    expect(await response.json()).toEqual({
      error: "directory_synchronization_pending",
    });
    expect(app).not.toHaveBeenCalled();
  });

  it("passes the exact Request and raw HttpBindings through when ready", async () => {
    const request = new Request("http://localhost/doska/api/project");
    const env = {
      incoming: {
        rawHeaders: [
          "X-PL-Assertion",
          "signed",
          "X-PL-Assertion",
          "duplicate",
        ],
      },
      outgoing: {},
    } as unknown as HttpBindings;
    const response = new Response("application");
    const app = vi.fn((_request: Request, _env: HttpBindings) => response);
    expect(await directoryReadyFetch(() => true, app)(request, env)).toBe(
      response,
    );
    expect(app.mock.calls[0]?.[0]).toBe(request);
    expect(app.mock.calls[0]?.[1]).toBe(env);
    expect(app.mock.calls[0]?.[1].incoming.rawHeaders).toEqual(
      env.incoming.rawHeaders,
    );
  });
});

it.each([true, false])(
  "reports internal readiness %s without exposing application data",
  async (ready) => {
    const app = vi.fn(() => new Response("private"));
    const response = await directoryReadyFetch(() => ready, app)(
      new Request("http://localhost/healthz"),
      {},
    );
    expect(response.status).toBe(ready ? 200 : 503);
    expect(await response.json()).toEqual({
      status: ready ? "ready" : "synchronizing",
    });
    expect(app).not.toHaveBeenCalled();
  },
);

describe("directory worker telemetry", () => {
  it("timestamps success after publication rather than at request start", async () => {
    const f = fixture();
    const publication = deferred<number>();
    f.projection.publish.mockReturnValueOnce(publication.promise);
    await start(f.worker);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.worker.telemetry().lastSuccessTimestampSeconds).toBe(0);
    publication.resolve(8);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.worker.telemetry().lastSuccessTimestampSeconds).toBe(
      Date.now() / 1000,
    );
    expect(f.worker.telemetry().leaseExpiresTimestampSeconds).toBe(
      Date.now() / 1000 + 25,
    );
  });

  it("stays cold before publication, records committed success and expires without polling", async () => {
    const f = fixture();
    expect(f.worker.telemetry()).toEqual({
      ready: false,
      leaseExpiresTimestampSeconds: 0,
      lastSuccessTimestampSeconds: 0,
    });
    await start(f.worker);
    const initial = f.worker.telemetry();
    expect(initial.ready).toBe(true);
    expect(initial.lastSuccessTimestampSeconds).toBe(Date.now() / 1000);
    expect(initial.leaseExpiresTimestampSeconds).toBe(Date.now() / 1000 + 30);
    f.client.changes.mockRejectedValue(new DirectoryClientError("unavailable"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.worker.telemetry()).toEqual({ ...initial, ready: false });
    expect(f.projection.publish).toHaveBeenCalledTimes(1);
    await f.worker.stop();
    expect(f.worker.telemetry()).toEqual({
      ...initial,
      ready: false,
      leaseExpiresTimestampSeconds: 0,
    });
    const restarted = fixture();
    expect(restarted.worker.telemetry().lastSuccessTimestampSeconds).toBe(0);
  });
  it("does not report failed publication as a successful synchronization", async () => {
    const f = fixture();
    f.projection.publish.mockRejectedValue(new Error("offline"));
    await start(f.worker);
    expect(f.worker.telemetry()).toEqual({
      ready: false,
      leaseExpiresTimestampSeconds: 0,
      lastSuccessTimestampSeconds: 0,
    });
  });
});
