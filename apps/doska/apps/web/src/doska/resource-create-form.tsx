import "./resource-create.css";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api, type CreateTaskInput, type Column } from "./api";
import { DoskaTaskEditor } from "./task-editor";
import { resourceLinksApi } from "./resource-links-api";
import type { ResourceSelection } from "./resource-links-types";
import {
  knownResourceCreateRejection,
  newResourceCreateAttempt,
  type ResourceCreateAttempt,
} from "./resource-create-state";
export function ResourceCreateForm({
  projectId,
  projectName,
  selection,
  onBack,
}: {
  projectId: string;
  projectName: string;
  selection: ResourceSelection;
  onBack: () => void;
}) {
  const { t } = useTranslation("doska");
  const navigate = useNavigate();
  const attempt = useRef<ResourceCreateAttempt | null>(null);
  const created = useRef<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [sending, setSending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState(false);
  const columns = useQuery({
    queryKey: ["doska", "columns", projectId],
    queryFn: () => api.listColumns(projectId),
  });
  const resource = useQuery({
    queryKey: ["doska", "resource-create-resolve", projectId, selection],
    queryFn: ({ signal }) =>
      resourceLinksApi.resolve(projectId, selection, signal),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const [editorColumns, setEditorColumns] = useState<Column[] | null>(null);
  useEffect(() => {
    if (columns.data && resource.data?.available && !resource.isError)
      setEditorColumns(columns.data);
  }, [columns.data, resource.data, resource.isError]);
  const allowed =
    resource.data?.available === true &&
    !resource.isError &&
    !resource.isFetching &&
    !columns.isError;
  useBlocker({
    shouldBlockFn: () =>
      !created.current &&
      (sending ||
        uncertain ||
        (dirty && !window.confirm(t("resourceDiscardDraft")))),
    enableBeforeUnload: () =>
      !created.current && (dirty || uncertain || sending),
  });
  const finish = () => {
    if (created.current)
      void navigate({
        to: "/projects/$projectId",
        params: { projectId },
        search: { taskId: created.current },
      });
  };
  async function submit(task?: CreateTaskInput) {
    if (!attempt.current) {
      if (!task) return;
      attempt.current = newResourceCreateAttempt(selection, task);
    }
    setSending(true);
    setError(false);
    try {
      const result = await resourceLinksApi.create(projectId, attempt.current);
      created.current = result.taskId;
      attempt.current = null;
      setUncertain(false);
      setDirty(false);
    } catch (error) {
      if (!uncertain && knownResourceCreateRejection(error)) {
        attempt.current = null;
        setUncertain(false);
      } else setUncertain(true);
      setError(true);
      throw error;
    } finally {
      setSending(false);
    }
  }
  const back = () => {
    if (!dirty || window.confirm(t("resourceDiscardDraft"))) onBack();
  };
  return (
    <section className="doska-panel pl-ui-panel doska-resource-create-form">
      <div className="doska-page-heading">
        <h2>{projectName}</h2>
        <button
          className="pl-ui-button pl-ui-button-secondary"
          disabled={sending || uncertain}
          onClick={back}
        >
          {t("resourceChooseAnotherProject")}
        </button>
      </div>
      {uncertain && (
        <p role="alert" className="doska-notice">
          {t("resourceCreateUnknown")}{" "}
          <button
            className="pl-ui-button pl-ui-button-secondary"
            disabled={sending}
            onClick={() =>
              void submit()
                .then(finish)
                .catch(() => {})
            }
          >
            {t(sending ? "saving" : "resourceRetryOriginal")}
          </button>
        </p>
      )}
      {(resource.isPending || columns.isPending) && (
        <p role="status">{t("loading")}</p>
      )}
      {(resource.isError || columns.isError) && (
        <p role="alert">
          {t("resourceCreateLoadError")}{" "}
          <button
            className="pl-ui-button pl-ui-button-secondary"
            onClick={() => {
              void resource.refetch();
              void columns.refetch();
            }}
          >
            {t("retry")}
          </button>
        </p>
      )}
      {resource.data && !resource.data.available && (
        <p>{t("resourceLinksUnavailable")}</p>
      )}
      {editorColumns && (
        <div hidden={!allowed}>
          {allowed && resource.data?.available && (
            <p>
              {t("resourceCreateFor", {
                name: resource.data.descriptor.displayName,
              })}
            </p>
          )}
          {error && !uncertain && (
            <p role="alert" className="doska-error">
              {t("resourceCreateRejected")}
            </p>
          )}
          <DoskaTaskEditor
            projectId={projectId}
            columns={editorColumns}
            initialColumn={
              editorColumns.find((c) => c.semanticState === "planned")?.id ??
              editorColumns[0]?.id
            }
            canWork={!uncertain && !sending && allowed}
            canDelete={false}
            createTask={submit}
            onChanged={finish}
            onClose={() => {}}
            onDirtyChange={setDirty}
          />
        </div>
      )}
    </section>
  );
}
