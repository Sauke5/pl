import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CornerDownRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task, Column } from "./api";
import {
  calendarDay,
  calendarDays,
  calendarMonth,
  groupCalendarTasks,
  shiftCalendarMonth,
} from "./task-calendar-dates";
import { taskDeadline } from "./task-deadline";
import "./task-calendar.css";

export function DoskaTaskCalendar({
  tasks,
  columns,
  onOpen,
  now,
}: {
  tasks: Task[];
  columns: Column[];
  onOpen: (id: string) => void;
  now: number;
}) {
  const { t, i18n } = useTranslation("doska");
  const [month, setMonth] = useState(() => calendarMonth(now));
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "ru-RU";
  const days = calendarDays(month);
  const { byDay, undated } = useMemo(() => groupCalendarTasks(tasks), [tasks]);
  const today = calendarDay(now);
  const columnMap = new Map(columns.map((column) => [column.id, column]));
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const monthLabel = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(month.year, month.month, 1)));
  const dayLabel = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const weekdayLabel = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    timeZone: "UTC",
  });
  const renderTask = (task: Task) => {
    const column = task.columnId ? columnMap.get(task.columnId) : undefined;
    const completed = column?.semanticState === "completed";
    const deadline = taskDeadline(
      task.dueDate,
      task.dueDateHasTime,
      completed,
      now,
    );
    return (
      <button
        type="button"
        key={task.id}
        className={`doska-calendar-task is-${deadline?.state ?? "normal"}${completed ? " is-completed" : ""}`}
        onClick={() => onOpen(task.id)}
        title={[task.title, column?.name, deadline?.full]
          .filter(Boolean)
          .join(" · ")}
      >
        <span className="doska-calendar-task-title">{task.title}</span>
        <span className="doska-calendar-task-meta">
          {task.parentTaskId && (
            <span title={taskMap.get(task.parentTaskId)?.title}>
              <CornerDownRight size={12} aria-hidden="true" /> {t("subtask")}
            </span>
          )}
          {deadline?.time && (
            <time dateTime={task.dueDate!}>{deadline.time}</time>
          )}
          {column && <span>{column.name}</span>}
          {deadline?.state === "overdue" && <span>{t("deadlineOverdue")}</span>}
        </span>
      </button>
    );
  };
  return (
    <section className="doska-calendar" aria-label={t("calendarTitle")}>
      <header className="doska-calendar-toolbar">
        <h2 aria-live="polite">{monthLabel}</h2>
        <div>
          <button
            type="button"
            aria-label={t("calendarPreviousMonth")}
            onClick={() => setMonth((value) => shiftCalendarMonth(value, -1))}
          >
            <ChevronLeft size={18} />
          </button>
          <button type="button" onClick={() => setMonth(calendarMonth(now))}>
            {t("calendarToday")}
          </button>
          <button
            type="button"
            aria-label={t("calendarNextMonth")}
            onClick={() => setMonth((value) => shiftCalendarMonth(value, 1))}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </header>
      <div className="doska-calendar-scroll">
        <table className="doska-calendar-grid" aria-label={monthLabel}>
          <thead>
            <tr>
              {days.slice(0, 7).map((day) => (
                <th scope="col" key={day.key}>
                  {weekdayLabel.format(day.date)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: days.length / 7 }, (_, week) => (
              <tr key={days[week * 7]!.key}>
                {days.slice(week * 7, week * 7 + 7).map((day) => (
                  <td
                    key={day.key}
                    className={day.inMonth ? undefined : "is-outside-month"}
                    aria-label={dayLabel.format(day.date)}
                  >
                    <time
                      dateTime={day.key}
                      className={`doska-calendar-day${day.key === today ? " is-today" : ""}`}
                      aria-current={day.key === today ? "date" : undefined}
                    >
                      {day.date.getUTCDate()}
                    </time>
                    <div className="doska-calendar-day-tasks">
                      {(byDay.get(day.key) ?? []).map(renderTask)}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section
        className="doska-calendar-undated"
        aria-label={t("calendarNoDueDate")}
      >
        <h3>
          {t("calendarNoDueDate")} <span>{undated.length}</span>
        </h3>
        {undated.length ? (
          <div>{undated.map(renderTask)}</div>
        ) : (
          <p className="doska-meta">{t("calendarNoUndatedTasks")}</p>
        )}
      </section>
    </section>
  );
}
