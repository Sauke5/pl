import type { DirectoryTelemetry } from "../telemetry";
import { DirectoryClientError, PlatformDirectoryClient } from "./client";
import {
  DirectoryProjectionError,
  PostgresDirectoryProjection,
} from "./projection";
import { DirectorySynchronizer } from "./synchronizer";

type DirectorySource = Pick<
  PlatformDirectoryClient,
  "departments" | "employees" | "changes"
>;
type Projection = Pick<PostgresDirectoryProjection, "revision" | "publish">;

/** Per-process readiness remains cold until this consumer has caught up. */
export class DirectoryWorker {
  private readonly synchronizer: DirectorySynchronizer;
  private expectedRevision?: number;
  private readyUntil = 0;
  private readyFrom = 0;
  private lastSuccessAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private stopped = true;
  private stopping = false;
  private lastTime = -Infinity;

  constructor(
    client: DirectorySource,
    private readonly projection: Projection,
    private readonly clock: () => Date = () => new Date(),
    private readonly reportError: (code: string) => void = (code) =>
      console.error(`Doska directory: ${code}`),
  ) {
    this.synchronizer = new DirectorySynchronizer(
      client,
      async (generation) => {
        if (this.stopped || this.expectedRevision === undefined)
          throw new Error("Directory worker stopped");
        this.expectedRevision = await projection.publish(
          generation,
          this.expectedRevision,
        );
      },
      () => this.now(),
    );
  }

  private now(): Date {
    const now = this.clock();
    if (!Number.isFinite(now.getTime()) || now.getTime() < this.lastTime) {
      this.readyUntil = 0;
      throw new DirectoryClientError("invalid_response");
    }
    this.lastTime = now.getTime();
    return now;
  }

  ready(): boolean {
    try {
      const now = this.now().getTime();
      return !this.stopped && now >= this.readyFrom && now < this.readyUntil;
    } catch {
      return false;
    }
  }

  telemetry(): DirectoryTelemetry {
    const ready = this.ready();
    return {
      ready,
      leaseExpiresTimestampSeconds: this.readyUntil / 1000,
      lastSuccessTimestampSeconds: this.lastSuccessAt / 1000,
    };
  }

  start(): void {
    if (this.stopping) throw new Error("Directory worker is stopping");
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      await this.pending;
      return;
    }
    this.stopping = true;
    this.stopped = true;
    this.readyUntil = 0;
    clearTimeout(this.timer);
    this.synchronizer.invalidate();
    await this.pending;
    this.expectedRevision = undefined;
    this.stopping = false;
  }

  private schedule(delay: number) {
    this.timer = setTimeout(() => {
      this.pending = this.run();
    }, delay);
    this.timer.unref();
  }

  private async run() {
    const started = this.clock().getTime();
    try {
      this.expectedRevision ??= await this.projection.revision();
      if (this.stopped) return;
      const generation = await this.synchronizer.runOnce();
      if (!this.stopped) {
        this.readyFrom = generation.requestStartedAt.getTime();
        this.readyUntil = generation.leaseUntil.getTime();
        this.lastSuccessAt = this.now().getTime();
      }
    } catch (error) {
      const code =
        error instanceof DirectoryClientError ||
        error instanceof DirectoryProjectionError
          ? error.code
          : "synchronization_failed";
      if (code === "conflict" || code === "resync_required") {
        this.readyUntil = 0;
        this.expectedRevision = undefined;
        this.synchronizer.invalidate();
      }
      if (!this.stopped) this.reportError(code);
    } finally {
      if (!this.stopped)
        this.schedule(Math.max(0, 15_000 - (this.clock().getTime() - started)));
    }
  }
}

export function createConfiguredDirectoryWorker() {
  const machineTokenFile = process.env.DOSKA_DIRECTORY_TOKEN_FILE;
  if (!machineTokenFile || !process.env.DOSKA_MODULE_INSTANCE_ID || !process.env.DOSKA_DIRECTORY_ORIGIN)
    throw new DirectoryClientError("invalid_configuration");
  return new DirectoryWorker(
    new PlatformDirectoryClient({
      origin: process.env.DOSKA_DIRECTORY_ORIGIN ?? "",
      instanceID: process.env.DOSKA_MODULE_INSTANCE_ID,
      machineTokenFile,
    }),
    new PostgresDirectoryProjection(),
  );
}

/** The actual Node server uses this gate, so a restart cannot reuse an old DB lease. */
export function directoryReadyFetch<Bindings>(
  ready: () => boolean,
  fetcher: (request: Request, env: Bindings) => Response | Promise<Response>,
) {
  return (request: Request, env: Bindings): Response | Promise<Response> => {
    const available = ready();
    if (
      request.method === "GET" &&
      new URL(request.url).pathname === "/healthz"
    )
      return Response.json(
        { status: available ? "ready" : "synchronizing" },
        {
          status: available ? 200 : 503,
          headers: { "Cache-Control": "no-store" },
        },
      );
    return available
      ? fetcher(request, env)
      : Response.json(
          { error: "directory_synchronization_pending" },
          {
            status: 503,
            headers: { "Cache-Control": "no-store", "Retry-After": "15" },
          },
        );
  };
}
