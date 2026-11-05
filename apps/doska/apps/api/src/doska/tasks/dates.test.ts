import { describe, expect, it } from "vite-plus/test";
import { isCalendarDate, moscowDate } from "./dates";

describe("task Moscow dates", () => {
  it.each(["2024-02-29", "2026-12-31", "2027-01-01"])(
    "accepts calendar date %s",
    (date) => expect(isCalendarDate(date)).toBe(true),
  );
  it.each([
    "2026-02-29",
    "2026-04-31",
    "2026-13-01",
    "2026-00-10",
    "2026-01-00",
    "2026-1-01",
    "0000-01-01",
    "2026-01-01T12:00Z",
  ])("rejects %s", (date) => expect(isCalendarDate(date)).toBe(false));
  it("converts midnight across the UTC year boundary", () =>
    expect(moscowDate("2027-01-01").toISOString()).toBe(
      "2026-12-31T21:00:00.000Z",
    ));
  it("converts the end of a date-only deadline", () =>
    expect(moscowDate("2026-10-23", "23:59").toISOString()).toBe(
      "2026-10-23T20:59:00.000Z",
    ));
  it.each(["24:00", "12:60", "9:00", "12:00:00"])("rejects time %s", (time) =>
    expect(() => moscowDate("2026-10-23", time)).toThrow(RangeError),
  );
});
