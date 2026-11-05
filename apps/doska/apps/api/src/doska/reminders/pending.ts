/** Only the currently relevant event is caught up after downtime or a late edit. */
export function pendingReminder(
  schedule: { before: Date; overdue: Date },
  now: Date,
): "before" | "overdue" | null {
  if (now >= schedule.overdue) return "overdue";
  if (now >= schedule.before) return "before";
  return null;
}
