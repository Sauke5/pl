import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, CornerDownRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Column, Task } from "./api";
import { taskDeadline } from "./task-deadline";
import "./task-table.css";

type SortKey =
  | "number"
  | "title"
  | "status"
  | "priority"
  | "assignee"
  | "start"
  | "due";
const priorities: Record<string, number> = {
  "no-priority": 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
};
const timestamp = (value: string | null) => {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};
export function DoskaTaskTable({
  tasks,
  columns,
  roster,
  onOpen,
  now,
  selection,
}: {
  tasks: Task[];
  columns: Column[];
  roster: { userId: string; name: string | null }[];
  onOpen: (taskId: string) => void;
  now: number;
  selection?: {
    selectedIds: ReadonlySet<string>;
    onChange: (tasks: Task[]) => void;
  };
}) {
  const { t } = useTranslation("doska");
  const [sort, setSort] = useState<{
    key: SortKey;
    descending: boolean;
  } | null>(null);
  const columnMap = useMemo(
    () => new Map(columns.map((column) => [column.id, column])),
    [columns],
  );
  const people = useMemo(
    () => new Map(roster.map((person) => [person.userId, person.name])),
    [roster],
  );
  const taskMap = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );
  const sorted = useMemo(() => {
    if (!sort) return tasks;
    const value = (task: Task): string | number | null => {
      switch (sort.key) {
        case "number":
          return task.number;
        case "title":
          return task.title;
        case "status":
          return columnMap.get(task.columnId ?? "")?.name ?? null;
        case "priority":
          return priorities[task.priority] ?? 0;
        case "assignee":
          return people.get(task.userId ?? "") ?? null;
        case "start":
          return timestamp(task.startDate);
        case "due":
          return timestamp(task.dueDate);
      }
    };
    return [...tasks].sort((a, b) => {
      const left = value(a),
        right = value(b);
      if (left === null || right === null)
        return left === right ? 0 : left === null ? 1 : -1;
      const order =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left).localeCompare(String(right), "ru", { numeric: true });
      return sort.descending ? -order : order;
    });
  }, [tasks, sort, columnMap, people]);
  const headings: { key: SortKey; label: string }[] = [
    { key: "number", label: "taskNumber" },
    { key: "title", label: "task" },
    { key: "status", label: "status" },
    { key: "priority", label: "priority" },
    { key: "assignee", label: "responsible" },
    { key: "start", label: "startDate" },
    { key: "due", label: "dueDate" },
  ];
  if (!tasks.length)
    return <div className="doska-panel">{t("tableTasksEmpty")}</div>;
  return (
    <div className="doska-panel doska-table-wrap doska-task-table-wrap">
      <table className="doska-task-table">
        <thead>
          <tr>
            {selection && (
              <th scope="col" className="doska-task-select">
                <input
                  type="checkbox"
                  aria-label={t("bulkSelectTasks")}
                  checked={sorted
                    .slice(0, 100)
                    .every((task) => selection.selectedIds.has(task.id))}
                  ref={(element) => {
                    if (element)
                      element.indeterminate =
                        selection.selectedIds.size > 0 &&
                        !sorted
                          .slice(0, 100)
                          .every((task) => selection.selectedIds.has(task.id));
                  }}
                  onChange={(event) =>
                    selection.onChange(
                      event.target.checked ? sorted.slice(0, 100) : [],
                    )
                  }
                />
              </th>
            )}
            {headings.map(({ key, label }) => (
              <th
                key={key}
                scope="col"
                aria-sort={
                  sort?.key === key
                    ? sort.descending
                      ? "descending"
                      : "ascending"
                    : "none"
                }
              >
                <button
                  onClick={() =>
                    setSort({
                      key,
                      descending: sort?.key === key ? !sort.descending : false,
                    })
                  }
                >
                  {t(label)}
                  {sort?.key === key &&
                    (sort.descending ? (
                      <ArrowDown size={13} aria-hidden="true" />
                    ) : (
                      <ArrowUp size={13} aria-hidden="true" />
                    ))}
                </button>
              </th>
            ))}
            <th scope="col">{t("checklistsTitle")}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((task) => {
            const column = columnMap.get(task.columnId ?? "");
            const deadline = taskDeadline(
              task.dueDate,
              task.dueDateHasTime,
              column?.semanticState === "completed",
              now,
            );
            const start = taskDeadline(task.startDate, false, true, now);
            const parent = task.parentTaskId
              ? taskMap.get(task.parentTaskId)
              : null;
            const progress = task.checklistProgress;
            return (
              <tr
                key={task.id}
                className={
                  selection?.selectedIds.has(task.id)
                    ? "is-selected"
                    : undefined
                }
              >
                {selection && (
                  <td className="doska-task-select">
                    <input
                      type="checkbox"
                      aria-label={t("bulkSelectTask", { title: task.title })}
                      checked={selection.selectedIds.has(task.id)}
                      disabled={
                        !selection.selectedIds.has(task.id) &&
                        selection.selectedIds.size >= 100
                      }
                      onChange={(event) =>
                        selection.onChange(
                          event.target.checked
                            ? [
                                ...tasks.filter((row) =>
                                  selection.selectedIds.has(row.id),
                                ),
                                task,
                              ]
                            : tasks.filter(
                                (row) =>
                                  selection.selectedIds.has(row.id) &&
                                  row.id !== task.id,
                              ),
                        )
                      }
                    />
                  </td>
                )}
                <td className="doska-task-table-number">
                  {task.number == null ? "—" : `#${task.number}`}
                </td>
                <td className="doska-task-table-title">
                  <button onClick={() => onOpen(task.id)}>{task.title}</button>
                  {task.parentTaskId && (
                    <span className="doska-task-table-parent">
                      <CornerDownRight size={13} aria-hidden="true" />
                      {parent
                        ? t("subtaskOf", { task: parent.title })
                        : t("subtask")}
                    </span>
                  )}
                </td>
                <td>
                  <span
                    className={`doska-task-table-status state-${column?.semanticState ?? "planned"}`}
                  >
                    <span aria-hidden="true" />
                    {column?.name ?? t("unknownStatus")}
                  </span>
                </td>
                <td>
                  <span className={`doska-priority priority-${task.priority}`}>
                    {t(`priority_${task.priority}`)}
                  </span>
                </td>
                <td>
                  {people.get(task.userId ?? "") ??
                    t(task.userId ? "unavailableMember" : "unassigned")}
                </td>
                <td>
                  {start ? (
                    <time dateTime={task.startDate!} title={start.full}>
                      {start.date}
                    </time>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  {deadline ? (
                    <time
                      dateTime={task.dueDate!}
                      className={`doska-deadline is-${deadline.state}`}
                      title={`${deadline.full} · ${t("moscowTime")}`}
                    >
                      {deadline.state === "overdue"
                        ? `${t("deadlineOverdue")} · ${deadline.date}`
                        : deadline.state === "today"
                          ? t("deadlineToday")
                          : deadline.date}
                      {deadline.time && `, ${deadline.time}`}
                    </time>
                  ) : (
                    t("noDueDate")
                  )}
                </td>
                <td>
                  {progress?.total ? (
                    <span className="doska-task-table-progress">
                      <progress
                        value={progress.done}
                        max={progress.total}
                        aria-label={t("boardChecklistProgress", {
                          done: progress.done,
                          total: progress.total,
                        })}
                      />
                      <span>
                        {progress.done}/{progress.total}
                      </span>
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
