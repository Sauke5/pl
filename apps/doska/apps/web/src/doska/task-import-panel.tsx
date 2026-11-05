import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, type Column, type CreateTaskInput } from "./api";
import {
  ImportFileError,
  buildTaskImport,
  importFileLimit,
  parseTaskImport,
} from "./task-import-parser";
import { TaskImportError } from "./task-import-error";
import { TaskImportEditor } from "./task-import-editor";
import { TaskImportMapping } from "./task-import-mapping";
import "./task-import.css";
type Attempt = { clientRequestId: string; tasks: CreateTaskInput[] };
export function DoskaTaskImport({
  projectId,
  columns,
  onClose,
}: {
  projectId: string;
  columns: Column[];
  onClose: () => void;
}) {
  const { t } = useTranslation("doska");
  const cache = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const attemptRef = useRef<Attempt | null>(null);
  const [parsed, setParsed] = useState<ReturnType<
    typeof parseTaskImport
  > | null>(null);
  const [fileName, setFileName] = useState("");
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<ImportFileError | null>(null);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>(
    {},
  );
  const [userMapping, setUserMapping] = useState<Record<string, string | null>>(
    {},
  );
  const [uncertain, setUncertain] = useState(false);
  const [staged, setStaged] = useState<CreateTaskInput[] | null>(null);
  const [valid, setValid] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const unknownFields =
    parsed?.issues.filter((issue) => issue.code === "unknown_field") ?? [];
  const roster = useQuery({
    queryKey: ["doska", "members", projectId],
    queryFn: () => api.listMembers(projectId),
    retry: false,
  });
  const people = roster.data
    ? Array.from(
        new Map(
          [
            roster.data.owner,
            ...roster.data.members.filter(
              (person) => person.role === "participant",
            ),
          ].map((person) => [
            person.userId,
            {
              userId: person.userId,
              name: person.name ?? t("unavailableMember"),
            },
          ]),
        ).values(),
      )
    : [];
  const save = useMutation({
    mutationFn: (attempt: Attempt) => api.importTasks(projectId, attempt),
    retry: false,
    onSuccess: async () => {
      setUncertain(false);
      await cache.invalidateQueries({ queryKey: ["doska"] });
    },
    onError: (error) => {
      const unknown =
        !(error instanceof TaskImportError) || error.status >= 500;
      setUncertain(unknown);
      if (!unknown) attemptRef.current = null;
    },
  });
  useEffect(() => {
    const fileGeneration = generation;
    const element = dialog.current,
      previous = document.activeElement;
    element?.showModal();
    return () => {
      fileGeneration.current++;
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  const locked = save.isPending || uncertain || save.isSuccess;
  async function chooseFile(file: File | undefined) {
    const current = ++generation.current;
    setParsed(null);
    setAcknowledged(false);
    setStaged(null);
    setValid(false);
    setFileError(null);
    setFileName(file?.name ?? "");
    setUncertain(false);
    attemptRef.current = null;
    save.reset();
    if (!file) return;
    setReading(true);
    try {
      if (file.size > importFileLimit)
        throw new ImportFileError("file_too_large");
      const data = parseTaskImport(await file.text());
      if (current !== generation.current) return;
      setParsed(data);
      setColumnMapping(
        Object.fromEntries(
          data.statuses.map((status) => [
            status,
            columns.find((column) => column.slug === status)?.id ?? "",
          ]),
        ),
      );
      setUserMapping(
        Object.fromEntries(data.assignees.map((user) => [user, user])),
      );
    } catch (error) {
      if (current === generation.current)
        setFileError(
          error instanceof ImportFileError
            ? error
            : new ImportFileError("invalid_json"),
        );
    } finally {
      if (current === generation.current) setReading(false);
    }
  }
  const ready = Boolean(
    parsed && !reading && !fileError && roster.isSuccess && !roster.isError,
  );
  function submit() {
    if (save.isPending || save.isSuccess) return;
    if (
      !attemptRef.current &&
      (!ready ||
        !staged ||
        !valid ||
        (unknownFields.length > 0 && !acknowledged))
    )
      return;
    try {
      const attempt = attemptRef.current ?? {
        clientRequestId: crypto.randomUUID(),
        tasks: staged!,
      };
      if (
        new TextEncoder().encode(JSON.stringify(attempt)).byteLength >
        importFileLimit
      )
        throw new ImportFileError("file_too_large");
      attemptRef.current = attempt;
      save.mutate(attempt);
    } catch (error) {
      setFileError(
        error instanceof ImportFileError
          ? error
          : new ImportFileError("invalid_task"),
      );
    }
  }
  const serverError = save.error instanceof TaskImportError ? save.error : null;
  const row = serverError?.row;
  return (
    <dialog
      ref={dialog}
      className="doska-dialog doska-import-dialog"
      aria-labelledby="doska-import-heading"
      onCancel={(event) => {
        event.preventDefault();
        if (!save.isPending) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h2 id="doska-import-heading">{t("importTasks")}</h2>
        <fieldset disabled={locked}>
          {!staged && (
            <>
              <label className="doska-field">
                {t("importFile")}
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={(event) => void chooseFile(event.target.files?.[0])}
                />
              </label>
              <p className="doska-meta">{t("importFileHint")}</p>
            </>
          )}
          {reading && <p role="status">{t("loading")}</p>}
          {fileError && (
            <p className="doska-error" role="alert">
              {fileError.row
                ? t("importRow", { row: fileError.row }) + ": "
                : ""}
              {t(`importError_${fileError.code}`)}
              {fileError.field ? ` (${fileError.field})` : ""}
            </p>
          )}
          {parsed && !staged && (
            <>
              <p>
                {t("importTaskCount", { count: parsed.tasks.length })} ·{" "}
                {fileName}
              </p>
              <TaskImportMapping
                statuses={parsed.statuses}
                assignees={parsed.assignees}
                columns={columns}
                people={people}
                columnMapping={columnMapping}
                userMapping={userMapping}
                onColumn={(status, id) => {
                  save.reset();
                  setColumnMapping((value) => ({ ...value, [status]: id }));
                }}
                onUser={(source, id) => {
                  save.reset();
                  setUserMapping((value) => ({ ...value, [source]: id }));
                }}
              />
              <p className="doska-meta">{t("importDatesHint")}</p>
            </>
          )}
          {parsed && parsed.issues.length > 0 && (
            <details
              className="doska-import-issues"
              open={unknownFields.length > 0 ? true : undefined}
            >
              <summary>
                {t("importSourceIssues")}: {parsed.issues.length}
              </summary>
              {parsed.issues.map((issue) => (
                <p key={`${issue.row}:${issue.field}:${issue.code}`}>
                  {t("importRow", { row: issue.row })} · {issue.field}:{" "}
                  {issue.value} — {t(`importError_${issue.code}`)}
                </p>
              ))}
            </details>
          )}
          {staged && unknownFields.length > 0 && (
            <label>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              {t("importDiscardUnknown")}
            </label>
          )}
          {staged && (
            <TaskImportEditor
              projectId={projectId}
              tasks={staged}
              columns={columns}
              people={people}
              onChange={(tasks) => {
                setStaged(tasks);
                setFileError(null);
                save.reset();
              }}
              onValidityChange={setValid}
            />
          )}
        </fieldset>
        {roster.isError && (
          <p role="alert" className="doska-error">
            {t("loadError")}{" "}
            <button type="button" onClick={() => void roster.refetch()}>
              {t("retry")}
            </button>
          </p>
        )}
        {save.isError && (
          <p role="alert" className="doska-error">
            {uncertain
              ? t("importUncertain")
              : row
                ? t("importInvalidRow", { row })
                : t(
                    serverError?.status === 409
                      ? "importConflict"
                      : serverError?.status === 403 ||
                          serverError?.status === 404
                        ? "importAccessLost"
                        : serverError?.status === 413
                          ? "importError_file_too_large"
                          : "importRejected",
                  )}
          </p>
        )}
        {save.isError && !uncertain && serverError?.issues[0]?.message && (
          <p className="doska-error">{serverError.issues[0].message}</p>
        )}
        {save.isSuccess && (
          <p role="status">
            {t(save.data.replayed ? "importAlreadyDone" : "importDone", {
              count: save.data.imported,
            })}
          </p>
        )}
        {confirmReset && !locked && (
          <div role="alert">
            <p>{t("importResetWarning")}</p>
            <button
              type="button"
              onClick={() => {
                setStaged(null);
                setValid(false);
                setConfirmReset(false);
                save.reset();
                setFileError(null);
              }}
            >
              {t("importResetConfirm")}
            </button>
            <button type="button" onClick={() => setConfirmReset(false)}>
              {t("cancel")}
            </button>
          </div>
        )}
        <footer>
          {staged && !locked && (
            <button type="button" onClick={() => setConfirmReset(true)}>
              {t("importBack")}
            </button>
          )}
          <button type="button" disabled={save.isPending} onClick={onClose}>
            {t(save.isSuccess ? "close" : "cancel")}
          </button>
          {!staged && (
            <button
              type="button"
              className="doska-primary"
              disabled={!ready}
              onClick={() => {
                try {
                  setStaged(
                    buildTaskImport(parsed!.tasks, columnMapping, userMapping),
                  );
                } catch (error) {
                  if (error instanceof ImportFileError) setFileError(error);
                }
              }}
            >
              {t("importReview")}
            </button>
          )}
          {staged && !save.isSuccess && (
            <button
              className="doska-primary"
              disabled={
                save.isPending ||
                (!uncertain &&
                  (!ready ||
                    !valid ||
                    (unknownFields.length > 0 && !acknowledged)))
              }
            >
              {t(
                save.isPending
                  ? "importing"
                  : uncertain
                    ? "importRetry"
                    : "importSubmit",
                { count: parsed?.tasks.length ?? 0 },
              )}
            </button>
          )}
        </footer>
      </form>
    </dialog>
  );
}
