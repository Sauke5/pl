/** Dates in the task API use Moscow civil time, currently UTC+03:00. */
export function isCalendarDate(value: string): boolean {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
  );
}
export function moscowDate(date: string, time = "00:00"): Date {
  if (!isCalendarDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new RangeError("Invalid task date");
  }
  return new Date(`${date}T${time}:00+03:00`);
}
