import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { historyChanges } from "./history-changes";
const events: Record<string, string> = {
  "doska.task.resource.attached": "historyResourceAttached",
  "doska.task.resource.detached": "historyResourceDetached",
  "doska.task.attachment.created": "historyAttachmentCreated",
  "doska.task.attachment.deleted": "historyAttachmentDeleted",
  "doska.task.created": "historyCreated",
  "doska.task.updated": "historyUpdated",
  "doska.task.archived": "historyArchived",
  "doska.task.restored": "historyRestored",
  "doska.task.parent_deleted": "historyParentDeleted",
  "doska.task.incomplete_subtasks_confirmed": "historySubtasksConfirmed",
  "doska.task.relation.created": "historyRelationCreated",
  "doska.task.relation.deleted": "historyRelationDeleted",
  "doska.task.column_state_changed": "historyColumnState",
  "doska.task.comment.created": "historyCommentCreated",
  "doska.task.comment.updated": "historyCommentUpdated",
  "doska.task.comment.deleted": "historyCommentDeleted",
  "doska.task.checklist.created": "historyChecklistCreated",
  "doska.task.checklist.renamed": "historyChecklistRenamed",
  "doska.task.checklist.deleted": "historyChecklistDeleted",
  "doska.task.checklist.reordered": "historyChecklistReordered",
  "doska.task.checklist.item.created": "historyChecklistItemCreated",
  "doska.task.checklist.item.updated": "historyChecklistItemUpdated",
  "doska.task.checklist.item.deleted": "historyChecklistItemDeleted",
  "doska.task.checklist.items.reordered": "historyChecklistItemsReordered",
};
export function DoskaTaskHistory({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const { t } = useTranslation("doska");
  const [page, setPage] = useState(0);
  const fields = useQuery({
    queryKey: ["doska", "project-fields", projectId],
    queryFn: () => api.getProjectFields(projectId),
  });
  const history = useQuery({
    queryKey: ["doska", "history", projectId, taskId, page],
    queryFn: () =>
      api.taskHistory(projectId, taskId, { limit: 20, offset: page * 20 }),
  });
  return (
    <section className="doska-task-history">
      <h3>{t("taskHistory")}</h3>
      {history.isPending ? (
        <p role="status">{t("loading")}</p>
      ) : history.isError ? (
        <div className="doska-notice doska-error" role="alert">
          {t("loadError")}{" "}
          <button onClick={() => void history.refetch()}>{t("retry")}</button>
        </div>
      ) : !history.data.length ? (
        <p>{t("noHistory")}</p>
      ) : (
        <ol>
          {history.data.map((item) => (
            <li key={item.id}>
              <span>
                {t(
                  item.type === "doska.task.updated" &&
                    item.eventData &&
                    typeof item.eventData === "object" &&
                    "after" in item.eventData &&
                    item.eventData.after &&
                    typeof item.eventData.after === "object" &&
                    "beforeTaskId" in item.eventData.after
                    ? "historyTaskReordered"
                    : (events[item.type] ?? "historyUpdated"),
                )}
              </span>
              {item.type.startsWith("doska.task.attachment.") &&
                (() => {
                  const data = item.eventData as {
                    before?: { filename?: unknown };
                    after?: { filename?: unknown };
                  } | null;
                  const filename =
                    data?.after?.filename ?? data?.before?.filename;
                  return typeof filename === "string" ? (
                    <span className="doska-meta">{filename}</span>
                  ) : null;
                })()}
              <small>
                {item.authorName ?? t("systemEvent")} ·{" "}
                {new Date(item.createdAt).toLocaleString("ru-RU", {
                  timeZone: "Europe/Moscow",
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </small>
              {historyChanges(item, t, fields.data?.fields).length > 0 && (
                <details className="doska-history-changes">
                  <summary>{t("historyChanges")}</summary>
                  <dl>
                    {historyChanges(item, t, fields.data?.fields).map(
                      (change) => (
                        <div key={change.key}>
                          <dt>{change.label}</dt>
                          <dd>
                            <span>{change.before}</span>
                            <span aria-label={t("historyBecame")}>→</span>
                            <span>{change.after}</span>
                          </dd>
                        </div>
                      ),
                    )}
                  </dl>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
      {(page > 0 || history.data?.length === 20) && (
        <div className="doska-pagination">
          <button
            disabled={!page || history.isFetching}
            onClick={() => setPage(page - 1)}
          >
            {t("previous")}
          </button>
          <button
            disabled={history.data?.length !== 20 || history.isFetching}
            onClick={() => setPage(page + 1)}
          >
            {t("next")}
          </button>
        </div>
      )}
    </section>
  );
}
