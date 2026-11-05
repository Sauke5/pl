export type CalendarMonth = { year: number; month: number };
const moscowDayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function calendarDay(value: string | number): string | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? moscowDayFormat.format(date) : null;
}
export function calendarMonth(now: number): CalendarMonth {
  const day = calendarDay(now)!;
  return { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) - 1 };
}
export function shiftCalendarMonth(
  value: CalendarMonth,
  offset: number,
): CalendarMonth {
  const date = new Date(Date.UTC(value.year, value.month + offset, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
}
export function calendarDays(value: CalendarMonth) {
  const first = new Date(Date.UTC(value.year, value.month, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(value.year, value.month + 1, 0)).getUTCDate();
  return Array.from(
    { length: Math.ceil((offset + count) / 7) * 7 },
    (_, index) => {
      const date = new Date(
        Date.UTC(value.year, value.month, 1 - offset + index),
      );
      return {
        key: date.toISOString().slice(0, 10),
        date,
        inMonth: date.getUTCMonth() === value.month,
      };
    },
  );
}
export function groupCalendarTasks<
  T extends { dueDate: string | null; id: string },
>(tasks: T[]) {
  const byDay = new Map<string, T[]>();
  const undated: T[] = [];
  for (const task of tasks) {
    const day = task.dueDate ? calendarDay(task.dueDate) : null;
    if (!day) undated.push(task);
    else {
      const group = byDay.get(day);
      if (group) group.push(task);
      else byDay.set(day, [task]);
    }
  }
  for (const group of byDay.values())
    group.sort(
      (a, b) =>
        Date.parse(a.dueDate!) - Date.parse(b.dueDate!) ||
        a.id.localeCompare(b.id),
    );
  return { byDay, undated };
}
