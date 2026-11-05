import { useLayoutEffect, useRef, useState } from "react";
import { CornerDownRight } from "lucide-react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { doskaHref } from "./shell";
import { readMyTasksContext } from "./task-navigation";
const pageSize = 40;
export function DoskaMyTasks() {
  const { t } = useTranslation("doska");
  const navigate = useNavigate();
  const locationState = useRouterState({
    select: (state) => state.location.state,
  });
  const initialContext = useRef(readMyTasksContext(locationState));
  const [page, setPage] = useState(initialContext.current?.page ?? 0);
  const [archived, setArchived] = useState(
    initialContext.current?.archived ?? false,
  );
  const tasks = useQuery({
    queryKey: ["doska", "my-tasks", page, archived],
    queryFn: () =>
      api.listMyTasks({ limit: pageSize, offset: page * pageSize, archived }),
  });
  useLayoutEffect(() => {
    if (!tasks.isSuccess || !initialContext.current) return;
    window.scrollTo({
      top: initialContext.current.scrollY,
      behavior: "instant",
    });
    initialContext.current = null;
  }, [tasks.isSuccess]);
  return (
    <>
      <div className="doska-page-heading">
        <div>
          <h1>{t("myTasks")}</h1>
        </div>
      </div>
      <div className="doska-filters">
        <label>
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => {
              setArchived(event.target.checked);
              setPage(0);
            }}
          />
          {t("archived")}
        </label>
      </div>
      {tasks.isPending ? (
        <div className="doska-panel" role="status">
          {t("loading")}
        </div>
      ) : tasks.isError ? (
        <div className="doska-panel doska-error" role="alert">
          <p>{t("loadError")}</p>
          <button onClick={() => void tasks.refetch()}>{t("retry")}</button>
        </div>
      ) : !tasks.data.length ? (
        <div className="doska-panel">{t("noTasks")}</div>
      ) : (
        <div className="doska-panel doska-table-wrap">
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
              {tasks.data.map((task) => (
                <tr key={task.id}>
                  <td>
                    <a
                      onClick={(event) => {
                        if (
                          event.button !== 0 ||
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey ||
                          event.altKey
                        )
                          return;
                        event.preventDefault();
                        const state = {
                          doskaMyTasks: {
                            page,
                            archived,
                            scrollY: window.scrollY,
                          },
                        };
                        void (async () => {
                          await navigate({
                            to: "/my-tasks",
                            state,
                            replace: true,
                            resetScroll: false,
                          } as never);
                          await navigate({
                            to: "/projects/$projectId",
                            params: { projectId: task.projectId },
                            search: { taskId: task.id },
                            state,
                          } as never);
                        })();
                      }}
                      href={doskaHref(
                        `/projects/${encodeURIComponent(task.projectId)}?taskId=${encodeURIComponent(task.id)}`,
                      )}
                    >
                      {task.title}
                    </a>
                    {task.parentTaskId && (
                      <span className="doska-task-table-parent">
                        <CornerDownRight size={13} aria-hidden="true" />
                        {t("subtask")}
                      </span>
                    )}
                  </td>
                  <td>{task.projectName}</td>
                  <td>{task.columnName ?? t("unknownStatus")}</td>
                  <td>
                    {task.dueDate
                      ? new Date(task.dueDate).toLocaleDateString("ru-RU")
                      : t("noDueDate")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(page > 0 || tasks.data?.length === pageSize) && (
        <div className="doska-pagination">
          <button
            disabled={page === 0 || tasks.isPending}
            onClick={() => setPage(page - 1)}
          >
            {t("previous")}
          </button>
          <span>{t("page", { page: page + 1 })}</span>
          <button
            disabled={
              !tasks.data || tasks.data.length < pageSize || tasks.isPending
            }
            onClick={() => setPage(page + 1)}
          >
            {t("next")}
          </button>
        </div>
      )}
    </>
  );
}
