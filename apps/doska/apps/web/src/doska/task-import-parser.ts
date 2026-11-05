import type { CreateTaskInput } from "./api";
export const importFileLimit = 3 * 1024 * 1024;
export const importTaskLimit = 500;
export type ImportSourceTask = {
  title: string;
  description?: string | null;
  status: string;
  priority: "no-priority" | "low" | "medium" | "high" | "urgent";
  startDate?: string;
  dueDate?: string;
  userId?: string;
};
export class ImportFileError extends Error {
  constructor(
    public code: string,
    public row?: number,
    public field?: string,
  ) {
    super(code);
    this.name = "ImportFileError";
  }
}
const keys = new Set([
  "title",
  "description",
  "status",
  "priority",
  "startDate",
  "dueDate",
  "userId",
]);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function dateOnly(value: unknown, row: number, field: string) {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string")
    throw new ImportFileError("invalid_date", row, field);
  const date = value.slice(0, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    throw new ImportFileError("invalid_date", row, field);
  if (
    value !== date &&
    (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    ) ||
      !Number.isFinite(Date.parse(value)))
  )
    throw new ImportFileError("invalid_date", row, field);
  // Import is explicitly date-only: preserve the calendar date written in the file.
  return date;
}
export function parseTaskImport(text: string) {
  if (new TextEncoder().encode(text).byteLength > importFileLimit)
    throw new ImportFileError("file_too_large");
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new ImportFileError("invalid_json");
  }
  if (
    !record(raw) ||
    !Array.isArray(raw.tasks) ||
    Object.keys(raw).some((key) => key !== "tasks")
  )
    throw new ImportFileError("invalid_root");
  if (!raw.tasks.length || raw.tasks.length > importTaskLimit)
    throw new ImportFileError("task_count");
  const issues: { row: number; field: string; code: string; value: string }[] =
    [];
  function issue(row: number, field: string, code: string, value: unknown) {
    issues.push({ row, field, code, value: JSON.stringify(value) ?? "" });
  }
  const asText = (value: unknown): string =>
    value === undefined || value === null
      ? ""
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  const tasks = raw.tasks.map((item: unknown, index): ImportSourceTask => {
    const row = index + 1;
    if (!record(item)) {
      issue(row, "task", "invalid_task", item);
      return {
        title: "",
        description: asText(item),
        status: "",
        priority: "no-priority",
      };
    }
    for (const key of Object.keys(item))
      if (!keys.has(key)) issue(row, key, "unknown_field", item[key]);
    const title = asText(item.title);
    if (typeof item.title !== "string" || !title.trim() || title.length > 500)
      issue(row, "title", "invalid_title", item.title);
    const description =
      item.description == null ? item.description : asText(item.description);
    if (
      item.description != null &&
      (typeof item.description !== "string" || description!.length > 100000)
    )
      issue(row, "description", "invalid_description", item.description);
    const status = asText(item.status ?? "to-do");
    if (
      !status.trim() ||
      typeof (item.status ?? "to-do") !== "string" ||
      status.length > 128
    )
      issue(row, "status", "invalid_status", item.status);
    const priority = asText(item.priority ?? "no-priority");
    if (!["no-priority", "low", "medium", "high", "urgent"].includes(priority))
      issue(row, "priority", "invalid_priority", item.priority);
    const userId = asText(item.userId);
    if (
      item.userId != null &&
      (typeof item.userId !== "string" || userId.length > 256)
    )
      issue(row, "userId", "invalid_assignee", item.userId);
    const sourceItem = item;
    function importedDate(field: string) {
      try {
        return dateOnly(sourceItem[field], row, field);
      } catch {
        issue(row, field, "invalid_date", sourceItem[field]);
        return asText(sourceItem[field]);
      }
    }
    const startDate = importedDate("startDate"),
      dueDate = importedDate("dueDate");
    if (startDate && dueDate && startDate > dueDate)
      issue(row, "dueDate", "date_order", item.dueDate);
    return {
      title,
      description,
      status,
      priority: priority as ImportSourceTask["priority"],
      ...(startDate ? { startDate } : {}),
      ...(dueDate ? { dueDate } : {}),
      ...(userId ? { userId } : {}),
    };
  });
  return {
    tasks,
    issues,
    statuses: [...new Set(tasks.map((task) => task.status))],
    assignees: [
      ...new Set(tasks.flatMap((task) => (task.userId ? [task.userId] : []))),
    ],
  };
}
export function buildTaskImport(
  tasks: ImportSourceTask[],
  columns: Record<string, string>,
  users: Record<string, string | null>,
): CreateTaskInput[] {
  return tasks.map((task) => {
    const columnId = Object.hasOwn(columns, task.status)
      ? columns[task.status]
      : "";
    const userId = task.userId
      ? Object.hasOwn(users, task.userId)
        ? users[task.userId]
        : task.userId
      : null;
    return {
      title: task.title,
      description: task.description,
      columnId,
      priority: task.priority,
      userId: userId ?? null,
      ...(task.startDate ? { startDate: task.startDate } : {}),
      ...(task.dueDate ? { due: { date: task.dueDate } } : {}),
    };
  });
}
