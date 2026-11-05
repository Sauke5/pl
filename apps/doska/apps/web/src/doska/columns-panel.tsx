import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { SortableColumnRow } from "./column-sortable-row";
import { api, ApiError } from "./api";
import "./columns-panel.css";

type Semantic = "planned" | "active" | "completed";
type Draft = {
  kind: "create" | "edit" | "delete";
  id?: string;
  name: string;
  semanticState: Semantic;
  destinationColumnId: string;
  revision: number;
};
type Action =
  | { kind: "draft"; draft: Draft; confirmIncompleteSubtasks?: boolean }
  | { kind: "reorder"; columnIds: string[]; revision: number };

export function DoskaColumnsPanel({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("doska");
  const cache = useQueryClient();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmation, setConfirmation] = useState<Action | null>(null);
  const [conflict, setConflict] = useState(false);
  const snapshot = useQuery({
    queryKey: ["doska", "column-settings", projectId],
    queryFn: async () => {
      const project = await api.getProject(projectId);
      const [columns, access] = await Promise.all([
        api.listColumns(projectId),
        api.getAccess(projectId),
      ]);
      return { project, columns, access };
    },
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  const mutation = useMutation({
    mutationFn: async (action: Action) => {
      if (action.kind === "reorder")
        return api.reorderColumns(projectId, {
          expectedRevision: action.revision,
          columnIds: action.columnIds,
        });
      const value = action.draft;
      const expectedRevision = value.revision;
      if (value.kind === "delete")
        return api.deleteColumn(projectId, value.id!, {
          expectedRevision,
          destinationColumnId: value.destinationColumnId,
          confirmIncompleteSubtasks: action.confirmIncompleteSubtasks,
        });
      const body = {
        expectedRevision,
        name: value.name.trim(),
        semanticState: value.semanticState,
      };
      return value.kind === "create"
        ? api.createColumn(projectId, body)
        : api.updateColumn(projectId, value.id!, {
            ...body,
            confirmIncompleteSubtasks: action.confirmIncompleteSubtasks,
          });
    },
    onSuccess: async () => {
      setDraft(null);
      setConfirmation(null);
      setConflict(false);
      await snapshot.refetch();
      await cache.invalidateQueries({ queryKey: ["doska"] });
    },
    onError: (error, action) => {
      setConfirmation(null);
      if (error instanceof ApiError && error.status === 409) {
        if (error.message.includes("незавершённые подзадачи"))
          setConfirmation(action);
        else {
          setConfirmation(null);
          setConflict(true);
        }
      }
    },
  });
  const data = snapshot.data;
  const editable = Boolean(
    data?.access.manageSettings && !data.project.archivedAt,
  );
  const busy = mutation.isPending || snapshot.isFetching;
  const displayedColumns =
    data && mutation.isPending && mutation.variables?.kind === "reorder"
      ? mutation.variables.columnIds.flatMap((id) =>
          data.columns.filter((column) => column.id === id),
        )
      : (data?.columns ?? []);
  const refresh = async () => {
    const result = await snapshot.refetch();
    if (result.isSuccess) {
      // Only an explicit refresh advances a conflicting draft's compare-and-swap revision.
      setDraft((value) =>
        value ? { ...value, revision: result.data.project.revision } : null,
      );
      setConflict(false);
      setConfirmation(null);
      mutation.reset();
    }
  };
  const start = (value: Draft) => {
    setDraft(value);
    setConfirmation(null);
    mutation.reset();
  };
  const cancel = () => {
    setDraft(null);
    setConfirmation(null);
    mutation.reset();
  };
  const missingColumn = Boolean(
    draft?.id && data && !data.columns.some((column) => column.id === draft.id),
  );
  return (
    <dialog
      ref={dialog}
      className="doska-dialog doska-columns-panel"
      aria-labelledby="doska-columns-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="doska-drawer-heading">
        <h2 id="doska-columns-heading">{t("columnsSettings")}</h2>
        <button
          className="doska-icon"
          aria-label={t("close")}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      {snapshot.isPending && <p role="status">{t("loading")}</p>}
      {snapshot.isError && (
        <div className="doska-notice doska-error" role="alert">
          <p>{t("loadError")}</p>
          <button disabled={busy} onClick={() => void refresh()}>
            {t("retry")}
          </button>
        </div>
      )}
      {data && (
        <>
          {!editable && (
            <p className="doska-notice">
              {t(
                data.project.archivedAt
                  ? "archivedProject"
                  : "columnsOwnerOnly",
              )}
            </p>
          )}
          <p className="doska-meta">{t("columnsSemanticHint")}</p>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            accessibility={{
              screenReaderInstructions: {
                draggable: t("columnDragInstructions"),
              },
              announcements: {
                onDragStart: () => t("columnDragStarted"),
                onDragOver: ({ over }) =>
                  over
                    ? data.columns.find((column) => column.id === over.id)?.name
                    : t("dragOutside"),
                onDragEnd: ({ over }) =>
                  t(over ? "dragReleased" : "dragCancelled"),
                onDragCancel: () => t("dragCancelled"),
              },
            }}
            onDragEnd={({ active, over }) => {
              if (
                !editable ||
                busy ||
                draft ||
                conflict ||
                !over ||
                active.id === over.id
              )
                return;
              const from = data.columns.findIndex(
                (column) => column.id === active.id,
              );
              const to = data.columns.findIndex(
                (column) => column.id === over.id,
              );
              if (from < 0 || to < 0) return;
              mutation.mutate({
                kind: "reorder",
                columnIds: arrayMove(
                  data.columns.map((column) => column.id),
                  from,
                  to,
                ),
                revision: data.project.revision,
              });
            }}
          >
            <SortableContext
              items={displayedColumns.map((column) => column.id)}
              strategy={verticalListSortingStrategy}
            >
              <ol className="doska-column-settings-list">
                {displayedColumns.map((column) => (
                  <SortableColumnRow
                    key={column.id}
                    id={column.id}
                    disabled={!editable || busy || !!draft || conflict}
                    label={t("columnDragNamed", { name: column.name })}
                    title={
                      <>
                        <strong>{column.name}</strong>
                        <span className="doska-meta">
                          {t(
                            `columnState_${column.semanticState ?? "planned"}`,
                          )}
                        </span>
                      </>
                    }
                  >
                    {editable && (
                      <div className="doska-column-controls">
                        <button
                          disabled={busy || !!draft || conflict}
                          aria-label={t("columnEditNamed", {
                            name: column.name,
                          })}
                          onClick={() =>
                            start({
                              kind: "edit",
                              id: column.id,
                              name: column.name,
                              semanticState: column.semanticState ?? "planned",
                              destinationColumnId: "",
                              revision: data.project.revision,
                            })
                          }
                        >
                          {t("columnEdit")}
                        </button>
                        <button
                          disabled={
                            busy ||
                            !!draft ||
                            conflict ||
                            data.columns.length === 1
                          }
                          title={
                            data.columns.length === 1
                              ? t("columnLastRequired")
                              : undefined
                          }
                          aria-label={t("columnDeleteNamed", {
                            name: column.name,
                          })}
                          onClick={() =>
                            start({
                              kind: "delete",
                              id: column.id,
                              name: column.name,
                              semanticState: column.semanticState ?? "planned",
                              destinationColumnId: "",
                              revision: data.project.revision,
                            })
                          }
                        >
                          {t("columnDelete")}
                        </button>
                      </div>
                    )}
                  </SortableColumnRow>
                ))}
              </ol>
            </SortableContext>
          </DndContext>
          {!data.columns.length && <p>{t("noColumns")}</p>}
          {editable && !draft && (
            <button
              disabled={busy || conflict}
              onClick={() =>
                start({
                  kind: "create",
                  name: "",
                  semanticState: "planned",
                  destinationColumnId: "",
                  revision: data.project.revision,
                })
              }
            >
              {t("columnAdd")}
            </button>
          )}
          {draft && (
            <form
              className="doska-column-editor"
              onSubmit={(event) => {
                event.preventDefault();
                if (editable && !conflict && !missingColumn)
                  mutation.mutate({ kind: "draft", draft });
              }}
            >
              <h3>
                {t(
                  draft.kind === "delete"
                    ? "columnDeleteHeading"
                    : draft.kind === "create"
                      ? "columnAdd"
                      : "columnEditHeading",
                  { name: draft.name },
                )}
              </h3>
              <fieldset
                disabled={
                  !editable ||
                  busy ||
                  conflict ||
                  missingColumn ||
                  !!confirmation
                }
              >
                {draft.kind === "delete" ? (
                  <>
                    <p>{t("columnDeleteHint")}</p>
                    <label className="doska-field">
                      {t("columnDestination")}
                      <select
                        required
                        value={draft.destinationColumnId}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            destinationColumnId: event.target.value,
                          })
                        }
                      >
                        <option value="">{t("columnChooseDestination")}</option>
                        {data.columns
                          .filter((column) => column.id !== draft.id)
                          .map((column) => (
                            <option key={column.id} value={column.id}>
                              {column.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  </>
                ) : (
                  <>
                    <label className="doska-field">
                      {t("columnName")}
                      <input
                        required
                        maxLength={100}
                        value={draft.name}
                        onChange={(event) =>
                          setDraft({ ...draft, name: event.target.value })
                        }
                      />
                    </label>
                    <label className="doska-field">
                      {t("columnSemantic")}
                      <select
                        value={draft.semanticState}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            semanticState: event.target.value as Semantic,
                          })
                        }
                      >
                        {(["planned", "active", "completed"] as const).map(
                          (state) => (
                            <option key={state} value={state}>
                              {t(`columnState_${state}`)}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                  </>
                )}
              </fieldset>
              <div className="doska-column-editor-actions">
                <button
                  className="doska-primary"
                  type="submit"
                  disabled={
                    !editable ||
                    busy ||
                    conflict ||
                    missingColumn ||
                    !!confirmation ||
                    !draft.name.trim() ||
                    (draft.kind === "delete" &&
                      !data.columns.some(
                        (column) =>
                          column.id !== draft.id &&
                          column.id === draft.destinationColumnId,
                      ))
                  }
                >
                  {t(
                    busy
                      ? "saving"
                      : draft.kind === "delete"
                        ? "columnDeleteAndMove"
                        : "save",
                  )}
                </button>
                <button type="button" disabled={busy} onClick={cancel}>
                  {t("cancel")}
                </button>
              </div>
              {missingColumn && <p role="alert">{t("columnNoLongerExists")}</p>}
            </form>
          )}
        </>
      )}
      {conflict && (
        <div className="doska-notice doska-error" role="alert">
          <p>{t("columnsConflict")}</p>
          <button disabled={busy} onClick={() => void refresh()}>
            {t("columnsRefresh")}
          </button>
        </div>
      )}
      {mutation.isError && !conflict && !confirmation && (
        <p className="doska-error" role="alert">
          {t(
            mutation.error instanceof ApiError && mutation.error.status === 403
              ? "columnsForbidden"
              : "saveError",
          )}
        </p>
      )}
      {confirmation && (
        <div className="doska-notice" role="alert">
          <p>{t("columnsIncompleteSubtasks")}</p>
          <button
            disabled={busy || !editable}
            onClick={() => {
              if (confirmation.kind === "draft")
                mutation.mutate({
                  ...confirmation,
                  confirmIncompleteSubtasks: true,
                });
            }}
          >
            {t("columnsConfirmCompletion")}
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setConfirmation(null);
              mutation.reset();
            }}
          >
            {t("cancel")}
          </button>
        </div>
      )}
    </dialog>
  );
}
