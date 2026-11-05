import { useEffect, useRef, useState } from "react";
import { Download, Paperclip, Trash2, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, type TaskAttachment } from "./api";
import "./task-attachments.css";
const pageSize = 20;
const maxBytes = 25 * 1024 * 1024;
const accepted =
  ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf,.txt,.csv,.log,.md,.json,.xml,.yaml,.yml,.jpg,.jpeg,.png,.gif,.webp,.bmp,.tif,.tiff,.heic,.heif,.avif,.zip,.7z,.rar,.tar,.gz,.bz2,.xz";
function fileSize(bytes: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: bytes >= 1_048_576 ? "megabyte" : bytes >= 1024 ? "kilobyte" : "byte",
    maximumFractionDigits: 1,
  }).format(
    bytes / (bytes >= 1_048_576 ? 1_048_576 : bytes >= 1024 ? 1024 : 1),
  );
}
type Draft = { file: File; clientRequestId: string };
export function DoskaTaskAttachments({
  projectId,
  taskId,
  canWork,
  onDirtyChange,
}: {
  projectId: string;
  taskId: string;
  canWork: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t, i18n } = useTranslation("doska");
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<TaskAttachment | null>(null);
  const files = useQuery({
    queryKey: ["doska", "attachments", projectId, taskId, page],
    queryFn: () =>
      api.listAttachments(projectId, taskId, {
        limit: pageSize,
        offset: page * pageSize,
      }),
  });
  async function refresh() {
    await Promise.all([
      client.invalidateQueries({
        queryKey: ["doska", "attachments", projectId, taskId],
      }),
      client.invalidateQueries({
        queryKey: ["doska", "history", projectId, taskId],
      }),
    ]);
  }
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAttachment(projectId, taskId, id),
    onSuccess: async () => {
      setDeleting(null);
      if (page && files.data?.length === 1) setPage(page - 1);
      await refresh();
    },
  });
  useEffect(() => {
    onDirtyChange?.(Boolean(draft) || busy || remove.isPending);
  }, [draft, busy, remove.isPending, onDirtyChange]);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!canWork) {
      controller.current?.abort();
      setDraft(null);
      setDeleting(null);
    }
  }, [canWork]);
  async function upload(value: Draft) {
    if (controller.current || !canWork) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    setProgress(0);
    try {
      await api.uploadAttachment(projectId, taskId, value.file, {
        signal: abort.signal,
        onProgress: (percent) => {
          if (!abort.signal.aborted) setProgress(percent);
        },
        clientRequestId: value.clientRequestId,
      });
      if (!abort.signal.aborted) {
        setDraft(null);
        setPage(0);
        await refresh();
      }
    } catch (reason) {
      if (!abort.signal.aborted)
        setError(
          reason instanceof ApiError && reason.status === 413
            ? "attachmentQuotaError"
            : reason instanceof ApiError && [403, 404].includes(reason.status)
              ? "attachmentAccessError"
              : "attachmentUploadError",
        );
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        setBusy(false);
      }
    }
  }
  function discard() {
    controller.current?.abort();
    setDraft(null);
    setError("");
  }
  function select(file?: File) {
    if (!file || busy || !canWork) return;
    if (file.size <= 0 || file.size > maxBytes) {
      setError("attachmentSizeError");
      return;
    }
    const extension = `.${file.name.split(".").at(-1)?.toLowerCase()}`;
    if (!accepted.split(",").includes(extension)) {
      setError("attachmentTypeError");
      return;
    }
    const value = { file, clientRequestId: crypto.randomUUID() };
    setDraft(value);
    void upload(value);
  }
  return (
    <section className="doska-task-attachments">
      <header>
        <h3>{t("attachments")}</h3>
        {canWork && (
          <>
            <input
              ref={input}
              type="file"
              accept={accepted}
              hidden
              aria-label={t("attachmentAdd")}
              disabled={Boolean(draft) || busy}
              onChange={(event) => {
                select(event.currentTarget.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
            <button
              type="button"
              className="doska-attachment-add"
              disabled={Boolean(draft) || busy}
              onClick={() => input.current?.click()}
            >
              <Paperclip size={15} />
              {t("attachmentAdd")}
            </button>
          </>
        )}
      </header>
      {canWork && (
        <p className="doska-attachment-limit">{t("attachmentLimit")}</p>
      )}
      {draft && (
        <div className="doska-attachment-upload" aria-busy={busy}>
          <div>
            <span title={draft.file.name}>{draft.file.name}</span>
            <button
              type="button"
              aria-label={t("attachmentCancelUpload")}
              onClick={discard}
            >
              <X size={16} />
            </button>
          </div>
          {busy && (
            <>
              <progress
                value={progress}
                max={100}
                aria-label={t("attachmentUploading")}
              />
              <small role="status">
                {t("attachmentUploading")} · {Math.round(progress)}%
              </small>
            </>
          )}
          {!busy && error && (
            <div className="doska-attachment-actions">
              <button
                type="button"
                onClick={() => void upload(draft)}
                disabled={!canWork}
              >
                {t("retry")}
              </button>
              <button type="button" onClick={discard}>
                {t("cancel")}
              </button>
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="doska-notice doska-error" role="alert">
          {t(error)}
        </p>
      )}
      {files.isPending ? (
        <p role="status">{t("loading")}</p>
      ) : files.isError ? (
        <div className="doska-notice doska-error" role="alert">
          {t("loadError")}{" "}
          <button type="button" onClick={() => void files.refetch()}>
            {t("retry")}
          </button>
        </div>
      ) : files.data.length === 0 ? (
        <p className="doska-attachment-empty">{t("attachmentsEmpty")}</p>
      ) : (
        <ul>
          {files.data.map((file) => (
            <li key={file.id}>
              <Paperclip size={16} aria-hidden="true" />
              <div className="doska-attachment-info">
                <a
                  href={api.attachmentDownloadUrl(projectId, taskId, file.id)}
                  download={file.filename}
                  title={file.filename}
                >
                  {file.filename}
                </a>
                <small>{fileSize(file.size, i18n.language)}</small>
              </div>
              <a
                className="doska-attachment-icon"
                href={api.attachmentDownloadUrl(projectId, taskId, file.id)}
                download={file.filename}
                aria-label={t("attachmentDownloadNamed", {
                  name: file.filename,
                })}
              >
                <Download size={16} />
              </a>
              {canWork && (
                <button
                  type="button"
                  className="doska-attachment-icon"
                  aria-label={t("attachmentDeleteNamed", {
                    name: file.filename,
                  })}
                  disabled={remove.isPending}
                  onClick={() => {
                    remove.reset();
                    setDeleting(file);
                  }}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {files.data && (page > 0 || files.data.length === pageSize) && (
        <div className="doska-attachment-actions">
          {page > 0 && (
            <button type="button" onClick={() => setPage(page - 1)}>
              {t("previous")}
            </button>
          )}
          {files.data.length === pageSize && (
            <button type="button" onClick={() => setPage(page + 1)}>
              {t("next")}
            </button>
          )}
        </div>
      )}
      {deleting && (
        <div
          className="doska-attachment-confirm"
          role="group"
          aria-label={t("attachmentDeleteConfirm", { name: deleting.filename })}
        >
          <p>{t("attachmentDeleteConfirm", { name: deleting.filename })}</p>
          {remove.isError && (
            <p role="alert" className="doska-error">
              {t("attachmentDeleteError")}
            </p>
          )}
          <div className="doska-attachment-actions">
            <button
              type="button"
              className="doska-danger"
              disabled={remove.isPending || !canWork}
              onClick={() => remove.mutate(deleting.id)}
            >
              {t("delete")}
            </button>
            <button
              type="button"
              disabled={remove.isPending}
              onClick={() => {
                remove.reset();
                setDeleting(null);
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
