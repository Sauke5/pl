import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, type Task, type Column } from "./api";
import { doskaHref } from "./shell";
import "./task-subtasks.css";

export function DoskaTaskSubtasks({
  projectId,
  task,
  columns,
  canWork,
  disabled = false,
  onDirtyChange,
  onCreate,
}: {
  projectId: string;
  task: Task;
  columns: Column[];
  canWork: boolean;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onCreate?: () => void;
}) {
  const { t } = useTranslation("doska");
  const client = useQueryClient();
  const [mode, setMode] = useState<"create" | "attach" | "detach" | null>(null);
  const [title, setTitle] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [archived, setArchived] = useState(false);
  const [searchPage, setSearchPage] = useState(0);
  const [selected, setSelected] = useState<Task | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectionError, setSelectionError] = useState(false);
  const children = useQuery({
    queryKey: ["doska", "subtasks", projectId, task.id, archived, page],
    enabled: !task.parentTaskId,
    queryFn: () =>
      api.listTasks(projectId, {
        parentTaskId: task.id,
        archived,
        limit: 20,
        offset: page * 20,
      }),
  });
  const parent = useQuery({
    queryKey: ["doska", "task", projectId, task.parentTaskId],
    enabled: Boolean(task.parentTaskId),
    queryFn: () => api.getTask(projectId, task.parentTaskId!),
  });
  const results = useQuery({
    queryKey: ["doska", "subtask-search", projectId, query, searchPage],
    enabled: mode === "attach" && canWork,
    queryFn: () =>
      api.searchTasks({
        projectId,
        q: query || undefined,
        limit: 20,
        offset: searchPage * 20,
      }),
  });
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setSearchPage(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  function close() {
    setMode(null);
    setSelected(null);
    setTitle("");
    setSelectionError(false);
  }
  async function refresh() {
    await Promise.all(
      ["subtasks", "task", "tasks", "my-tasks", "history"].map((key) =>
        client.invalidateQueries({ queryKey: ["doska", key] }),
      ),
    );
  }
  const planned =
    [...columns]
      .sort((a, b) => a.position - b.position)
      .find((column) => column.semanticState === "planned") ?? columns[0];
  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "create")
        return api.createTask(projectId, {
          title: title.trim(),
          parentTaskId: task.id,
          columnId: planned?.id,
        });
      if (!selected) throw new Error("No subtask selected");
      return api.updateTask(projectId, selected.id, {
        expectedRevision: selected.revision,
        parentTaskId: mode === "detach" ? null : task.id,
      });
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) await refresh();
    },
    onSuccess: async () => {
      close();
      if (mode === "detach" && page && children.data?.length === 1)
        setPage(page - 1);
      await refresh();
    },
  });
  useEffect(() => {
    onDirtyChange?.(Boolean(mode) || mutation.isPending || selecting);
  }, [mode, mutation.isPending, selecting, onDirtyChange]);
  useEffect(() => {
    if (!canWork) close();
  }, [canWork]);
  function open(next: "create" | "attach" | "detach", target?: Task) {
    mutation.reset();
    setSelectionError(false);
    setSelected(target ?? null);
    setMode(next);
    setSearch("");
    setQuery("");
    setSearchPage(0);
  }
  const conflict =
    mutation.error instanceof ApiError && mutation.error.status === 409;
  const blocked =
    mutation.isPending || selecting || conflict || !canWork || disabled;
  async function select(id: string) {
    setSelecting(true);
    setSelectionError(false);
    try {
      setSelected(await api.getTask(projectId, id));
    } catch {
      setSelectionError(true);
    } finally {
      setSelecting(false);
    }
  }
  const link = (item: Task) => (
    <a
      href={doskaHref(
        `/projects/${encodeURIComponent(projectId)}?taskId=${encodeURIComponent(item.id)}`,
      )}
      onClick={(event) => {
        if (mode) event.preventDefault();
      }}
      aria-disabled={Boolean(mode)}
    >
      #{item.number} {item.title}
    </a>
  );
  return (
    <section className="doska-task-subtasks">
      <header>
        <h3>{t(task.parentTaskId ? "subtaskParent" : "subtasks")}</h3>
        {canWork &&
          !mode &&
          (task.parentTaskId ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => open("detach", task)}
            >
              {t("subtaskDetach")}
            </button>
          ) : (
            <div>
              <button
                type="button"
                disabled={disabled}
                onClick={() => (onCreate ? onCreate() : open("create"))}
              >
                {t("subtaskCreate")}
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => open("attach")}
              >
                {t("subtaskAttach")}
              </button>
            </div>
          ))}
      </header>
      {task.parentTaskId ? (
        parent.isPending ? (
          <p role="status">{t("loading")}</p>
        ) : parent.isError ? (
          <p role="alert">
            {t("loadError")}{" "}
            <button type="button" onClick={() => void parent.refetch()}>
              {t("retry")}
            </button>
          </p>
        ) : (
          <p>{link(parent.data)}</p>
        )
      ) : (
        <>
          <label
            className="doska-subtask-muted"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              marginTop: 10,
            }}
          >
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
          {children.isPending ? (
            <p role="status">{t("loading")}</p>
          ) : children.isError ? (
            <p role="alert">
              {t("loadError")}{" "}
              <button type="button" onClick={() => void children.refetch()}>
                {t("retry")}
              </button>
            </p>
          ) : children.data.length ? (
            <ul>
              {children.data.map((child) => (
                <li key={child.id}>
                  <div>
                    {link(child)}
                    <small>
                      {
                        columns.find((column) => column.id === child.columnId)
                          ?.name
                      }
                    </small>
                  </div>
                  {canWork && (
                    <button
                      type="button"
                      disabled={
                        Boolean(mode) || disabled || Boolean(child.archivedAt)
                      }
                      aria-label={t("subtaskDetachNamed", {
                        name: child.title,
                      })}
                      onClick={() => open("detach", child)}
                    >
                      {t("subtaskDetach")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="doska-subtask-muted">{t("subtasksEmpty")}</p>
          )}
          {(page > 0 || children.data?.length === 20) && (
            <nav aria-label={t("subtasks")}>
              <button
                type="button"
                disabled={!page || children.isFetching}
                onClick={() => setPage(page - 1)}
              >
                {t("previous")}
              </button>
              <button
                type="button"
                disabled={children.data?.length !== 20 || children.isFetching}
                onClick={() => setPage(page + 1)}
              >
                {t("next")}
              </button>
            </nav>
          )}
        </>
      )}
      {mode && (
        <div className="doska-subtask-form">
          {mode === "create" && (
            <label>
              {t("taskTitle")}
              <input
                aria-label={t("taskTitle")}
                autoFocus
                maxLength={500}
                value={title}
                disabled={blocked}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && title.trim() && !blocked) {
                    event.preventDefault();
                    mutation.mutate();
                  }
                }}
              />
            </label>
          )}
          {mode === "attach" && (
            <>
              <label>
                {t("subtaskSearch")}
                <input
                  aria-label={t("subtaskSearch")}
                  value={search}
                  disabled={blocked}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              {results.isPending || selecting ? (
                <p role="status">{t("loading")}</p>
              ) : results.isError ? (
                <p role="alert">
                  {t("loadError")}{" "}
                  <button type="button" onClick={() => void results.refetch()}>
                    {t("retry")}
                  </button>
                </p>
              ) : (
                <div className="doska-subtask-results">
                  {results.data
                    .filter((item) => item.id !== task.id && !item.parentTaskId)
                    .map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        disabled={blocked}
                        aria-pressed={selected?.id === item.id}
                        onClick={() => void select(item.id)}
                      >
                        #{item.number} {item.title}
                      </button>
                    ))}
                </div>
              )}
              {(searchPage > 0 || results.data?.length === 20) && (
                <nav>
                  <button
                    type="button"
                    disabled={!searchPage || blocked}
                    onClick={() => setSearchPage(searchPage - 1)}
                  >
                    {t("previous")}
                  </button>
                  <button
                    type="button"
                    disabled={results.data?.length !== 20 || blocked}
                    onClick={() => setSearchPage(searchPage + 1)}
                  >
                    {t("next")}
                  </button>
                </nav>
              )}
              {selected && (
                <p>{t("subtaskSelected", { name: selected.title })}</p>
              )}
            </>
          )}
          {mode === "detach" && (
            <p>{t("subtaskDetachConfirm", { name: selected?.title })}</p>
          )}
          {selectionError && <p role="alert">{t("loadError")}</p>}
          {mutation.isError && (
            <p role="alert" className="doska-error">
              {t(
                conflict
                  ? "subtaskConflict"
                  : mutation.error instanceof ApiError &&
                      mutation.error.status === 400
                    ? "subtaskHierarchyError"
                    : "saveError",
              )}
            </p>
          )}
          <div className="doska-subtask-actions">
            <button
              type="button"
              disabled={
                blocked ||
                (mode === "create" ? !title.trim() || !planned : !selected)
              }
              onClick={() => mutation.mutate()}
            >
              {t(
                mode === "create"
                  ? "subtaskCreate"
                  : mode === "attach"
                    ? "subtaskAttach"
                    : "subtaskDetach",
              )}
            </button>
            <button
              type="button"
              disabled={mutation.isPending || selecting}
              onClick={() => {
                close();
                mutation.reset();
              }}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
