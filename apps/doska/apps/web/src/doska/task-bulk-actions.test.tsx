import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { api, ApiError, type Task, type Column } from "./api";
import { applyBulkChange, type BulkResult } from "./bulk-change";
import { DoskaTaskBulkActions } from "./task-bulk-actions";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const task = (id: string, revision = 1) =>
  ({
    id,
    title: id,
    revision,
    columnId: "todo",
    userId: null,
    priority: "low",
    dueDate: null,
    dueDateHasTime: false,
    archivedAt: null,
    parentTaskId: null,
  }) as Task;
const columns = [
  { id: "todo", name: "Todo", semanticState: "planned" },
  { id: "done", name: "Done", semanticState: "completed" },
] as Column[];
beforeEach(() => {
  vi.spyOn(api, "updateTask").mockResolvedValue(task("saved"));
  vi.spyOn(api, "archiveTask").mockResolvedValue(task("archived"));
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("bulk changes", () => {
  it("uses frozen revisions, processes sequentially and retains partial results without retry", async () => {
    let resolve!: (value: Task) => void;
    vi.mocked(api.updateTask)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockRejectedValueOnce(new ApiError(409, "Conflict"))
      .mockRejectedValueOnce(new ApiError(404, "Missing"))
      .mockRejectedValueOnce(new Error("Network"));
    const results: BulkResult[] = [];
    const running = applyBulkChange(
      "p",
      [task("a", 7), task("b", 9), task("c", 11), task("d", 13)],
      { kind: "priority", priority: "high" },
      (result) => results.push(result),
    );
    expect(api.updateTask).toHaveBeenCalledTimes(1);
    resolve(task("a"));
    await running;
    expect(
      vi
        .mocked(api.updateTask)
        .mock.calls.map((call) => call[2].expectedRevision),
    ).toEqual([7, 9, 11, 13]);
    expect(results.map((result) => result.status)).toEqual([
      "success",
      "skipped",
      "skipped",
      "unconfirmed",
    ]);
    expect(api.updateTask).toHaveBeenCalledTimes(4);
  });
  it("archives using the selected revision and sends Moscow date inputs unchanged", async () => {
    await applyBulkChange("p", [task("a", 5)], { kind: "archive" }, () => {});
    expect(api.archiveTask).toHaveBeenCalledWith("p", "a", {
      expectedRevision: 5,
      archived: true,
    });
    await applyBulkChange(
      "p",
      [task("a", 6)],
      { kind: "due", due: { date: "2026-10-28", time: "12:30" } },
      () => {},
    );
    expect(api.updateTask).toHaveBeenLastCalledWith("p", "a", {
      expectedRevision: 6,
      due: { date: "2026-10-28", time: "12:30" },
    });
    await applyBulkChange(
      "p",
      [task("a", 7)],
      { kind: "due", due: null },
      () => {},
    );
    expect(api.updateTask).toHaveBeenLastCalledWith("p", "a", {
      expectedRevision: 7,
      due: null,
    });
  });
  it("requires preview and guards double apply while disabling close", async () => {
    let resolve!: (value: Task) => void;
    vi.mocked(api.updateTask).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const changed = vi.fn(),
      close = vi.fn();
    const view = render(
      <DoskaTaskBulkActions
        projectId="p"
        tasks={[task("First", 4)]}
        allTasks={[]}
        columns={columns}
        roster={[]}
        onClose={close}
        onChanged={changed}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "bulkPreview", hidden: true }),
    );
    expect(api.updateTask).not.toHaveBeenCalled();
    expect(screen.getByText("First")).toBeInTheDocument();
    view.rerender(
      <DoskaTaskBulkActions
        projectId="p"
        tasks={[task("First", 99)]}
        allTasks={[]}
        columns={columns}
        roster={[]}
        onClose={close}
        onChanged={changed}
      />,
    );
    const apply = screen.getByRole("button", {
      name: "bulkApply",
      hidden: true,
    });
    act(() => {
      fireEvent.click(apply);
      fireEvent.click(apply);
    });
    expect(api.updateTask).toHaveBeenCalledTimes(1);
    expect(api.updateTask).toHaveBeenCalledWith("p", "First", {
      expectedRevision: 4,
      columnId: "todo",
    });
    for (const button of screen.getAllByRole("button", {
      name: "close",
      hidden: true,
    }))
      expect(button).toBeDisabled();
    fireEvent(
      view.container.querySelector("dialog")!,
      new Event("cancel", { cancelable: true }),
    );
    expect(close).not.toHaveBeenCalled();
    await act(async () => resolve(task("First", 5)));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(screen.getByText("bulkSuccess")).toBeInTheDocument();
  });
  it("requires explicit consent for visible incomplete subtasks", async () => {
    const parent = task("Parent"),
      child = { ...task("Child"), parentTaskId: parent.id };
    render(
      <DoskaTaskBulkActions
        projectId="p"
        tasks={[parent]}
        allTasks={[parent, child]}
        columns={columns}
        roster={[]}
        onClose={() => {}}
        onChanged={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("column"), {
      target: { value: "done" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "bulkPreview", hidden: true }),
    );
    expect(
      screen.getByRole("button", { name: "bulkApply", hidden: true }),
    ).toBeDisabled();
    fireEvent.click(screen.getByLabelText("bulkConfirmIncomplete"));
    fireEvent.click(
      screen.getByRole("button", { name: "bulkApply", hidden: true }),
    );
    await waitFor(() =>
      expect(api.updateTask).toHaveBeenCalledWith("p", "Parent", {
        expectedRevision: 1,
        columnId: "done",
        confirmIncompleteSubtasks: true,
      }),
    );
  });
});
