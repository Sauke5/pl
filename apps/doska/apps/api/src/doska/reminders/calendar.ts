import { isCalendarDate } from "../tasks/dates";

// Five-day Russian production calendar. Keep explicit transfers per year:
// 2025: Government decree 04.10.2024 No.1335
// https://publication.pravo.gov.ru/document/0001202410040023
// 2026: Government decree 24.09.2025 No.1466
// https://publication.pravo.gov.ru/document/0001202509240023
// 2027: Government decree 17.09.2026 No.1187
// https://publication.pravo.gov.ru/document/0001202609180037
// Lists include substitute Mondays under article 112 of the Labour Code.
const calendars: Record<number, { off: string[]; working: string[] }> = {
  2025: {
    off: ["05-02", "05-08", "06-13", "11-03", "12-31"],
    working: ["11-01"],
  },
  2026: { off: ["01-09", "03-09", "05-11", "12-31"], working: [] },
  2027: {
    off: ["02-22", "05-03", "05-10", "06-14", "11-05", "12-31"],
    working: ["02-20"],
  },
};

const holidays = new Set([
  "01-01",
  "01-02",
  "01-03",
  "01-04",
  "01-05",
  "01-06",
  "01-07",
  "01-08",
  "02-23",
  "03-08",
  "05-01",
  "05-09",
  "06-12",
  "11-04",
]);

export function isRussianWorkingDay(date: string): boolean {
  if (!isCalendarDate(date)) throw new RangeError("Invalid calendar date");
  const calendar = calendars[Number(date.slice(0, 4))];
  if (!calendar)
    throw new RangeError(
      `Production calendar unavailable: ${date.slice(0, 4)}`,
    );
  const monthDay = date.slice(5);
  if (calendar.working.includes(monthDay)) return true;
  if (holidays.has(monthDay) || calendar.off.includes(monthDay)) return false;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}
