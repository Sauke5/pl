import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReactNode } from "react";
import { api, ApiError } from "./api";
import { useBoardMove } from "./board-move";
import type { BoardTask } from "./task-card";
const task = { id: "t", columnId: "todo", revision: 3 } as BoardTask;
function mount() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => useBoardMove("p"), { wrapper }), cache };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("board move mutation", () => {
  it("keeps the preview during a request and blocks duplicate drops", async () => {
    let resolve!: (value: BoardTask) => void;
    const request = vi.spyOn(api, "updateTask").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result } = mount();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.move(task, "doing");
    });
    expect(result.current.pending?.columnId).toBe("doing");
    await act(async () => {
      await result.current.move(task, "done");
    });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ ...task, columnId: "doing", revision: 4 });
      await pending;
    });
    expect(result.current.pending).toBeNull();
    expect(request).toHaveBeenCalledWith("p", "t", {
      columnId: "doing",
      beforeTaskId: null,
      expectedRevision: 3,
    });
  });
  it("rolls back the local preview and preserves concurrent cache changes on failure", async () => {
    vi.spyOn(api, "updateTask").mockRejectedValue(
      new ApiError(409, "Conflict"),
    );
    const { result, cache } = mount();
    cache.setQueryData(["doska", "tasks", "p", false], {
      pages: [[{ ...task, title: "Concurrent edit" }]],
      pageParams: [0],
    });
    await act(async () => {
      await result.current.move(task, "doing");
    });
    expect(result.current.pending).toBeNull();
    expect(result.current.error).toBe("moveConflict");
    expect(cache.getQueryData(["doska", "tasks", "p", false])).toMatchObject({
      pages: [[{ title: "Concurrent edit", columnId: "todo" }]],
    });
  });
  it("persists same-column placement and keeps preview until peers are refreshed", async () => {
    const request = vi
      .spyOn(api, "updateTask")
      .mockResolvedValue({ ...task, position: 0, revision: 4 });
    const { result, cache } = mount();
    let refresh!: () => void;
    vi.spyOn(cache, "invalidateQueries").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          refresh = resolve;
        }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.move(task, "todo", "anchor");
    });
    expect(request).toHaveBeenCalledWith("p", "t", {
      columnId: "todo",
      beforeTaskId: "anchor",
      expectedRevision: 3,
    });
    expect(result.current.pending?.beforeTaskId).toBe("anchor");
    await act(async () => {
      refresh();
      await pending;
    });
    expect(result.current.pending).toBeNull();
  });
  it("requires an explicit second attempt to complete with unfinished subtasks", async () => {
    const request = vi
      .spyOn(api, "updateTask")
      .mockRejectedValueOnce(new ApiError(409, "Есть незавершённые подзадачи"))
      .mockResolvedValueOnce({ ...task, columnId: "done", revision: 4 });
    const { result } = mount();
    await act(async () => {
      await result.current.move(task, "done");
    });
    expect(result.current.confirmation).toEqual({
      task,
      columnId: "done",
      beforeTaskId: null,
    });
    expect(result.current.pending).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.move(task, "done", null, true);
    });
    expect(request).toHaveBeenLastCalledWith("p", "t", {
      columnId: "done",
      beforeTaskId: null,
      expectedRevision: 3,
      confirmIncompleteSubtasks: true,
    });
    expect(result.current.confirmation).toBeNull();
  });
});
