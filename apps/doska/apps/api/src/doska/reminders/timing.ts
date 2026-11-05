import { isCalendarDate, moscowDate } from "../tasks/dates";

const dayMilliseconds = 24 * 60 * 60 * 1000;
const moscowOffset = 3 * 60 * 60 * 1000;
const maximumLookbackDays = 366;

/** Calendar strings are Moscow civil dates, independent of the process timezone. */
export function getReminderSchedule(
  dueDate: Date,
  dueDateHasTime: boolean,
  isWorkingDay: (date: string) => boolean,
): { before: Date; overdue: Date } {
  const instant = dueDate.getTime();
  if (!Number.isFinite(instant))
    throw new RangeError("Invalid reminder deadline");
  const civilDate = new Date(instant + moscowOffset);
  if (!Number.isFinite(civilDate.getTime()))
    throw new RangeError("Invalid reminder deadline");
  const civilISO = civilDate.toISOString();
  const date = civilISO.slice(0, 10);
  if (!isCalendarDate(date)) throw new RangeError("Invalid reminder deadline");
  const time = dueDateHasTime ? civilISO.slice(11, 16) : "09:00";
  const midnight = moscowDate(date);
  for (let days = 1; days <= maximumLookbackDays; days++) {
    const previousDate = new Date(
      midnight.getTime() + moscowOffset - days * dayMilliseconds,
    )
      .toISOString()
      .slice(0, 10);
    if (!isCalendarDate(previousDate))
      throw new RangeError("Reminder calendar date is outside supported range");
    if (isWorkingDay(previousDate)) {
      return {
        before: moscowDate(previousDate, time),
        overdue: dueDateHasTime
          ? new Date(instant)
          : new Date(midnight.getTime() + dayMilliseconds),
      };
    }
  }
  throw new RangeError("No working day within reminder calendar lookback");
}
