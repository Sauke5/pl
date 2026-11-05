const moscowDate = (date: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

export function taskDeadline(
  value: string | null,
  hasTime: boolean,
  completed: boolean,
  now = Date.now(),
) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const today = moscowDate(date) === moscowDate(new Date(now));
  const overdue =
    !completed &&
    (hasTime
      ? date.getTime() < now
      : moscowDate(date) < moscowDate(new Date(now)));
  return {
    state: overdue ? "overdue" : today && !completed ? "today" : "normal",
    date: date.toLocaleDateString("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "numeric",
      month: "short",
    }),
    time: hasTime
      ? date.toLocaleTimeString("ru-RU", {
          timeZone: "Europe/Moscow",
          hour: "2-digit",
          minute: "2-digit",
        })
      : null,
    full: date.toLocaleString("ru-RU", {
      timeZone: "Europe/Moscow",
      year: "numeric",
      month: "long",
      day: "numeric",
      ...(hasTime ? ({ hour: "2-digit", minute: "2-digit" } as const) : {}),
    }),
  };
}
