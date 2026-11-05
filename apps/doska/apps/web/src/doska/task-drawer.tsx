import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type Column } from "./api";
import { DoskaTaskEditor } from "./task-editor";
import { DoskaTemplateSelection } from "./template-selection";
import "./templates.css";
import { DoskaMembersPanel } from "./members-panel";
export function DoskaTaskDrawer({
  projectId,
  taskId,
  initialColumn,
  parentTaskId,
  columns,
  canWork,
  canDelete,
  canManageParticipants = false,
  onClose,
  onChanged,
}: {
  projectId: string;
  taskId?: string;
  initialColumn?: string;
  parentTaskId?: string;
  columns: Column[];
  canWork: boolean;
  canDelete: boolean;
  canManageParticipants?: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation("doska");
  const headingId = useId();
  const client = useQueryClient();
  const [creatingChild, setCreatingChild] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [headerActionsTarget, setHeaderActionsTarget] =
    useState<HTMLDivElement | null>(null);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const markEditing = useCallback(() => {
    dirtyRef.current = true;
  }, []);
  const receiveDirty = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  }, []);
  const [confirmClose, setConfirmClose] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [pending, setPending] = useState(false);
  const [auxiliaryDirty, setAuxiliaryDirty] = useState(false);
  const [closeAfterSave, setCloseAfterSave] = useState(false);
  const saveRef = useRef<(() => Promise<boolean>) | null>(null);
  const receiveSaveState = useCallback(
    (state: {
      save: () => Promise<boolean>;
      auxiliaryDirty: boolean;
      pending: boolean;
      status: string;
    }) => {
      saveRef.current = state.save;
      setPending(state.pending);
      setSaveStatus(state.status);
      setAuxiliaryDirty(state.auxiliaryDirty);
    },
    [],
  );
  const requestClose = () => {
    if (membersOpen) return;
    if (dirtyRef.current) setConfirmClose(true);
    else onClose();
  };
  useEffect(() => {
    if (closeAfterSave && !dirty && !pending) onClose();
  }, [closeAfterSave, dirty, pending, onClose]);
  const outsideDown = useRef(false);
  const outsideClick = useRef(false);
  const isOutside = (event: React.PointerEvent<HTMLDialogElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return (
      event.target === event.currentTarget &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    );
  };
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = requestClose;
  const task = useQuery({
    queryKey: ["doska", "task", projectId, taskId],
    queryFn: () => api.getTask(projectId, taskId!),
    enabled: Boolean(taskId),
  });
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    if (!creatingChild) dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [creatingChild]);
  return (
    <>
      <dialog
        ref={ref}
        className="doska-dialog doska-task-drawer"
        aria-labelledby={headingId}
        onPointerDown={(event) => {
          outsideDown.current = isOutside(event);
          outsideClick.current = false;
        }}
        onPointerUp={(event) => {
          outsideClick.current = outsideDown.current && isOutside(event);
          outsideDown.current = false;
        }}
        onPointerCancel={() => {
          outsideDown.current = false;
          outsideClick.current = false;
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (outsideClick.current) {
            outsideClick.current = false;
            requestClose();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeRef.current();
          }
        }}
        onCancel={(event) => {
          event.preventDefault();
          closeRef.current();
        }}
      >
        <header className="doska-drawer-heading">
          <h2 id={headingId}>
            {taskId
              ? t("task") +
                (task.data?.number == null ? "" : ` #${task.data.number}`)
              : t("newTask")}
          </h2>
          {taskId && (
            <span role="status" className="doska-save-state">
              {saveStatus ? t(saveStatus) : ""}
            </span>
          )}
          <div
            ref={setHeaderActionsTarget}
            inert={confirmClose}
            className="doska-task-header-actions"
          />
          <button
            className="doska-icon"
            aria-label={t("close")}
            onClick={requestClose}
          >
            <X size={20} />
          </button>
        </header>
        {confirmClose && (
          <div className="doska-close-confirm" role="alert">
            <p>
              {t(
                auxiliaryDirty
                  ? "taskAuxiliaryDraftPrompt"
                  : "taskDiscardPrompt",
              )}
            </p>
            {!auxiliaryDirty && (
              <button
                type="button"
                className="doska-primary"
                disabled={pending || closeAfterSave}
                onClick={async () => {
                  setCloseAfterSave(true);
                  if (!(await saveRef.current?.())) setCloseAfterSave(false);
                }}
              >
                {t(pending ? "saving" : "taskSaveAndClose")}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setConfirmClose(false);
                setCloseAfterSave(false);
              }}
            >
              {t("taskKeepEditing")}
            </button>
            <button
              type="button"
              disabled={pending || closeAfterSave}
              onClick={onClose}
            >
              {t("taskDiscard")}
            </button>
          </div>
        )}
        {taskId && task.isPending ? (
          <p role="status">{t("loading")}</p>
        ) : taskId && task.isError && !task.data ? (
          <div className="doska-notice doska-error" role="alert">
            <p>{t("loadError")}</p>
            <button onClick={() => void task.refetch()}>{t("retry")}</button>
          </div>
        ) : (
          <div inert={confirmClose}>
            <DoskaTaskEditor
              key={taskId ?? "new"}
              headerActionsTarget={headerActionsTarget}
              formId={`${headingId}-form`}
              footerSelection={
                taskId &&
                task.data &&
                !task.data.archivedAt &&
                canManageParticipants ? (
                  <DoskaTemplateSelection
                    projectId={projectId}
                    taskId={taskId}
                  />
                ) : undefined
              }
              onDirtyChange={receiveDirty}
              onEditStart={markEditing}
              onSaveState={receiveSaveState}
              pauseAutosave={confirmClose}
              projectId={projectId}
              task={task.data}
              initialColumn={initialColumn}
              parentTaskId={parentTaskId}
              onCreateSubtask={() => setCreatingChild(true)}
              columns={columns}
              canWork={canWork}
              canDelete={canDelete}
              canManageParticipants={canManageParticipants}
              onManageParticipants={() => setMembersOpen(true)}
              onClose={onClose}
              onChanged={onChanged}
            />
          </div>
        )}
      </dialog>
      {creatingChild && taskId && (
        <DoskaTaskDrawer
          projectId={projectId}
          parentTaskId={taskId}
          initialColumn={
            [...columns]
              .sort((a, b) => a.position - b.position)
              .find((column) => column.semanticState === "planned")?.id ??
            columns[0]?.id
          }
          columns={columns}
          canWork={canWork}
          canDelete={false}
          canManageParticipants={canManageParticipants}
          onClose={() => setCreatingChild(false)}
          onChanged={() => {
            void client.invalidateQueries({
              queryKey: ["doska", "subtasks", projectId, taskId],
            });
            onChanged();
          }}
        />
      )}
      {membersOpen && (
        <DoskaMembersPanel
          projectId={projectId}
          onClose={() => setMembersOpen(false)}
        />
      )}
    </>
  );
}
