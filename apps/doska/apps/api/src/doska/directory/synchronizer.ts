import { isDeepStrictEqual } from "node:util";
import { DirectoryClientError, type PlatformDirectoryClient } from "./client";
import type { DirectoryDepartment, DirectoryIdentity } from "./dto";

export interface DirectoryGeneration {
  departments: DirectoryDepartment[];
  identities: DirectoryIdentity[];
  cursor: string;
  requestStartedAt: Date;
  leaseUntil: Date;
}

type Source = Pick<
  PlatformDirectoryClient,
  "departments" | "employees" | "changes"
>;
type Publisher = (generation: DirectoryGeneration) => Promise<void>;
const MAX_ENTRIES = 100_000;
const SNAPSHOT_TTL = 15 * 60_000;
const LEASE_MS = 30_000;
const SNAPSHOT_REFRESH_MS = 5 * 60_000;

function invalid(): never {
  throw new DirectoryClientError("invalid_response");
}

/** A fresh process always bootstraps. Only the durable publisher may expose rights. */
export class DirectorySynchronizer {
  private generation?: DirectoryGeneration;
  private running = false;
  private epoch = 0;
  private lastTime = -Infinity;
  private snapshotAt = -Infinity;

  constructor(
    private readonly client: Source,
    private readonly publish: Publisher,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  invalidate(): void {
    this.generation = undefined;
    this.epoch++;
  }

  private now(): number {
    const time = this.clock().getTime();
    if (!Number.isFinite(time) || time < this.lastTime) {
      this.invalidate();
      invalid();
    }
    this.lastTime = time;
    return time;
  }

  async runOnce(): Promise<DirectoryGeneration> {
    if (this.running)
      throw new Error("Directory synchronization already running");
    this.running = true;
    const epoch = this.epoch;
    try {
      const startedAt = this.now();
      const refreshSnapshot =
        !this.generation || startedAt - this.snapshotAt >= SNAPSHOT_REFRESH_MS;
      const departments = new Map<string, DirectoryDepartment>();
      const identities = new Map<string, DirectoryIdentity>();
      let cursor: string;
      if (this.generation && !refreshSnapshot) {
        const previous = structuredClone(this.generation);
        for (const item of previous.departments) departments.set(item.id, item);
        for (const item of previous.identities) identities.set(item.sub, item);
        cursor = previous.cursor;
      } else {
        cursor = await this.snapshot(
          "departments",
          departments,
          (item) => item.id,
        );
        await this.snapshot("employees", identities, (item) => item.sub);
      }
      const seenCursors = new Set([cursor]);
      let count = 0;
      for (;;) {
        if (epoch !== this.epoch) invalid();
        const started = this.now();
        const page = await this.client.changes(cursor);
        this.now();
        count += page.items.length;
        if (count > MAX_ENTRIES) invalid();
        for (const event of page.items) {
          if (event.type === "identity.changed") {
            const old = identities.get(event.subject);
            if (!old || event.identity_revision > old.identity_revision) {
              identities.set(event.subject, structuredClone(event.identity));
            }
          } else if (event.type === "department.changed") {
            const old = departments.get(event.department.id);
            if (!old || event.department.revision > old.revision) {
              departments.set(
                event.department.id,
                structuredClone(event.department),
              );
            }
          } else {
            invalid();
          }
        }
        if (departments.size > MAX_ENTRIES || identities.size > MAX_ENTRIES)
          invalid();
        if (
          page.items.length &&
          (!page.next_cursor || seenCursors.has(page.next_cursor))
        )
          invalid();
        cursor = page.next_cursor;
        if (page.items.length < 100) {
          const generation: DirectoryGeneration = {
            departments: [...departments.values()],
            identities: [...identities.values()],
            cursor,
            requestStartedAt: new Date(started),
            leaseUntil: new Date(started + LEASE_MS),
          };
          if (epoch !== this.epoch || this.now() >= started + LEASE_MS)
            invalid();
          // The callback must atomically persist data/cursor/lease and fence stale
          // writers. Give it an isolated value so mutation cannot change our state.
          await this.publish(structuredClone(generation));
          if (epoch !== this.epoch || this.now() >= started + LEASE_MS)
            invalid();
          this.generation = generation;
          if (refreshSnapshot) this.snapshotAt = startedAt;
          return structuredClone(generation);
        }
        seenCursors.add(cursor);
      }
    } catch (error) {
      if (
        error instanceof DirectoryClientError &&
        error.code === "resync_required"
      ) {
        this.invalidate();
      }
      throw error;
    } finally {
      this.running = false;
    }
  }

  private async snapshot<K extends "departments" | "employees">(
    kind: K,
    target: Map<
      string,
      K extends "departments" ? DirectoryDepartment : DirectoryIdentity
    >,
    key: (
      item: K extends "departments" ? DirectoryDepartment : DirectoryIdentity,
    ) => string,
  ): Promise<string> {
    const started = this.now();
    const epoch = this.epoch;
    let cursor: string | undefined;
    let watermark: string | undefined;
    let count = 0;
    const seen = new Set<string>();
    for (;;) {
      const page = await this.client[kind](cursor);
      if (epoch !== this.epoch || this.now() - started >= SNAPSHOT_TTL)
        invalid();
      if (watermark === undefined) watermark = page.changes_cursor;
      else if (watermark !== page.changes_cursor) invalid();
      count += page.items.length;
      if (count > MAX_ENTRIES) invalid();
      for (const item of page.items) {
        // Endpoint and map type are coupled by K; the transport validates DTOs.
        const value = item as K extends "departments"
          ? DirectoryDepartment
          : DirectoryIdentity;
        const id = key(value);
        const previous = target.get(id);
        if (previous && !isDeepStrictEqual(previous, value)) invalid();
        target.set(id, structuredClone(value));
      }
      if (!page.next_cursor) return watermark;
      if (!page.items.length) invalid();
      if (seen.has(page.next_cursor)) invalid();
      seen.add(page.next_cursor);
      cursor = page.next_cursor;
    }
  }
}
