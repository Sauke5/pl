import { describe, expect, it, vi } from "vite-plus/test";
import { DirectoryClientError, type PlatformDirectoryClient } from "./client";
import type {
  DirectoryChange,
  DirectoryDepartment,
  DirectoryIdentity,
} from "./dto";
import {
  DirectorySynchronizer,
  type DirectoryGeneration,
} from "./synchronizer";

const department: DirectoryDepartment = {
  id: "d",
  name: "Department",
  revision: 1,
  active: true,
  head_subjects: [],
};
const identity: DirectoryIdentity = {
  schema_version: 1,
  sub: "ad:1",
  name: "Employee",
  state: "active",
  identity_revision: 4,
  department_state: "resolved",
  primary_department_id: "d",
  head_department_ids: [],
  observed_at: "2026-10-23T10:00:00Z",
  valid_until: "2026-10-23T12:00:00Z",
};
const changed = (
  revision: number,
  cursor = `event-${revision}`,
): DirectoryChange => ({
  type: "identity.changed",
  cursor,
  event_id: cursor,
  occurred_at: identity.observed_at,
  subject: identity.sub,
  identity_revision: revision,
  previous_department_id: null,
  primary_department_id: "d",
  identity: { ...identity, identity_revision: revision },
});
function fixture() {
  let time = Date.parse("2026-10-23T10:00:00Z");
  const client = {
    departments: vi
      .fn<PlatformDirectoryClient["departments"]>()
      .mockResolvedValue({
        schema_version: 1,
        items: [department],
        next_cursor: "",
        changes_cursor: "D",
      }),
    employees: vi.fn<PlatformDirectoryClient["employees"]>().mockResolvedValue({
      schema_version: 1,
      items: [identity],
      next_cursor: "",
      changes_cursor: "E",
    }),
    changes: vi
      .fn<PlatformDirectoryClient["changes"]>()
      .mockImplementation(async (after) => ({
        schema_version: 1,
        items: [],
        next_cursor: after ?? "",
      })),
  };
  const publish = vi
    .fn<(generation: DirectoryGeneration) => Promise<void>>()
    .mockResolvedValue();
  const sync = new DirectorySynchronizer(client, publish, () => new Date(time));
  return {
    client,
    publish,
    sync,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("directory synchronization", () => {
  it("refreshes unchanged identities from bounded snapshots every five minutes without events", async () => {
    const f = fixture();
    await f.sync.runOnce();
    f.advance(15_000);
    await f.sync.runOnce();
    expect(f.client.employees).toHaveBeenCalledTimes(1);
    const fresh = {
      ...identity,
      observed_at: "2026-10-23T10:05:00Z",
      valid_until: "2026-10-23T12:05:00Z",
    };
    f.client.employees.mockResolvedValue({
      schema_version: 1,
      items: [fresh],
      next_cursor: "",
      changes_cursor: "fresh-E",
    });
    f.advance(285_000);
    const result = await f.sync.runOnce();
    expect(f.client.departments).toHaveBeenCalledTimes(2);
    expect(f.client.employees).toHaveBeenCalledTimes(2);
    expect(result.identities).toEqual([fresh]);
    expect(
      result.leaseUntil.getTime() - result.requestStartedAt.getTime(),
    ).toBe(30_000);
  });

  it("does not publish partial periodic snapshots and retries the whole snapshot", async () => {
    const f = fixture();
    await f.sync.runOnce();
    f.advance(300_000);
    f.client.employees.mockRejectedValueOnce(
      new DirectoryClientError("unavailable"),
    );
    await expect(f.sync.runOnce()).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(f.publish).toHaveBeenCalledTimes(1);
    await f.sync.runOnce();
    expect(f.client.departments).toHaveBeenCalledTimes(3);
    expect(f.publish).toHaveBeenCalledTimes(2);
  });

  it("finishes D before E and replays from D, preserving newer employee snapshot", async () => {
    const f = fixture();
    f.client.departments.mockResolvedValueOnce({
      schema_version: 1,
      items: [department],
      next_cursor: "d-page",
      changes_cursor: "D",
    });
    f.client.employees.mockImplementationOnce(async () => {
      expect(f.client.departments).toHaveBeenCalledTimes(2);
      return {
        schema_version: 1,
        items: [identity],
        next_cursor: "",
        changes_cursor: "E",
      };
    });
    f.client.changes.mockResolvedValueOnce({
      schema_version: 1,
      items: [
        changed(2),
        {
          type: "department.changed",
          cursor: "dept",
          event_id: "dept",
          occurred_at: identity.observed_at,
          department: { ...department, revision: 2, active: false },
        },
      ],
      next_cursor: "opaque-tail",
    });
    const result = await f.sync.runOnce();
    expect(f.client.changes).toHaveBeenCalledWith("D");
    expect(result.identities).toEqual([identity]);
    expect(result.departments[0]).toMatchObject({ revision: 2, active: false });
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  it("requires another request after exactly 100 events and uses tail start time", async () => {
    const f = fixture();
    f.client.changes
      .mockImplementationOnce(async () => {
        f.advance(5_000);
        return {
          schema_version: 1,
          items: Array.from({ length: 100 }, (_, n) => changed(n + 10)),
          next_cursor: "full",
        };
      })
      .mockImplementationOnce(async () => {
        expect(f.publish).not.toHaveBeenCalled();
        f.advance(10_000);
        return { schema_version: 1, items: [], next_cursor: "full" };
      });
    const result = await f.sync.runOnce();
    expect(f.client.changes.mock.calls).toEqual([["D"], ["full"]]);
    expect(result.requestStartedAt.toISOString()).toBe(
      "2026-10-23T10:00:05.000Z",
    );
    expect(result.leaseUntil.toISOString()).toBe("2026-10-23T10:00:35.000Z");
  });

  it("does not publish an already expired response", async () => {
    const f = fixture();
    f.client.changes.mockImplementationOnce(async () => {
      f.advance(30_000);
      return { schema_version: 1, items: [], next_cursor: "D" };
    });
    await expect(f.sync.runOnce()).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("retries from the published cursor after publication failure without leaking staged changes", async () => {
    const f = fixture();
    await f.sync.runOnce();
    f.client.changes.mockResolvedValueOnce({
      schema_version: 1,
      items: [changed(9)],
      next_cursor: "failed",
    });
    f.publish.mockRejectedValueOnce(new Error("fenced writer"));
    await expect(f.sync.runOnce()).rejects.toThrow("fenced writer");
    const result = await f.sync.runOnce();
    expect(f.client.changes.mock.calls).toEqual([["D"], ["D"], ["D"]]);
    expect(result.identities).toEqual([identity]);
  });

  it("a failed first publication and a new instance both require full bootstrap", async () => {
    const f = fixture();
    f.publish.mockRejectedValueOnce(new Error("crash"));
    await expect(f.sync.runOnce()).rejects.toThrow("crash");
    await f.sync.runOnce();
    await new DirectorySynchronizer(f.client, f.publish).runOnce();
    expect(f.client.departments).toHaveBeenCalledTimes(3);
  });

  it("old and equal events never extend identity validity", async () => {
    const f = fixture();
    await f.sync.runOnce();
    const old = changed(3);
    const equal = changed(4);
    if (old.type === "identity.changed" && equal.type === "identity.changed") {
      old.identity.valid_until = "2026-10-23T13:00:00Z";
      equal.identity.valid_until = "2026-10-23T14:00:00Z";
    }
    f.client.changes.mockResolvedValueOnce({
      schema_version: 1,
      items: [old, equal],
      next_cursor: "later",
    });
    f.advance(15_000);
    expect((await f.sync.runOnce()).identities[0]).toEqual(identity);
  });

  it.each(["invalid_response", "unavailable", "resync_required"] as const)(
    "propagates %s without publishing and resyncs only on 410",
    async (code) => {
      const f = fixture();
      await f.sync.runOnce();
      const error = new DirectoryClientError(
        code,
        code === "resync_required" ? 410 : undefined,
      );
      f.client.changes.mockRejectedValueOnce(error);
      await expect(f.sync.runOnce()).rejects.toBe(error);
      expect(f.publish).toHaveBeenCalledTimes(1);
      await f.sync.runOnce();
      expect(f.client.departments).toHaveBeenCalledTimes(
        code === "resync_required" ? 2 : 1,
      );
    },
  );

  it.each(["cycle", "watermark", "conflict", "ttl", "bound"])(
    "rejects snapshot %s before publication",
    async (failure) => {
      const f = fixture();
      f.client.departments.mockImplementation(async () => {
        const call = f.client.departments.mock.calls.length;
        if (failure === "ttl") f.advance(15 * 60_000);
        return {
          schema_version: 1,
          items:
            failure === "bound"
              ? Array.from({ length: 100 }, (_, n) => ({
                  ...department,
                  id: `${call}-${n}`,
                }))
              : [
                  {
                    ...department,
                    name:
                      failure === "conflict" ? String(call) : department.name,
                  },
                ],
          next_cursor: failure === "cycle" ? "same" : `page-${call}`,
          changes_cursor: failure === "watermark" ? String(call) : "D",
        };
      });
      await expect(f.sync.runOnce()).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.client.employees).not.toHaveBeenCalled();
    },
  );

  it("rejects cyclic full changes pages", async () => {
    const f = fixture();
    f.client.changes.mockResolvedValue({
      schema_version: 1,
      items: Array.from({ length: 100 }, (_, n) => changed(n)),
      next_cursor: "same",
    });
    await expect(f.sync.runOnce()).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("does not publish a partially drained backlog after a later request fails", async () => {
    const f = fixture();
    await f.sync.runOnce();
    f.client.changes
      .mockResolvedValueOnce({
        schema_version: 1,
        items: Array.from({ length: 100 }, (_, n) => changed(n + 10)),
        next_cursor: "partial",
      })
      .mockRejectedValueOnce(new DirectoryClientError("invalid_response"));
    await expect(f.sync.runOnce()).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect((await f.sync.runOnce()).identities).toEqual([identity]);
    expect(f.client.changes.mock.calls.at(-1)).toEqual(["D"]);
  });

  it("bounds catch-up even when cursors continue making progress", async () => {
    const f = fixture();
    f.client.changes.mockImplementation(async () => {
      const call = f.client.changes.mock.calls.length;
      return {
        schema_version: 1,
        items: Array.from({ length: 100 }, (_, n) => changed(call * 100 + n)),
        next_cursor: `page-${call}`,
      };
    });
    await expect(f.sync.runOnce()).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(f.client.changes).toHaveBeenCalledTimes(1001);
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("invalidates on backwards clock and rejects concurrent runs", async () => {
    const f = fixture();
    await f.sync.runOnce();
    f.advance(-1);
    await expect(f.sync.runOnce()).rejects.toMatchObject({
      code: "invalid_response",
    });
    f.advance(1);
    const running = f.sync.runOnce();
    await expect(f.sync.runOnce()).rejects.toThrow("already running");
    await running;
    expect(f.client.departments).toHaveBeenCalledTimes(2);
  });

  it("invalidate during reads discards in-flight staging", async () => {
    const f = fixture();
    f.client.changes.mockImplementationOnce(async () => {
      f.sync.invalidate();
      return { schema_version: 1, items: [], next_cursor: "D" };
    });
    await expect(f.sync.runOnce()).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(f.publish).not.toHaveBeenCalled();
  });
});
