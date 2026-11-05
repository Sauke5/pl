import { describe, expect, it } from "vite-plus/test";
import {
  encodeLiveChanges,
  parseLiveEvent,
  MAX_LIVE_PAYLOAD_BYTES,
  liveScopes,
} from "./events";

describe("internal live events", () => {
  it("accepts only strict versioned routing data", () => {
    const event = {
      version: 1,
      kind: "project",
      projectId: "p",
      taskIds: ["t"],
      scopes: ["tasks"],
    };
    expect(parseLiveEvent(JSON.stringify(event))).toEqual(event);
    for (const invalid of [
      { ...event, title: "secret" },
      { ...event, version: 2 },
      { ...event, scopes: ["arbitrary"] },
      { ...event, projectId: "bad\n" },
      { ...event, taskIds: Array(33).fill("t") },
    ]) {
      expect(parseLiveEvent(JSON.stringify(invalid))).toBeUndefined();
    }
    expect(parseLiveEvent("broken")).toBeUndefined();
    expect(
      parseLiveEvent(" ".repeat(4096) + JSON.stringify(event)),
    ).toBeUndefined();
  });

  it("merges project scope, deduplicates IDs and aggregates large changes", () => {
    const events = encodeLiveChanges([
      {
        kind: "project",
        projectId: "p",
        taskIds: ["t", "t"],
        scopes: ["tasks"],
      },
      { kind: "project", projectId: "p", taskIds: ["u"], scopes: ["history"] },
      {
        kind: "project",
        projectId: "other",
        taskIds: Array.from({ length: 33 }, (_, i) => `t${i}`),
        scopes: ["tasks"],
      },
    ]).map(parseLiveEvent);
    expect(events[0]).toMatchObject({
      projectId: "p",
      taskIds: ["t", "u"],
      scopes: ["tasks", "history"],
    });
    expect(events[1]).toMatchObject({ projectId: "other", taskIds: [] });
    const [large] = encodeLiveChanges([
      {
        kind: "project",
        projectId: "p".repeat(128),
        taskIds: Array.from({ length: 32 }, (_, i) => `${i}`.padEnd(128, "a")),
        scopes: [...liveScopes],
      },
    ]);
    expect(Buffer.byteLength(large!)).toBeLessThanOrEqual(
      MAX_LIVE_PAYLOAD_BYTES,
    );
    expect(parseLiveEvent(large!)).toMatchObject({ taskIds: [] });
  });

  it("splits personal audiences without widening or losing any recipient", () => {
    const users = Array.from({ length: 140 }, (_, i) =>
      `${i}`.padEnd(128, "u"),
    );
    const payloads = encodeLiveChanges([
      { kind: "personal", userIds: users, scopes: ["notifications"] },
    ]);
    const delivered = payloads.flatMap((payload) => {
      expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(4096);
      const parsed = parseLiveEvent(payload);
      expect(parsed?.kind).toBe("personal");
      return parsed?.kind === "personal" ? parsed.userIds : [];
    });
    expect(delivered).toEqual(users);
    expect(encodeLiveChanges([])).toEqual([]);
    expect(
      encodeLiveChanges([
        { kind: "personal", userIds: [], scopes: ["notifications"] },
      ]),
    ).toEqual([]);
  });
});
