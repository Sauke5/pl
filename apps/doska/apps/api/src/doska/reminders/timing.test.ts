import { describe, expect, it, vi } from "vite-plus/test";
import { moscowDate } from "../tasks/dates";
import { getReminderSchedule } from "./timing";

function weekdays(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}
describe("Moscow reminder schedule", () => {
  it.each(["2026-10-24", "2026-10-25", "2026-10-26"])(
    "finds Friday for weekend or Monday deadline %s",
    (date) => {
      const result = getReminderSchedule(
        moscowDate(date, "23:59"),
        false,
        weekdays,
      );
      expect(result.before.toISOString()).toBe("2026-10-23T06:00:00.000Z");
      expect(result.overdue.getTime()).toBe(
        moscowDate(date).getTime() + 86_400_000,
      );
    },
  );
  it("uses the previous working day strictly, preserving Moscow HH:mm", () => {
    const seen: string[] = [];
    const due = new Date("2026-10-26T14:35:27.123+03:00");
    const result = getReminderSchedule(due, true, (date) => {
      seen.push(date);
      return weekdays(date);
    });
    expect(seen).toEqual(["2026-10-25", "2026-10-24", "2026-10-23"]);
    expect(result.before.toISOString()).toBe("2026-10-23T11:35:00.000Z");
    expect(result.overdue.toISOString()).toBe(due.toISOString());
    expect(result.overdue).not.toBe(due);
  });
  it("respects a working Saturday", () => {
    const result = getReminderSchedule(
      moscowDate("2026-10-26", "10:20"),
      true,
      (date) => date === "2026-10-24" || weekdays(date),
    );
    expect(result.before.toISOString()).toBe("2026-10-24T07:20:00.000Z");
  });
  it("crosses New Year and holiday runs using only the supplied calendar", () => {
    const result = getReminderSchedule(
      moscowDate("2027-01-11", "23:59"),
      false,
      (date) => date === "2026-12-30",
    );
    expect(result.before.toISOString()).toBe("2026-12-30T06:00:00.000Z");
    expect(result.overdue.toISOString()).toBe("2027-01-11T21:00:00.000Z");
  });
  it("handles a midnight deadline whose UTC date is the preceding day", () => {
    const result = getReminderSchedule(
      moscowDate("2026-10-27"),
      true,
      weekdays,
    );
    expect(result.before.toISOString()).toBe("2026-10-25T21:00:00.000Z");
    expect(result.overdue.toISOString()).toBe("2026-10-26T21:00:00.000Z");
  });
  it("starts date-only overdue at next Moscow midnight even when stored at midnight", () => {
    const result = getReminderSchedule(
      moscowDate("2026-12-31"),
      false,
      weekdays,
    );
    expect(result.before.toISOString()).toBe("2026-12-30T06:00:00.000Z");
    expect(result.overdue.toISOString()).toBe("2026-12-31T21:00:00.000Z");
  });
  it("propagates missing calendar data instead of silently assuming weekdays", () => {
    const error = new Error("Calendar unavailable");
    expect(() =>
      getReminderSchedule(moscowDate("2026-10-26"), false, () => {
        throw error;
      }),
    ).toThrow(error);
  });
  it("bounds a calendar with no working days", () => {
    const calendar = vi.fn(() => false);
    expect(() =>
      getReminderSchedule(moscowDate("2026-10-26"), false, calendar),
    ).toThrow("No working day");
    expect(calendar).toHaveBeenCalledTimes(366);
  });
  it("rejects an invalid deadline before consulting the calendar", () => {
    const calendar = vi.fn(() => true);
    expect(() =>
      getReminderSchedule(new Date(Number.NaN), false, calendar),
    ).toThrow(RangeError);
    expect(calendar).not.toHaveBeenCalled();
  });
});
