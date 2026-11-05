import { useRef, useState } from "react";
import { type InfiniteData, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./api";
import type { BoardTask } from "./task-card";

export type BoardMove = {
  task: BoardTask;
  columnId: string;
  beforeTaskId: string | null;
};
export function moveErrorKey(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 409)
      return error.message.includes("незавершённые подзадачи")
        ? "incompleteSubtasks"
        : "moveConflict";
    if (error.status === 403) return "moveForbidden";
  }
  return "moveTaskError";
}

export function useBoardMove(projectId: string) {
  const cache = useQueryClient();
  const lock = useRef(false);
  const [pending, setPending] = useState<BoardMove | null>(null);
  const [confirmation, setConfirmation] = useState<BoardMove | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function move(
    task: BoardTask,
    columnId: string,
    beforeTaskId: string | null = null,
    confirmed = false,
  ) {
    if (lock.current || beforeTaskId === task.id) return;
    lock.current = true;
    setConfirmation(null);
    setError(null);
    setPending({ task, columnId, beforeTaskId });
    try {
      const saved = await api.updateTask(projectId, task.id, {
        columnId,
        beforeTaskId,
        expectedRevision: task.revision,
        ...(confirmed ? { confirmIncompleteSubtasks: true } : {}),
      });
      cache.setQueriesData<InfiniteData<BoardTask[]>>(
        { queryKey: ["doska", "tasks", projectId] },
        (data) =>
          data
            ? {
                ...data,
                pages: data.pages.map((page) =>
                  page.map((item) =>
                    item.id === saved.id && item.revision <= saved.revision
                      ? saved
                      : item,
                  ),
                ),
              }
            : data,
      );
      cache.setQueryData<BoardTask>(
        ["doska", "task", projectId, task.id],
        (current) =>
          current && current.revision > saved.revision ? current : saved,
      );
      await cache.invalidateQueries({ queryKey: ["doska"] });
    } catch (failure) {
      const key = moveErrorKey(failure);
      if (key === "incompleteSubtasks")
        setConfirmation({ task, columnId, beforeTaskId });
      else {
        setError(key);
        void cache.invalidateQueries({ queryKey: ["doska"] });
      }
    } finally {
      setPending(null);
      lock.current = false;
    }
  }
  return {
    pending,
    confirmation,
    error,
    move,
    dismiss: () => setError(null),
    cancel: () => setConfirmation(null),
  };
}

export function previewBoardMove(
  tasks: BoardTask[],
  pending: BoardMove | null,
): BoardTask[] {
  if (!pending) return tasks;
  const task = tasks.find((item) => item.id === pending.task.id);
  if (!task) return tasks;
  const remaining = tasks.filter((item) => item.id !== task.id);
  const anchor =
    pending.beforeTaskId === null
      ? -1
      : remaining.findIndex(
          (item) =>
            item.id === pending.beforeTaskId &&
            item.columnId === pending.columnId,
        );
  remaining.splice(anchor < 0 ? remaining.length : anchor, 0, {
    ...task,
    columnId: pending.columnId,
  });
  return remaining;
}

export function sortBoardTasks(tasks: BoardTask[]): BoardTask[] {
  return [...tasks].sort(
    (a, b) =>
      (a.position ?? Infinity) - (b.position ?? Infinity) ||
      a.id.localeCompare(b.id),
  );
}

export function boardDropTarget(
  tasks: BoardTask[],
  activeId: string,
  targetId: string,
  columnId: string,
  after: boolean,
): Pick<BoardMove, "columnId" | "beforeTaskId"> {
  const column = tasks.filter(
    (task) => task.columnId === columnId && task.id !== activeId,
  );
  const index = column.findIndex((task) => task.id === targetId);
  return {
    columnId,
    beforeTaskId:
      index < 0 ? null : (column[index + (after ? 1 : 0)]?.id ?? null),
  };
}
