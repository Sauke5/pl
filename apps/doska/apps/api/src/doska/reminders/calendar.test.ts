import { describe, expect, it } from "vite-plus/test";
import { isRussianWorkingDay } from "./calendar";
import { getReminderSchedule } from "./timing";
import { moscowDate } from "../tasks/dates";

describe("Russian five-day production calendar", () => {
  it.each([
    ["2026-01-12", "2025-12-30"],
    ["2027-01-11", "2026-12-30"],
    ["2027-02-24", "2027-02-20"],
    ["2026-03-10", "2026-03-06"],
    ["2026-10-25", "2026-10-23"],
  ])("schedules %s on %s", (due, previous) => {
    expect(
      getReminderSchedule(moscowDate(due, "14:30"), true, isRussianWorkingDay)
        .before,
    ).toEqual(moscowDate(previous, "14:30"));
  });
  it.each(["2025-11-01", "2026-10-23", "2026-12-30", "2027-02-20"])(
    "%s is a working day",
    (date) => expect(isRussianWorkingDay(date)).toBe(true),
  );
  it.each([
    "2025-05-02",
    "2025-05-08",
    "2025-06-13",
    "2025-11-03",
    "2025-12-31",
    "2026-01-09",
    "2026-03-09",
    "2026-05-11",
    "2026-12-31",
    "2027-02-22",
    "2027-05-03",
    "2027-05-10",
    "2027-06-14",
    "2027-11-05",
    "2027-12-31",
    "2026-02-23",
    "2026-06-12",
    "2026-10-24",
    "2026-10-25",
  ])("%s is a day off", (date) =>
    expect(isRussianWorkingDay(date)).toBe(false),
  );
  it.each([
    [2025, 247],
    [2026, 247],
    [2027, 247],
  ])("%i has %i working days", (year, total) => {
    let count = 0;
    for (
      let day = new Date(Date.UTC(year, 0, 1));
      day.getUTCFullYear() === year;
      day.setUTCDate(day.getUTCDate() + 1)
    ) {
      if (isRussianWorkingDay(day.toISOString().slice(0, 10))) count++;
    }
    expect(count).toBe(total);
  });
  it.each(["2028-01-10", "2024-12-31", "2026-02-30", "2026-1-2"])(
    "rejects an unknown year or invalid date %s",
    (date) => expect(() => isRussianWorkingDay(date)).toThrow(RangeError),
  );
});
