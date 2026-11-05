import { describe, expect, it } from "vite-plus/test";
import {
  calendarDay,
  calendarDays,
  calendarMonth,
  groupCalendarTasks,
  shiftCalendarMonth,
} from "./task-calendar-dates";
describe("calendar dates", () => {
  it("anchors the month to Moscow even across UTC year boundary", () => {
    expect(calendarMonth(Date.parse("2026-12-31T22:00:00Z"))).toEqual({
      year: 2027,
      month: 0,
    });
    expect(calendarDay("2026-12-31T22:00:00Z")).toBe("2027-01-01");
  });
  it("shifts December and January without clamping overflow dates", () => {
    expect(shiftCalendarMonth({ year: 2026, month: 11 }, 1)).toEqual({
      year: 2027,
      month: 0,
    });
    expect(shiftCalendarMonth({ year: 2027, month: 0 }, -1)).toEqual({
      year: 2026,
      month: 11,
    });
  });
  it("includes leap day, Monday-first complete weeks and adjacent month dates", () => {
    const days = calendarDays({ year: 2024, month: 1 });
    expect(days[0]!.key).toBe("2024-01-29");
    expect(days.at(-1)!.key).toBe("2024-03-03");
    expect(days.filter((day) => day.inMonth)).toHaveLength(29);
    expect(days.find((day) => day.key === "2024-02-29")?.inMonth).toBe(true);
    expect(
      days.every((day, index) => index % 7 !== 0 || day.date.getUTCDay() === 1),
    ).toBe(true);
  });
  it("handles four and six week months without losing dates", () => {
    expect(calendarDays({ year: 2021, month: 1 })).toHaveLength(28);
    expect(calendarDays({ year: 2026, month: 2 })).toHaveLength(42);
  });
  it("groups only by Moscow due day and preserves undated tasks", () => {
    const tasks = [
      { id: "later", dueDate: "2026-10-24T12:00:00Z" },
      { id: "early", dueDate: "2026-10-23T22:00:00Z" },
      { id: "none", dueDate: null },
      { id: "bad", dueDate: "invalid" },
    ];
    const grouped = groupCalendarTasks(tasks);
    expect(grouped.byDay.get("2026-10-24")?.map((task) => task.id)).toEqual([
      "early",
      "later",
    ]);
    expect(grouped.undated.map((task) => task.id)).toEqual(["none", "bad"]);
    expect(tasks[0]!.id).toBe("later");
  });
});
