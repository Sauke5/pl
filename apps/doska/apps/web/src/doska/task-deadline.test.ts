import { describe, expect, it } from "vite-plus/test";
import { taskDeadline } from "./task-deadline";
const now = Date.parse("2026-10-23T09:00:00Z");
describe("task deadline in Moscow", () => {
  it("keeps date-only deadlines current until Moscow midnight", () => {
    expect(taskDeadline("2026-10-23T20:59:00Z", false, false, now)?.state).toBe(
      "today",
    );
    expect(
      taskDeadline(
        "2026-10-23T20:59:00Z",
        false,
        false,
        Date.parse("2026-10-23T21:00:00Z"),
      )?.state,
    ).toBe("overdue");
  });
  it("uses the exact time when provided", () => {
    expect(
      taskDeadline("2026-10-23T08:30:00Z", true, false, now),
    ).toMatchObject({ state: "overdue", time: "11:30" });
    expect(taskDeadline("2026-10-23T10:30:00Z", true, false, now)?.state).toBe(
      "today",
    );
  });
  it("does not mark completed tasks overdue", () => {
    expect(taskDeadline("2026-10-22T08:30:00Z", true, true, now)?.state).toBe(
      "normal",
    );
  });
  it("uses Moscow day across the UTC date boundary", () => {
    expect(
      taskDeadline(
        "2026-10-24T00:00:00Z",
        true,
        false,
        Date.parse("2026-10-23T22:00:00Z"),
      )?.state,
    ).toBe("today");
  });
  it("handles missing and malformed dates", () => {
    expect(taskDeadline(null, false, false, now)).toBeNull();
    expect(taskDeadline("invalid", false, false, now)).toBeNull();
  });
});
