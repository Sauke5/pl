import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { Task, Column } from "./api";
import {
  applyBulkChange,
  incompleteBulkChildren,
  type BulkChange,
  type BulkResult,
} from "./bulk-change";
import "./task-bulk-actions.css";
export function DoskaTaskBulkActions({
  projectId,
  tasks,
  allTasks,
  columns,
  roster,
  onClose,
  onChanged,
}: {
  projectId: string;
  tasks: Task[];
  allTasks: Task[];
  columns: Column[];
  roster: { userId: string; name: string; role?: string }[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation("doska");
  const [selected] = useState(() => structuredClone(tasks));
  const [kind, setKind] = useState<BulkChange["kind"]>("column");
  const [columnId, setColumnId] = useState(columns[0]?.id ?? "");
  const [userId, setUserId] = useState("");
  const [priority, setPriority] =
    useState<Extract<BulkChange, { kind: "priority" }>["priority"]>("medium");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [clearDue, setClearDue] = useState(false);
  const [stage, setStage] = useState<
    "edit" | "preview" | "applying" | "result"
  >("edit");
  const [confirmChildren, setConfirmChildren] = useState(false);
  const [results, setResults] = useState<BulkResult[]>([]);
  const busy = useRef(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  useEffect(() => {
    if (stage !== "applying") return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [stage]);
  const change: BulkChange =
    kind === "column"
      ? { kind, columnId, confirmIncompleteSubtasks: confirmChildren }
      : kind === "responsible"
        ? { kind, userId: userId || null }
        : kind === "priority"
          ? { kind, priority }
          : kind === "due"
            ? {
                kind,
                due: clearDue ? null : { date, ...(time ? { time } : {}) },
              }
            : { kind };
  const children =
    kind === "column"
      ? incompleteBulkChildren(selected, allTasks, columns, columnId)
      : [];
  const valid =
    selected.length > 0 &&
    selected.length <= 100 &&
    (kind !== "column" || Boolean(columnId)) &&
    (kind !== "due" || clearDue || Boolean(date));
  const person = (id: string | null) =>
    id
      ? (roster.find((person) => person.userId === id)?.name ??
        t("unavailableMember"))
      : t("unassigned");
  const dateLabel = (value: string | null, hasTime = false) =>
    value
      ? new Date(value).toLocaleString("ru-RU", {
          timeZone: "Europe/Moscow",
          year: "numeric",
          month: "short",
          day: "numeric",
          ...(hasTime ? { hour: "2-digit", minute: "2-digit" } : {}),
        })
      : t("noDueDate");
  const before = (task: Task) =>
    kind === "column"
      ? (columns.find((column) => column.id === task.columnId)?.name ??
        t("withoutColumn"))
      : kind === "responsible"
        ? person(task.userId)
        : kind === "priority"
          ? t(`priority_${task.priority}`)
          : kind === "due"
            ? dateLabel(task.dueDate, task.dueDateHasTime)
            : t(task.archivedAt ? "archived" : "bulkActiveTask");
  const after =
    kind === "column"
      ? columns.find((column) => column.id === columnId)?.name
      : kind === "responsible"
        ? person(userId || null)
        : kind === "priority"
          ? t(`priority_${priority}`)
          : kind === "due"
            ? clearDue
              ? t("noDueDate")
              : dateLabel(`${date}T${time || "23:59"}:00+03:00`, Boolean(time))
            : t("archived");
  const apply = async () => {
    if (
      busy.current ||
      stage !== "preview" ||
      !valid ||
      (children.length > 0 && !confirmChildren)
    )
      return;
    busy.current = true;
    setStage("applying");
    try {
      await applyBulkChange(projectId, selected, change, (result) =>
        setResults((current) => [...current, result]),
      );
    } finally {
      setStage("result");
      busy.current = false;
      onChanged();
    }
  };
  return (
    <dialog
      ref={ref}
      className="doska-dialog doska-bulk-dialog"
      aria-labelledby="doska-bulk-heading"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy.current) onClose();
      }}
    >
      <header className="doska-bulk-heading">
        <h2 id="doska-bulk-heading">
          {t("bulkTitle", { count: selected.length })}
        </h2>
        <button
          className="doska-icon"
          aria-label={t("close")}
          disabled={stage === "applying"}
          onClick={() => {
            if (!busy.current) onClose();
          }}
        >
          <X size={20} />
        </button>
      </header>
      {selected.length > 100 && (
        <p role="alert" className="doska-error">
          {t("bulkLimit")}
        </p>
      )}
      {stage === "edit" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) setStage("preview");
          }}
        >
          <label className="doska-field">
            {t("bulkAction")}
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as BulkChange["kind"]);
                setConfirmChildren(false);
              }}
            >
              {(
                ["column", "responsible", "priority", "due", "archive"] as const
              ).map((value) => (
                <option key={value} value={value}>
                  {t(`bulkAction_${value}`)}
                </option>
              ))}
            </select>
          </label>
          {kind === "column" && (
            <label className="doska-field">
              {t("column")}
              <select
                value={columnId}
                onChange={(event) => {
                  setColumnId(event.target.value);
                  setConfirmChildren(false);
                }}
              >
                {columns.map((column) => (
                  <option key={column.id} value={column.id}>
                    {column.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === "responsible" && (
            <label className="doska-field">
              {t("responsible")}
              <select
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
              >
                <option value="">{t("unassigned")}</option>
                {roster
                  .filter((person) => person.role !== "observer")
                  .map((person) => (
                    <option key={person.userId} value={person.userId}>
                      {person.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {kind === "priority" && (
            <label className="doska-field">
              {t("priority")}
              <select
                value={priority}
                onChange={(event) =>
                  setPriority(event.target.value as typeof priority)
                }
              >
                {(
                  ["no-priority", "low", "medium", "high", "urgent"] as const
                ).map((value) => (
                  <option key={value} value={value}>
                    {t(`priority_${value}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === "due" && (
            <>
              <label className="doska-bulk-check">
                <input
                  type="checkbox"
                  checked={clearDue}
                  onChange={(event) => setClearDue(event.target.checked)}
                />
                {t("bulkClearDue")}
              </label>
              {!clearDue && (
                <div className="doska-bulk-dates">
                  <label className="doska-field">
                    {t("dueDate")}
                    <input
                      type="date"
                      required
                      value={date}
                      onChange={(event) => setDate(event.target.value)}
                    />
                  </label>
                  <label className="doska-field">
                    {t("dueTimeMoscow")}
                    <input
                      type="time"
                      value={time}
                      onChange={(event) => setTime(event.target.value)}
                    />
                  </label>
                </div>
              )}
            </>
          )}
          <footer>
            <button type="button" onClick={onClose}>
              {t("cancel")}
            </button>
            <button type="submit" className="doska-primary" disabled={!valid}>
              {t("bulkPreview")}
            </button>
          </footer>
        </form>
      ) : (
        <>
          {stage === "preview" && children.length > 0 && (
            <div className="doska-notice">
              <p>{t("bulkIncompleteWarning", { count: children.length })}</p>
              <label className="doska-bulk-check">
                <input
                  type="checkbox"
                  checked={confirmChildren}
                  onChange={(event) => setConfirmChildren(event.target.checked)}
                />
                {t("bulkConfirmIncomplete")}
              </label>
            </div>
          )}
          {stage === "applying" && (
            <p role="status">
              {t("bulkProgress", {
                done: results.length,
                total: selected.length,
              })}
            </p>
          )}
          {stage === "result" && (
            <p role="status">
              {t("bulkSummary", {
                success: results.filter((result) => result.status === "success")
                  .length,
                skipped: results.filter((result) => result.status === "skipped")
                  .length,
                unconfirmed: results.filter(
                  (result) => result.status === "unconfirmed",
                ).length,
              })}
            </p>
          )}
          <div className="doska-table-wrap doska-bulk-preview">
            <table>
              <thead>
                <tr>
                  <th>{t("task")}</th>
                  <th>{t("bulkBefore")}</th>
                  <th>{t("bulkAfter")}</th>
                  {stage !== "preview" && <th>{t("bulkResult")}</th>}
                </tr>
              </thead>
              <tbody>
                {selected.map((task) => {
                  const result = results.find(
                    (result) => result.task.id === task.id,
                  );
                  return (
                    <tr key={task.id}>
                      <td>{task.title}</td>
                      <td>{before(task)}</td>
                      <td>{after}</td>
                      {stage !== "preview" && (
                        <td>
                          {result
                            ? t(result.reason ?? "bulkSuccess")
                            : t("bulkWaiting")}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {stage === "result" &&
            results.some((result) => result.status !== "success") && (
              <p className="doska-meta">{t("bulkReselect")}</p>
            )}
          <footer>
            {stage === "preview" ? (
              <>
                <button onClick={() => setStage("edit")}>
                  {t("bulkBack")}
                </button>
                <button
                  className="doska-primary"
                  disabled={!valid || (children.length > 0 && !confirmChildren)}
                  onClick={() => void apply()}
                >
                  {t("bulkApply")}
                </button>
              </>
            ) : (
              <button disabled={stage === "applying"} onClick={onClose}>
                {t("close")}
              </button>
            )}
          </footer>
        </>
      )}
    </dialog>
  );
}
