import { DoskaTaskExcerpt } from "./task-excerpt";
import { DoskaLabelChips } from "./label-chips";
import { CardChecklistGroup } from "./task-card-checklist";
import { useState } from "react";
import { CalendarDays, UserRound, CornerDownRight } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "./api";
import { taskDeadline } from "./task-deadline";
import { useCardTitleDrag } from "./board-drag";
export type BoardTask = Awaited<ReturnType<typeof api.getTask>>;
export function DoskaTaskCard({
  task,
  assignee,
  parentTitle,
  selected,
  onOpen,
  canWork = false,
  completed = false,
  now,
}: {
  task: BoardTask;
  assignee?: string;
  parentTitle?: string;
  selected: boolean;
  onOpen: () => void;
  canWork?: boolean;
  completed?: boolean;
  now?: number;
}) {
  const { t } = useTranslation("doska");
  const cache = useQueryClient();
  const dragTitle = useCardTitleDrag();
  const deadline = taskDeadline(
    task.dueDate,
    task.dueDateHasTime,
    completed,
    now,
  );
  const [pendingItem, setPendingItem] = useState<
    BoardTask["checklistPreview"][number] | null
  >(null);
  const toggle = useMutation({
    mutationFn: (item: BoardTask["checklistPreview"][number]) =>
      api.updateChecklistItem(
        task.projectId,
        task.id,
        item.checklistId,
        item.id,
        {
          expectedRevision: task.revision,
          done: !item.done,
        },
      ),
    onSettled: async () => {
      await Promise.all(
        ["tasks", "task", "checklists", "history", "my-tasks"].map((key) =>
          cache.invalidateQueries({
            queryKey:
              key === "my-tasks"
                ? ["doska", key]
                : ["doska", key, task.projectId],
          }),
        ),
      );
      setPendingItem(null);
    },
  });
  return (
    <article
      className={`doska-task-card${selected ? " selected" : ""}${task.cardColor ? ` doska-card-colored doska-card-color-${task.cardColor}` : ""}`}
    >
      <button
        className="doska-task-open"
        onClick={onOpen}
        ref={dragTitle?.setActivatorNodeRef}
        {...dragTitle?.attributes}
        {...dragTitle?.listeners}
        style={dragTitle ? { cursor: "grab", touchAction: "none" } : undefined}
      >
        <strong>{task.title}</strong>
        {task.description && <DoskaTaskExcerpt value={task.description} />}
      </button>
      <DoskaLabelChips labels={task.labels ?? []} />
      {(
        task.checklistGroups ?? [
          {
            id: "legacy",
            title: "",
            ...task.checklistProgress,
            preview: task.checklistPreview,
          },
        ]
      ).map((group) => (
        <CardChecklistGroup
          key={group.id}
          group={group}
          title={group.title}
          pendingItem={pendingItem}
          disabled={!canWork || Boolean(task.archivedAt) || toggle.isPending}
          onToggle={(item) => {
            setPendingItem(item);
            toggle.mutate(item);
          }}
          onOpen={onOpen}
        />
      ))}
      {toggle.isError && (
        <p className="doska-card-error" role="alert">
          {t(
            toggle.error instanceof ApiError && toggle.error.status === 409
              ? "boardChecklistConflict"
              : "boardChecklistError",
          )}
        </p>
      )}
      <button className="doska-task-open doska-task-meta" onClick={onOpen}>
        <span className="doska-task-number">
          {task.number == null ? t("task") : `#${task.number}`}
        </span>
        {task.parentTaskId && (
          <span
            title={
              parentTitle ? t("subtaskOf", { task: parentTitle }) : undefined
            }
          >
            <CornerDownRight size={13} aria-hidden="true" />
            {t("subtask")}
          </span>
        )}
        {task.priority !== "no-priority" && (
          <span className={`doska-priority priority-${task.priority}`}>
            {t(`priority_${task.priority}`)}
          </span>
        )}
        <span>
          <UserRound size={13} />
          {assignee ?? t(task.userId ? "unavailableMember" : "unassigned")}
        </span>
        {deadline && (
          <span
            className={`doska-deadline is-${deadline.state}`}
            title={`${deadline.full} · ${t("moscowTime")}`}
          >
            <CalendarDays size={13} />
            {deadline.state === "overdue"
              ? `${t("deadlineOverdue")} · ${deadline.date}`
              : deadline.state === "today"
                ? t("deadlineToday")
                : deadline.date}
            {deadline.time && `, ${deadline.time}`}
          </span>
        )}
      </button>
    </article>
  );
}
