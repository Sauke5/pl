import { DoskaTaskResourceLinks } from "./task-resource-links";
import { DoskaTaskColorPicker } from "./task-color-picker";
import { DoskaTaskLabels } from "./task-labels";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "./task-editor.css";
import { MoreHorizontal } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  api,
  ApiError,
  type Column,
  type Task,
  type CreateTaskInput,
} from "./api";
import { DoskaTaskDescription } from "./task-description";
import { DoskaTaskCustomFields } from "./task-custom-fields";
import { fieldEmpty, fieldValue, type CustomValues } from "./custom-fields";
import { DoskaTaskHistory } from "./task-history";
import { DoskaTaskComments } from "./task-comments";
import { DoskaTaskSubtasks } from "./task-subtasks";
import { DoskaTaskRelations } from "./task-relations";
import { DoskaTaskAttachments } from "./task-attachments";
import { DoskaTaskChecklists } from "./task-checklists";
function datePart(value: string | null, time = false) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const get = (key: string) =>
    parts.find((part) => part.type === key)?.value ?? "";
  return time
    ? `${get("hour")}:${get("minute")}`
    : `${get("year")}-${get("month")}-${get("day")}`;
}
function taskDraft(task?: Task, column = "") {
  return {
    title: task?.title ?? "",
    description: task?.description ?? "",
    columnId: task?.columnId ?? column,
    priority: (task?.priority as CreateTaskInput["priority"]) ?? "no-priority",
    cardColor: task?.cardColor ?? null,
    labels: task?.labels ?? [],
    customValues: [...(task?.customValues ?? [])].sort((a, b) =>
      a.fieldId.localeCompare(b.fieldId),
    ) as CustomValues,
    userId: task?.userId ?? "",
    coexecutors: task?.coexecutorIds ?? [],
    startDate: datePart(task?.startDate ?? null),
    dueDate: datePart(task?.dueDate ?? null),
    dueTime: task?.dueDateHasTime ? datePart(task.dueDate, true) : "",
  };
}
export function DoskaTaskEditor({
  projectId,
  task,
  initialColumn,
  parentTaskId,
  onCreateSubtask,
  createTask,
  columns,
  canWork,
  canDelete,
  canManageParticipants = false,
  onManageParticipants,
  onClose,
  onChanged,
  onDirtyChange,
  onEditStart,
  onSaveState,
  pauseAutosave = false,
  headerActionsTarget,
  footerSelection,
  formId = "doska-task-edit-form",
}: {
  projectId: string;
  task?: Task;
  initialColumn?: string;
  parentTaskId?: string;
  onCreateSubtask?: () => void;
  createTask?: (input: CreateTaskInput) => Promise<Task | void>;
  columns: Column[];
  canWork: boolean;
  canDelete: boolean;
  canManageParticipants?: boolean;
  onManageParticipants?: () => void;
  onClose: () => void;
  onChanged: () => void;
  headerActionsTarget?: HTMLElement | null;
  footerSelection?: ReactNode;
  formId?: string;
  pauseAutosave?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onEditStart?: () => void;
  onSaveState?: (state: {
    save: () => Promise<boolean>;
    auxiliaryDirty: boolean;
    pending: boolean;
    status: string;
  }) => void;
}) {
  const { t } = useTranslation("doska");
  const [draft, setDraft] = useState(() =>
    taskDraft(task, initialColumn ?? columns[0]?.id),
  );
  const [baseline, setBaseline] = useState(draft);
  const [revision, setRevision] = useState(task?.revision);
  const [showDueTime, setShowDueTime] = useState(Boolean(task?.dueDateHasTime));
  const [titleTouched, setTitleTouched] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [labelDirty, setLabelDirty] = useState(false);
  const [commentDirty, setCommentDirty] = useState(false);
  const [checklistDirty, setChecklistDirty] = useState(false);
  const [resourceLinksDirty, setResourceLinksDirty] = useState(false);
  const [attachmentDirty, setAttachmentDirty] = useState(false);
  const [relationDirty, setRelationDirty] = useState(false);
  const [subtaskDirty, setSubtaskDirty] = useState(false);
  const actionMenuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const menu = actionMenuRef.current;
      if (
        !menu?.open ||
        !(event.target instanceof Node) ||
        menu.contains(event.target)
      )
        return;
      menu.open = false;
      const dialog = menu.closest("dialog");
      if (dialog && (event.target === dialog || !dialog.contains(event.target)))
        event.stopPropagation();
    };
    const escape = (event: KeyboardEvent) => {
      const menu = actionMenuRef.current;
      if (event.key !== "Escape" || !menu?.open) return;
      event.preventDefault();
      event.stopPropagation();
      menu.open = false;
      menu.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, []);

  const {
    title,
    description,
    columnId,
    priority,
    cardColor,
    customValues,
    userId,
    coexecutors,
    startDate,
    dueDate,
    dueTime,
  } = draft;
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const field = <K extends keyof typeof draft>(
    key: K,
    value: (typeof draft)[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));
  useEffect(() => {
    if (!task || task.revision <= (revision ?? -1)) return;
    const incoming = taskDraft(task);
    // Comments/checklists advance the task revision, but do not change editable fields.
    // A dirty draft may advance only when its entire server baseline is unchanged.
    if (!dirty || JSON.stringify(incoming) === JSON.stringify(baseline)) {
      setRevision(task.revision);
      setBaseline(incoming);
      if (!dirty) setDraft(incoming);
    }
  }, [task, revision, dirty, baseline]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmSubtasks, setConfirmSubtasks] = useState(false);
  const projectFields = useQuery({
    queryKey: ["doska", "project-fields", projectId],
    queryFn: () => api.getProjectFields(projectId),
  });
  const roster = useQuery({
    queryKey: ["doska", "members", projectId],
    queryFn: () => api.listMembers(projectId),
  });
  const people = roster.data
    ? [
        roster.data.owner,
        ...roster.data.members.filter(
          (member) => member.role === "participant",
        ),
      ]
    : [];
  const editable = canWork && !task?.archivedAt;
  const busy = useRef(false);
  type SaveAction = "save" | "archive" | "delete" | "complete";
  const mutation = useMutation({
    mutationFn: async ({
      action,
      submitted,
      expectedRevision,
      previous,
    }: {
      action: SaveAction;
      submitted: typeof draft;
      previous: typeof draft;
      expectedRevision: number | undefined;
    }) => {
      const {
        title,
        description,
        columnId,
        priority,
        cardColor,
        customValues,
        labels,
        startDate,
        dueDate,
        dueTime,
        userId,
        coexecutors,
      } = submitted;
      if (action === "delete" && task) {
        await api.deleteTask(projectId, task.id, {
          expectedRevision: expectedRevision!,
        });
        return null;
      }
      if (action === "archive" && task)
        return api.archiveTask(projectId, task.id, {
          expectedRevision: expectedRevision!,
          archived: !task.archivedAt,
        });
      const body: CreateTaskInput = {
        title: title.trim(),
        description: description || null,
        ...(columnId ? { columnId } : {}),
        priority,
        cardColor,
        labels,
        startDate: startDate || null,
        due: dueDate
          ? { date: dueDate, ...(dueTime ? { time: dueTime } : {}) }
          : null,
      };
      // An unavailable roster must not clear existing assignments.
      if (roster.data) {
        body.userId = userId || null;
        body.coexecutorIds = coexecutors;
      }
      body.customValues = task
        ? customValues.filter(
            (value) =>
              value.value !==
              (previous.customValues.find(
                (item) => item.fieldId === value.fieldId,
              )?.value ?? null),
          )
        : customValues;
      if (task) {
        const changed = (key: keyof typeof draft) =>
          JSON.stringify(submitted[key]) !== JSON.stringify(previous[key]);
        if (!changed("title")) delete (body as Partial<CreateTaskInput>).title;
        if (!changed("description")) delete body.description;
        if (!changed("columnId")) delete body.columnId;
        if (!changed("priority")) delete body.priority;
        if (!changed("cardColor")) delete body.cardColor;
        if (!changed("labels")) delete body.labels;
        if (!changed("startDate")) delete body.startDate;
        if (!changed("dueDate") && !changed("dueTime")) delete body.due;
        if (!changed("userId")) delete body.userId;
        if (!changed("coexecutors")) delete body.coexecutorIds;
      }
      return task
        ? api.updateTask(projectId, task.id, {
            ...body,
            expectedRevision: expectedRevision!,
            ...(action === "complete"
              ? { confirmIncompleteSubtasks: true }
              : {}),
          })
        : (
            createTask ??
            ((input: CreateTaskInput) => api.createTask(projectId, input))
          )({
            ...body,
            ...(parentTaskId ? { parentTaskId } : {}),
          });
    },
    onSuccess: (result, { action, submitted }) => {
      setConfirmSubtasks(false);
      if (action === "delete" || action === "archive" || !task) {
        onChanged();
        onClose();
        return;
      }
      if (result) {
        const saved = taskDraft(result);
        // Keep edits typed while this request was in flight. Only normalize fields
        // that still match the submitted snapshot.
        setDraft(
          (current) =>
            Object.fromEntries(
              Object.entries(current).map(([key, value]) => [
                key,
                JSON.stringify(value) ===
                JSON.stringify(submitted[key as keyof typeof submitted])
                  ? saved[key as keyof typeof saved]
                  : value,
              ]),
            ) as typeof draft,
        );
        setBaseline(saved);
        setRevision(result.revision);
      }
      onChanged();
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.message.includes("незавершённые подзадачи")
      )
        setConfirmSubtasks(true);
    },
  });
  const requiredKeys = projectFields.data?.requiredTaskFields ?? [];
  const standardValue = (
    value: typeof draft,
    key: (typeof requiredKeys)[number],
  ) =>
    key === "due"
      ? value.dueDate
      : key === "priority"
        ? value.priority === "no-priority"
          ? ""
          : value.priority
        : value[key];
  const missingStandard = requiredKeys.filter(
    (key) =>
      !standardValue(draft, key).trim() &&
      (!task || Boolean(standardValue(baseline, key).trim())),
  );
  const missingCustom = (projectFields.data?.fields ?? []).filter(
    (definition) =>
      !definition.archivedAt &&
      definition.required &&
      fieldEmpty(definition, fieldValue(definition, customValues, !task)) &&
      (!task ||
        !fieldEmpty(
          definition,
          fieldValue(definition, baseline.customValues, false),
        )),
  );
  const valid =
    Boolean(title.trim()) &&
    (!dueDate || !startDate || dueDate >= startDate) &&
    projectFields.isSuccess &&
    !missingStandard.length &&
    !missingCustom.length;
  const standardLabels = {
    description: "description",
    userId: "responsible",
    priority: "priority",
    startDate: "startDate",
    due: "dueDate",
  } as const;
  const requiredLabel = (key: keyof typeof standardLabels) =>
    `${t(standardLabels[key])}${requiredKeys.includes(key) ? " *" : ""}`;
  const save = async (action: SaveAction = "save") => {
    if (busy.current || mutation.isPending || (action === "save" && !valid))
      return false;
    if (action === "save" && task && !dirty) return true;
    busy.current = true;
    try {
      await mutation.mutateAsync({
        action,
        submitted: draft,
        previous: baseline,
        expectedRevision: revision,
      });
      return true;
    } catch {
      return false;
    } finally {
      busy.current = false;
    }
  };
  const saveStatus = mutation.isPending
    ? "saving"
    : mutation.isError
      ? "saveError"
      : dirty
        ? "taskUnsaved"
        : mutation.isSuccess
          ? "taskSaved"
          : "";
  const saveCurrent = useRef(save);
  saveCurrent.current = save;
  useLayoutEffect(() => {
    onSaveState?.({
      save: () => save(),
      auxiliaryDirty:
        labelDirty ||
        commentDirty ||
        checklistDirty ||
        attachmentDirty ||
        resourceLinksDirty ||
        relationDirty ||
        subtaskDirty,
      pending: mutation.isPending,
      status: saveStatus,
    });
  });
  useEffect(() => {
    if (
      !task ||
      pauseAutosave ||
      !editable ||
      !dirty ||
      !valid ||
      mutation.isPending ||
      mutation.isError ||
      confirmSubtasks ||
      labelDirty ||
      commentDirty ||
      checklistDirty ||
      attachmentDirty ||
      resourceLinksDirty ||
      relationDirty ||
      subtaskDirty
    )
      return;
    const timer = window.setTimeout(() => {
      void saveCurrent.current();
    }, 650);
    return () => window.clearTimeout(timer);
  }, [
    task,
    pauseAutosave,
    editable,
    dirty,
    valid,
    draft,
    revision,
    mutation.isPending,
    mutation.isError,
    confirmSubtasks,
    labelDirty,
    commentDirty,
    checklistDirty,
    attachmentDirty,
    resourceLinksDirty,
    relationDirty,
    subtaskDirty,
  ]);
  useLayoutEffect(() => {
    onDirtyChange?.(
      dirty ||
        labelDirty ||
        commentDirty ||
        checklistDirty ||
        attachmentDirty ||
        resourceLinksDirty ||
        relationDirty ||
        subtaskDirty ||
        mutation.isPending,
    );
  });
  const errorKey =
    mutation.error instanceof ApiError
      ? mutation.error.status === 409
        ? "taskConflict"
        : mutation.error.status === 403
          ? "taskForbidden"
          : "saveError"
      : "saveError";
  const actionMenu =
    task && (canWork || canDelete) ? (
      <details ref={actionMenuRef} className="doska-task-action-menu">
        <summary aria-label={t("taskActions")}>
          <MoreHorizontal size={18} />
        </summary>
        <div>
          {canWork && (
            <button
              type="button"
              disabled={mutation.isPending || dirty}
              title={dirty ? t("taskSaveFirst") : undefined}
              onClick={() => {
                if (actionMenuRef.current) actionMenuRef.current.open = false;
                void save("archive");
              }}
            >
              {t(task.archivedAt ? "restoreTask" : "archiveTask")}
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={(event) => {
                setConfirmDelete(true);
                event.currentTarget.closest("details")?.removeAttribute("open");
              }}
            >
              {t("deleteTask")}
            </button>
          )}
        </div>
      </details>
    ) : null;
  return (
    <div
      className="doska-task-editor-content"
      onInputCapture={onEditStart}
      onChangeCapture={onEditStart}
    >
      {task && !headerActionsTarget && (
        <div className="doska-task-editor-toolbar">
          {!onSaveState && (
            <span role="status" className="doska-save-state">
              {saveStatus ? t(saveStatus) : ""}
            </span>
          )}
          {actionMenu}
        </div>
      )}
      {headerActionsTarget &&
        createPortal(
          <>
            <DoskaTaskColorPicker
              value={cardColor}
              disabled={!editable || mutation.isPending}
              onChange={(color) => field("cardColor", color)}
            />
            {actionMenu}
          </>,
          headerActionsTarget,
        )}
      {task?.archivedAt && <p className="doska-notice">{t("archivedTask")}</p>}
      {task && canDelete && confirmDelete && (
        <div className="doska-notice" role="alert">
          <p>{t("deleteTaskConfirm")}</p>
          <button
            disabled={mutation.isPending}
            onClick={() => void save("delete")}
          >
            {t("deletePermanently")}
          </button>
          <button
            disabled={mutation.isPending}
            onClick={() => setConfirmDelete(false)}
          >
            {t("cancel")}
          </button>
        </div>
      )}
      <form
        className="doska-task-editor"
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={!editable} className="doska-task-fields">
          <label
            className={`doska-field doska-task-title-field${!task ? " is-new" : ""}`}
          >
            <span>{t("taskTitle")}</span>
            <input
              autoFocus={!task}
              required
              placeholder={t("taskTitlePlaceholder")}
              aria-invalid={(titleTouched && !title.trim()) || undefined}
              aria-describedby={
                titleTouched && !title.trim()
                  ? `${formId}-title-error`
                  : undefined
              }
              onBlur={() => setTitleTouched(true)}
              maxLength={500}
              value={title}
              onChange={(e) => field("title", e.target.value)}
            />
          </label>
          {titleTouched && !title.trim() && (
            <p id={`${formId}-title-error`} className="doska-field-error">
              {t("taskTitleRequired")}
            </p>
          )}
          <DoskaTaskDescription
            value={description}
            label={requiredLabel("description")}
            editable={Boolean(editable)}
            onChange={(value) => field("description", value)}
          />
          <DoskaTaskLabels
            projectId={projectId}
            value={draft.labels}
            onDirtyChange={setLabelDirty}
            editable={Boolean(editable)}
            onChange={(value) => field("labels", value)}
          />
          <details className="doska-task-properties" open={!task || undefined}>
            <summary>
              <span>{t("taskProperties")}</span>
              <span className="doska-property-summary">
                {columns.find((column) => column.id === columnId)?.name ??
                  t("withoutColumn")}{" "}
                · {t(`priority_${priority}`)}
              </span>
            </summary>
            <div className="doska-task-field-grid">
              <label className="doska-field">
                {t("column")}
                <select
                  value={columnId}
                  onChange={(e) => field("columnId", e.target.value)}
                >
                  {!columnId && <option value="">{t("withoutColumn")}</option>}
                  {columns.map((column) => (
                    <option key={column.id} value={column.id}>
                      {column.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="doska-field">
                {requiredLabel("priority")}
                <select
                  value={priority}
                  onChange={(e) =>
                    field(
                      "priority",
                      e.target.value as NonNullable<
                        CreateTaskInput["priority"]
                      >,
                    )
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
            </div>
            {!headerActionsTarget && (
              <fieldset className="doska-task-color-field">
                <legend>{t("cardColor")}</legend>
                <div className="doska-task-color-palette">
                  {(
                    [
                      null,
                      "blue",
                      "cyan",
                      "green",
                      "yellow",
                      "orange",
                      "red",
                      "pink",
                      "purple",
                    ] as const
                  ).map((color) => (
                    <label
                      key={color ?? "default"}
                      className={`doska-color-option doska-color-${color ?? "default"}`}
                      title={t(`cardColor_${color ?? "default"}`)}
                    >
                      <input
                        type="radio"
                        name={`task-card-color-${task?.id ?? "new"}`}
                        value={color ?? ""}
                        checked={cardColor === color}
                        onChange={() => field("cardColor", color)}
                      />
                      <span>{t(`cardColor_${color ?? "default"}`)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <div className="doska-task-field-grid doska-task-owner-row">
              <label className="doska-field">
                {requiredLabel("userId")}
                <select
                  value={userId}
                  disabled={!roster.data}
                  onChange={(e) => {
                    setDraft((current) => ({
                      ...current,
                      userId: e.target.value,
                      coexecutors: current.coexecutors.filter(
                        (id) => id !== e.target.value,
                      ),
                    }));
                  }}
                >
                  <option value="">{t("unassigned")}</option>
                  {userId &&
                    !people.some((person) => person.userId === userId) && (
                      <option value={userId}>{t("unavailableMember")}</option>
                    )}
                  {people.map((person) => (
                    <option key={person.userId} value={person.userId}>
                      {person.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="doska-task-participants-hint">
              <span>{t("taskParticipantAssignment")}</span>
              {canManageParticipants && onManageParticipants && (
                <button type="button" onClick={onManageParticipants}>
                  {t("taskProjectParticipants")}
                </button>
              )}
            </div>
            <div className="doska-task-field-grid doska-task-dates-row">
              <label className="doska-field">
                {requiredLabel("startDate")}
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => field("startDate", e.target.value)}
                />
              </label>
              <div className="doska-task-due-field">
                <label className="doska-field">
                  {requiredLabel("due")}
                  <input
                    type="date"
                    min={startDate || undefined}
                    value={dueDate}
                    onChange={(e) => field("dueDate", e.target.value)}
                  />
                </label>
                {showDueTime || dueTime ? (
                  <label className="doska-field doska-task-time-field">
                    {t("dueTimeMoscow")}
                    <input
                      type="time"
                      disabled={!dueDate}
                      value={dueTime}
                      onChange={(e) => field("dueTime", e.target.value)}
                    />
                  </label>
                ) : (
                  <button
                    type="button"
                    className="doska-add-due-time"
                    disabled={!dueDate}
                    onClick={() => setShowDueTime(true)}
                  >
                    {t("taskAddTime")}
                  </button>
                )}
              </div>
            </div>
            {projectFields.isPending ? (
              <p role="status" className="doska-task-participants-hint">
                {t("loading")}
              </p>
            ) : projectFields.isError ? (
              <p role="alert" className="doska-task-participants-hint">
                {t("customFieldsLoadError")}{" "}
                <button
                  type="button"
                  onClick={() => void projectFields.refetch()}
                >
                  {t("retry")}
                </button>
              </p>
            ) : (
              <DoskaTaskCustomFields
                fields={projectFields.data.fields}
                values={customValues}
                baseline={baseline.customValues}
                creating={!task}
                people={people}
                onChange={(values) => field("customValues", values)}
              />
            )}
            <details className="doska-task-people">
              <summary>
                {t("coexecutors")}{" "}
                {coexecutors.length > 0 && <span>{coexecutors.length}</span>}
              </summary>
              <fieldset className="doska-coexecutors" disabled={!roster.data}>
                <legend>{t("coexecutors")}</legend>
                {people
                  .filter((person) => person.userId !== userId)
                  .map((person) => (
                    <label key={person.userId}>
                      <input
                        type="checkbox"
                        checked={coexecutors.includes(person.userId)}
                        onChange={(e) =>
                          field(
                            "coexecutors",
                            e.target.checked
                              ? [...coexecutors, person.userId]
                              : coexecutors.filter(
                                  (id) => id !== person.userId,
                                ),
                          )
                        }
                      />
                      {person.name}
                    </label>
                  ))}
                {!people.length && (
                  <span className="doska-meta">{t("noMembers")}</span>
                )}
              </fieldset>
            </details>
          </details>
        </fieldset>
        {roster.isError && (
          <div className="doska-notice doska-error" role="alert">
            {t("membersLoadError")}{" "}
            <button type="button" onClick={() => void roster.refetch()}>
              {t("retry")}
            </button>
          </div>
        )}
        {(missingStandard.length > 0 || missingCustom.length > 0) && (
          <p className="doska-field-error" role="status">
            {t("customFieldsRequiredMissing", {
              fields: [
                ...missingStandard.map((key) => t(standardLabels[key])),
                ...missingCustom.map((definition) => definition.name),
              ].join(", "),
            })}
          </p>
        )}
        {mutation.isError && !confirmSubtasks && (
          <div className="doska-notice doska-error" role="alert">
            {mutation.error instanceof ApiError && mutation.error.status === 400
              ? mutation.error.message
              : t(errorKey)}
            {errorKey !== "taskConflict" && (
              <button
                type="button"
                disabled={mutation.isPending || !valid}
                onClick={() => void save()}
              >
                {t("retry")}
              </button>
            )}
            {errorKey === "taskConflict" && (
              <button
                type="button"
                onClick={async () => {
                  // Explicit reset only; a conflicting draft is otherwise kept intact.
                  try {
                    const latest = await api.getTask(projectId, task!.id);
                    setDraft(taskDraft(latest));
                    setBaseline(taskDraft(latest));
                    setRevision(latest.revision);
                    mutation.reset();
                    onChanged();
                  } catch {
                    /* Keep the original conflict and the draft available. */
                  }
                }}
              >
                {t("taskLoadLatest")}
              </button>
            )}
          </div>
        )}
        {confirmSubtasks && (
          <div className="doska-notice" role="alert">
            <p>{t("incompleteSubtasks")}</p>
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() => void save("complete")}
            >
              {t("completeAnyway")}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmSubtasks(false);
                field("columnId", baseline.columnId);
                mutation.reset();
              }}
            >
              {t("cancel")}
            </button>
          </div>
        )}
      </form>
      {task && (
        <>
          <DoskaTaskChecklists
            projectId={projectId}
            taskId={task.id}
            canWork={editable}
            onDirtyChange={setChecklistDirty}
          />
          <DoskaTaskSubtasks
            key={`subtasks-${task.id}`}
            projectId={projectId}
            task={{ ...task, revision: revision ?? task.revision }}
            columns={columns}
            canWork={editable}
            disabled={dirty || mutation.isPending}
            onDirtyChange={setSubtaskDirty}
            onCreate={onCreateSubtask}
          />
          <DoskaTaskRelations
            key={`relations-${task.id}`}
            projectId={projectId}
            taskId={task.id}
            revision={revision ?? task.revision}
            canWork={editable}
            onDirtyChange={setRelationDirty}
          />
          <DoskaTaskResourceLinks
            key={`resource-links-${task.id}`}
            projectId={projectId}
            taskId={task.id}
            canWork={editable}
            onDirtyChange={setResourceLinksDirty}
          />
          <DoskaTaskAttachments
            key={task.id}
            projectId={projectId}
            taskId={task.id}
            canWork={editable}
            onDirtyChange={setAttachmentDirty}
          />
          <DoskaTaskComments
            projectId={projectId}
            taskId={task.id}
            canWork={editable}
            canModerate={canDelete && editable}
            onDirtyChange={setCommentDirty}
          />
          <div className="doska-task-footer">
            <details
              className="doska-task-history-section"
              onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
            >
              <summary>{t("taskHistory")}</summary>
              {historyOpen && (
                <DoskaTaskHistory projectId={projectId} taskId={task.id} />
              )}
            </details>
            {footerSelection}
          </div>
        </>
      )}
      {!task && editable && (
        <footer className="doska-task-actions">
          <button
            type="submit"
            form={formId}
            className="doska-primary"
            disabled={mutation.isPending || !valid}
          >
            {t(mutation.isPending ? "saving" : "createTask")}
          </button>
        </footer>
      )}
    </div>
  );
}
