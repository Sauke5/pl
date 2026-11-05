import { describe, expect, it } from "vite-plus/test";
import { pendingReminder } from "./pending";

describe("reminder catch-up", () => {
  const schedule = {
    before: new Date("2026-10-23T06:00:00Z"),
    overdue: new Date("2026-10-26T21:00:00Z"),
  };
  it("waits for the scheduled minute", () => {
    expect(
      pendingReminder(schedule, new Date("2026-10-23T05:59:59Z")),
    ).toBeNull();
    expect(pendingReminder(schedule, schedule.before)).toBe("before");
  });
  it("catches up a reminder while the task is not overdue", () => {
    expect(pendingReminder(schedule, new Date("2026-10-26T12:00:00Z"))).toBe(
      "before",
    );
  });
  it("only emits overdue when both scheduled times have passed", () => {
    expect(pendingReminder(schedule, schedule.overdue)).toBe("overdue");
    expect(pendingReminder(schedule, new Date("2026-10-29T12:00:00Z"))).toBe(
      "overdue",
    );
  });
});
