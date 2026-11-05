import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, type Column, type CreateTaskInput } from "./api";
import type { FieldPerson } from "./custom-fields";
import { DoskaTaskCustomFields } from "./task-custom-fields";
import { importPriorities, importTaskIssues } from "./task-import-validation";
import "./task-import-editor.css";

export function TaskImportEditor({
  tasks,
  onChange,
  projectId,
  columns,
  people,
  onValidityChange,
}: {
  tasks: CreateTaskInput[];
  onChange: (tasks: CreateTaskInput[]) => void;
  projectId: string;
  columns: Column[];
  people: FieldPerson[];
  onValidityChange: (valid: boolean) => void;
}) {
  const { t } = useTranslation("doska");
  const [selected, setSelected] = useState(0);
  const fields = useQuery({
    queryKey: ["doska", "project-fields", projectId],
    queryFn: () => api.getProjectFields(projectId),
    retry: false,
  });
  const issues = useMemo(
    () =>
      tasks.map((task) =>
        fields.data ? importTaskIssues(task, fields.data, columns, people) : [],
      ),
    [tasks, fields.data, columns, people],
  );
  const valid =
    fields.isSuccess &&
    !fields.isError &&
    tasks.length > 0 &&
    issues.every((row) => !row.length);
  useEffect(() => onValidityChange(valid), [valid, onValidityChange]);
  const index = Math.min(selected, tasks.length - 1);
  const task = tasks[index];
  const page = Math.floor(index / 20);
  const labels = {
    title: t("taskTitle"),
    description: t("description"),
    columnId: t("column"),
    userId: t("responsible"),
    priority: t("priority"),
    startDate: t("startDate"),
    due: t("dueDate"),
  };
  const label = (field: string) =>
    labels[field as keyof typeof labels] ??
    fields.data?.fields.find((item) => item.id === field)?.name ??
    field;
  const hasIssue = (field: string) =>
    issues[index]?.some((issue) => issue.field === field) ?? false;
  const patch = (value: Partial<CreateTaskInput>) =>
    onChange(
      tasks.map((item, row) => (row === index ? { ...item, ...value } : item)),
    );
  if (fields.isError)
    return (
      <div role="alert">
        {t("loadError")}{" "}
        <button
          className="pl-ui-button pl-ui-button-secondary"
          type="button"
          onClick={() => void fields.refetch()}
        >
          {t("retry")}
        </button>
      </div>
    );
  if (!fields.data) return <p role="status">{t("loading")}</p>;
  if (!task) return null;
  const problemCount = issues.filter((row) => row.length).length;
  return (
    <section
      className="doska-import-editor"
      aria-label={t("importEditorReview")}
    >
      <header>
        <h3>{t("importEditorReview")}</h3>
        <span role="status">
          {t("importEditorProblems", { count: problemCount })}
        </span>
      </header>
      {problemCount > 0 && (
        <button
          type="button"
          className="pl-ui-button pl-ui-button-secondary"
          onClick={() => setSelected(issues.findIndex((row) => row.length > 0))}
        >
          {t("importEditorFirstProblem")}
        </button>
      )}
      <div className="doska-import-editor-layout">
        <nav aria-label={t("importEditorTaskList")}>
          <ol start={page * 20 + 1}>
            {tasks.slice(page * 20, (page + 1) * 20).map((item, offset) => {
              const row = page * 20 + offset;
              return (
                <li key={row}>
                  <button
                    type="button"
                    aria-current={row === index ? "true" : undefined}
                    onClick={() => setSelected(row)}
                  >
                    <span>
                      {row + 1}. {item.title || t("importEditorUntitled")}
                    </span>
                    {issues[row]?.length > 0 && (
                      <small>{t("importEditorNeedsEdit")}</small>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
          {tasks.length > 20 && (
            <div className="doska-import-editor-pages">
              <button
                className="pl-ui-button pl-ui-button-secondary"
                type="button"
                disabled={page === 0}
                onClick={() => setSelected((page - 1) * 20)}
              >
                {t("previous")}
              </button>
              <span>
                {page + 1} / {Math.ceil(tasks.length / 20)}
              </span>
              <button
                className="pl-ui-button pl-ui-button-secondary"
                type="button"
                disabled={(page + 1) * 20 >= tasks.length}
                onClick={() => setSelected((page + 1) * 20)}
              >
                {t("next")}
              </button>
            </div>
          )}
        </nav>
        <div className="doska-import-editor-fields">
          <h4>{t("importEditorRow", { row: index + 1 })}</h4>
          {issues[index]?.length > 0 && (
            <ul className="doska-import-editor-issues" aria-live="polite">
              {issues[index].map((issue) => (
                <li key={`${issue.field}-${issue.reason}`}>
                  {label(issue.field)}: {t(`importEditorIssue_${issue.reason}`)}
                </li>
              ))}
            </ul>
          )}
          <label className="doska-field">
            {t("taskTitle")} *
            <input
              className="pl-ui-input"
              value={task.title}
              aria-invalid={hasIssue("title")}
              onChange={(event) => patch({ title: event.target.value })}
            />
          </label>
          <label className="doska-field">
            {t("description")}
            <textarea
              className="pl-ui-textarea"
              rows={4}
              value={task.description ?? ""}
              aria-invalid={hasIssue("description")}
              onChange={(event) => patch({ description: event.target.value })}
            />
          </label>
          <div className="doska-import-editor-grid">
            <label className="doska-field">
              {t("column")} *
              <select
                className="pl-ui-select"
                value={task.columnId ?? ""}
                aria-invalid={hasIssue("columnId")}
                onChange={(event) => patch({ columnId: event.target.value })}
              >
                <option value="">{t("importEditorChooseColumn")}</option>
                {task.columnId &&
                  !columns.some((column) => column.id === task.columnId) && (
                    <option value={task.columnId}>{task.columnId}</option>
                  )}
                {columns.map((column) => (
                  <option key={column.id} value={column.id}>
                    {column.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="doska-field">
              {t("priority")}
              <select
                className="pl-ui-select"
                value={task.priority ?? "no-priority"}
                aria-invalid={hasIssue("priority")}
                onChange={(event) =>
                  patch({
                    priority: event.target.value as CreateTaskInput["priority"],
                  })
                }
              >
                {task.priority &&
                  !importPriorities.some(
                    (value) => value === task.priority,
                  ) && <option value={task.priority}>{task.priority}</option>}
                {importPriorities.map((value) => (
                  <option key={value} value={value}>
                    {t(`priority_${value}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="doska-field">
              {t("responsible")}
              <select
                className="pl-ui-select"
                value={task.userId ?? ""}
                aria-invalid={hasIssue("userId")}
                onChange={(event) =>
                  patch({ userId: event.target.value || null })
                }
              >
                <option value="">{t("unassigned")}</option>
                {task.userId &&
                  !people.some((person) => person.userId === task.userId) && (
                    <option value={task.userId}>{task.userId}</option>
                  )}
                {people.map((person) => (
                  <option key={person.userId} value={person.userId}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="doska-field">
              {t("startDate")}
              <input
                className="pl-ui-input"
                placeholder="YYYY-MM-DD"
                value={task.startDate ?? ""}
                aria-invalid={hasIssue("startDate")}
                onChange={(event) =>
                  patch({ startDate: event.target.value || null })
                }
              />
            </label>
            <label className="doska-field">
              {t("dueDate")}
              <input
                className="pl-ui-input"
                placeholder="YYYY-MM-DD"
                value={task.due?.date ?? ""}
                aria-invalid={hasIssue("due")}
                onChange={(event) =>
                  patch({
                    due: event.target.value
                      ? { date: event.target.value }
                      : null,
                  })
                }
              />
            </label>
          </div>
          <DoskaTaskCustomFields
            fields={fields.data.fields}
            values={task.customValues ?? []}
            baseline={[]}
            creating
            people={people}
            onChange={(customValues) => patch({ customValues })}
          />
        </div>
      </div>
    </section>
  );
}
