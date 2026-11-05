import { useTranslation } from "react-i18next";
import type { MyTask } from "./api";
import { doskaHref } from "./shell";
import { taskDeadline } from "./task-deadline";
export function TaskSearchResults({
  tasks,
  onOpen,
}: {
  tasks: MyTask[];
  onOpen: (task: MyTask) => void;
}) {
  const { t } = useTranslation("doska");
  return (
    <div className="doska-panel doska-table-wrap doska-search-results">
      <table>
        <thead>
          <tr>
            <th>{t("task")}</th>
            <th>{t("project")}</th>
            <th>{t("status")}</th>
            <th>{t("dueDate")}</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const deadline = taskDeadline(
              task.dueDate,
              task.dueDateHasTime,
              task.columnState === "completed",
            );
            return (
              <tr key={task.id}>
                <td>
                  <a
                    href={doskaHref(
                      `/projects/${encodeURIComponent(task.projectId)}?taskId=${encodeURIComponent(task.id)}`,
                    )}
                    onClick={(event) => {
                      if (
                        event.button !== 0 ||
                        event.ctrlKey ||
                        event.metaKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      event.preventDefault();
                      onOpen(task);
                    }}
                  >
                    <span className="doska-search-task-number">
                      {task.number == null ? "" : `#${task.number}`}
                    </span>{" "}
                    {task.title}
                  </a>
                </td>
                <td>{task.projectName}</td>
                <td>
                  {task.columnName ?? t("unknownStatus")}
                  {task.archivedAt && (
                    <span className="doska-search-archive">
                      {" "}
                      · {t("archived")}
                    </span>
                  )}
                </td>
                <td>
                  {deadline ? (
                    <span
                      className={`doska-deadline is-${deadline.state}`}
                      title={`${deadline.full} · ${t("moscowTime")}`}
                    >
                      {deadline.state === "overdue"
                        ? `${t("deadlineOverdue")} · ${deadline.date}`
                        : deadline.state === "today"
                          ? t("deadlineToday")
                          : deadline.date}
                      {deadline.time && `, ${deadline.time}`}
                    </span>
                  ) : (
                    t("noDueDate")
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
