import { describe, expect, it } from "vite-plus/test";
import { parseLiveEvent } from "./live-events";
const parse = (type: string, body: unknown) =>
  parseLiveEvent(type, JSON.stringify(body));
describe("live frame validation", () => {
  it("accepts the four versioned envelopes", () => {
    expect(parse("ready", { version: 1 })).toEqual({
      type: "ready",
      version: 1,
    });
    expect(parse("reset", { version: 1, reason: "resync" })?.type).toBe(
      "reset",
    );
    expect(
      parse("personal", { version: 1, scopes: ["notifications"] })?.type,
    ).toBe("personal");
    expect(
      parse("changed", {
        version: 1,
        projectId: "p-1",
        taskIds: ["t_1"],
        scopes: ["tasks", "history"],
      })?.type,
    ).toBe("changed");
  });
  it("rejects unversioned, unknown or content-bearing payloads", () => {
    for (const body of [
      null,
      [],
      { version: 2 },
      { version: 1, title: "secret" },
    ])
      expect(parse("ready", body)).toBeNull();
    expect(parseLiveEvent("ready", "{")).toBeNull();
    expect(parse("other", { version: 1 })).toBeNull();
    expect(parse("personal", { version: 1, scopes: ["tasks"] })).toBeNull();
    expect(parse("reset", { version: 1, reason: "logout" })).toBeNull();
  });
  it("enforces bounded unique IDs and closed unique scopes", () => {
    const body = { version: 1, projectId: "p", scopes: ["tasks"] };
    for (const taskIds of [
      ["../secret"],
      ["t", "t"],
      [null],
      Array.from({ length: 33 }, (_, n) => `t${n}`),
    ])
      expect(parse("changed", { ...body, taskIds })).toBeNull();
    for (const scopes of [
      [],
      ["tasks", "tasks"],
      ["unknown"],
      ["notifications"],
    ])
      expect(parse("changed", { ...body, scopes })).toBeNull();
    expect(
      parse("changed", { ...body, projectId: "p".repeat(129) }),
    ).toBeNull();
    expect(parseLiveEvent("ready", " ".repeat(4097))).toBeNull();
  });
});
