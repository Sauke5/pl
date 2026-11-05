import { describe, expect, it } from "vite-plus/test";
import { ApiError } from "./api";
import {
  boardDropTarget,
  moveErrorKey,
  previewBoardMove,
  sortBoardTasks,
} from "./board-move";
import type { BoardTask } from "./task-card";
const task = (id: string, columnId: string) =>
  ({ id, columnId, revision: 2, title: id }) as BoardTask;
describe("board move", () => {
  it("previews append in the destination without mutating the query data", () => {
    const tasks = [task("a", "todo"), task("b", "doing"), task("c", "todo")];
    const result = previewBoardMove(tasks, {
      task: tasks[0],
      columnId: "doing",
      beforeTaskId: null,
    });
    expect(
      result.filter((item) => item.columnId === "doing").map((item) => item.id),
    ).toEqual(["b", "a"]);
    expect(
      result.filter((item) => item.columnId === "todo").map((item) => item.id),
    ).toEqual(["c"]);
    expect(tasks[0].columnId).toBe("todo");
    expect(previewBoardMove(tasks, null)).toBe(tasks);
  });
  it("preserves newer data while the optimistic move is displayed", () => {
    const old = task("a", "todo");
    const fresh = { ...old, revision: 3, title: "Updated" };
    expect(
      previewBoardMove([fresh], {
        task: old,
        columnId: "doing",
        beforeTaskId: null,
      })[0],
    ).toMatchObject({
      title: "Updated",
      revision: 3,
      columnId: "doing",
    });
  });
  it("does not resurrect a task removed during a move", () => {
    expect(
      previewBoardMove([], {
        task: task("a", "todo"),
        columnId: "doing",
        beforeTaskId: null,
      }),
    ).toEqual([]);
  });
  it("inserts within a column and across columns without changing hidden peers", () => {
    const tasks = [
      task("a", "todo"),
      task("hidden", "todo"),
      task("b", "todo"),
      task("c", "doing"),
    ];
    expect(
      previewBoardMove(tasks, {
        task: tasks[2],
        columnId: "todo",
        beforeTaskId: "a",
      })
        .filter((t) => t.columnId === "todo")
        .map((t) => t.id),
    ).toEqual(["b", "a", "hidden"]);
    expect(
      previewBoardMove(tasks, {
        task: tasks[3],
        columnId: "todo",
        beforeTaskId: "hidden",
      })
        .filter((t) => t.columnId === "todo")
        .map((t) => t.id),
    ).toEqual(["a", "c", "hidden", "b"]);
    expect(boardDropTarget(tasks, "c", "a", "todo", true)).toEqual({
      columnId: "todo",
      beforeTaskId: "hidden",
    });
    expect(boardDropTarget(tasks, "a", "b", "todo", false)).toEqual({
      columnId: "todo",
      beforeTaskId: "b",
    });
    expect(boardDropTarget(tasks, "a", "b", "todo", true)).toEqual({
      columnId: "todo",
      beforeTaskId: null,
    });
  });
  it("uses server position after page concatenation and saved-task replacement", () => {
    const tasks = [
      { ...task("b", "todo"), position: 1 },
      { ...task("c", "todo"), position: 0 },
      { ...task("a", "todo"), position: 0 },
    ];
    expect(sortBoardTasks(tasks).map((t) => t.id)).toEqual(["a", "c", "b"]);
    expect(tasks[0].id).toBe("b");
  });
  it("separates incomplete-child confirmation from revision conflicts and access failures", () => {
    expect(
      moveErrorKey(new ApiError(409, "Есть незавершённые подзадачи")),
    ).toBe("incompleteSubtasks");
    expect(moveErrorKey(new ApiError(409, "Revision changed"))).toBe(
      "moveConflict",
    );
    expect(moveErrorKey(new ApiError(403, "Forbidden"))).toBe("moveForbidden");
    expect(moveErrorKey(new TypeError("Failed to fetch"))).toBe(
      "moveTaskError",
    );
  });
});
