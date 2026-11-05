import {
  api,
  ApiError,
  type Task,
  type Column,
  type UpdateTaskInput,
} from "./api";
export type BulkChange =
  | { kind: "column"; columnId: string; confirmIncompleteSubtasks: boolean }
  | { kind: "responsible"; userId: string | null }
  | { kind: "priority"; priority: NonNullable<UpdateTaskInput["priority"]> }
  | { kind: "due"; due: { date: string; time?: string } | null }
  | { kind: "archive" };
export type BulkResult = {
  task: Task;
  status: "success" | "skipped" | "unconfirmed";
  reason?: string;
};
export function incompleteBulkChildren(
  tasks: Task[],
  allTasks: Task[],
  columns: Column[],
  columnId: string,
) {
  if (
    columns.find((column) => column.id === columnId)?.semanticState !==
    "completed"
  )
    return [];
  const selected = new Set(tasks.map((task) => task.id));
  return allTasks.filter(
    (task) =>
      task.parentTaskId &&
      selected.has(task.parentTaskId) &&
      !task.archivedAt &&
      columns.find((column) => column.id === task.columnId)?.semanticState !==
        "completed",
  );
}
export async function applyBulkChange(
  projectId: string,
  tasks: Task[],
  change: BulkChange,
  onResult: (result: BulkResult) => void,
) {
  if (tasks.length > 100 || !tasks.length)
    throw new Error("Bulk selection must contain 1–100 tasks");
  for (const task of tasks) {
    try {
      if (change.kind === "archive")
        await api.archiveTask(projectId, task.id, {
          expectedRevision: task.revision,
          archived: true,
        });
      else {
        let patch: UpdateTaskInput = { expectedRevision: task.revision };
        switch (change.kind) {
          case "column":
            patch = {
              ...patch,
              columnId: change.columnId,
              ...(change.confirmIncompleteSubtasks
                ? { confirmIncompleteSubtasks: true }
                : {}),
            };
            break;
          case "responsible":
            patch = { ...patch, userId: change.userId };
            break;
          case "priority":
            patch = { ...patch, priority: change.priority };
            break;
          case "due":
            patch = { ...patch, due: change.due };
            break;
        }
        await api.updateTask(projectId, task.id, patch);
      }
      onResult({ task, status: "success" });
    } catch (error) {
      const reason =
        error instanceof ApiError
          ? error.status === 409
            ? error.message.includes("незавершённые подзадачи")
              ? "bulkIncompleteChanged"
              : "bulkConflict"
            : error.status === 403
              ? "bulkForbidden"
              : error.status === 404
                ? "bulkMissing"
                : error.status === 400
                  ? error.message.includes("assignee is unavailable") ||
                    error.message.includes("assignee unavailable")
                    ? "bulkAssigneeUnavailable"
                    : error.message.includes("also be a coexecutor")
                      ? "bulkAlreadyCoexecutor"
                      : "bulkInvalid"
                  : null
          : null;
      onResult({
        task,
        status: reason ? "skipped" : "unconfirmed",
        reason: reason ?? "bulkUnconfirmed",
      });
    }
  }
}
