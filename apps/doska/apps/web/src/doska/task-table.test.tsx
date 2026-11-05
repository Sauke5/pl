import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DoskaTaskTable } from "./task-table";
import type { Column, Task } from "./api";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { task?: string }) =>
      values?.task ? `${key}: ${values.task}` : key,
  }),
}));
afterEach(cleanup);
const now = Date.parse("2026-10-23T12:00:00+03:00");
const columns = [
  { id: "todo", name: "Planned", semanticState: "planned" },
  { id: "done", name: "Done", semanticState: "completed" },
] as Column[];
const task = (id: string, extra: Partial<Task> = {}) =>
  ({
    id,
    title: id,
    projectId: "p",
    columnId: "todo",
    number: 1,
    userId: null,
    priority: "medium",
    startDate: null,
    dueDate: null,
    dueDateHasTime: false,
    parentTaskId: null,
    checklistProgress: { done: 0, total: 0 },
    ...extra,
  }) as Task;
function mount(tasks: Task[]) {
  const onOpen = vi.fn();
  const view = render(
    <DoskaTaskTable
      tasks={tasks}
      columns={columns}
      roster={[]}
      onOpen={onOpen}
      now={now}
    />,
  );
  return { ...view, onOpen };
}
describe("task table", () => {
  it("opens the original task and keeps completed deadlines neutral", () => {
    const { onOpen, container } = mount([
      task("Late", { dueDate: "2026-10-22T20:59:00Z" }),
      task("Finished", { columnId: "done", dueDate: "2026-10-22T20:59:00Z" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Late" }));
    expect(onOpen).toHaveBeenCalledWith("Late");
    expect(container.querySelectorAll(".is-overdue")).toHaveLength(1);
    expect(container.querySelectorAll(".is-normal")).toHaveLength(1);
  });
  it("sorts dates in both directions with missing values last and exposes aria-sort", () => {
    const { container } = mount([
      task("Missing"),
      task("Later", { dueDate: "2026-10-25T20:59:00Z" }),
      task("Earlier", { dueDate: "2026-10-24T20:59:00Z" }),
    ]);
    const titles = () =>
      [
        ...container.querySelectorAll("tbody .doska-task-table-title>button"),
      ].map((node) => node.textContent);
    fireEvent.click(screen.getByRole("button", { name: "dueDate" }));
    expect(titles()).toEqual(["Earlier", "Later", "Missing"]);
    expect(
      screen
        .getByRole("columnheader", { name: "dueDate" })
        .getAttribute("aria-sort"),
    ).toBe("ascending");
    fireEvent.click(screen.getByRole("button", { name: "dueDate" }));
    expect(titles()).toEqual(["Later", "Earlier", "Missing"]);
    expect(
      screen
        .getByRole("columnheader", { name: "dueDate" })
        .getAttribute("aria-sort"),
    ).toBe("descending");
  });
  it("shows checklist progress and a parent label only from supplied tasks", () => {
    mount([
      task("Parent"),
      task("Child", {
        parentTaskId: "Parent",
        checklistProgress: { done: 2, total: 5 },
      }),
      task("External", { parentTaskId: "hidden-id" }),
    ]);
    expect(screen.getByText("subtaskOf: Parent")).toBeTruthy();
    expect(screen.getByText("subtask")).toBeTruthy();
    expect(screen.queryByText("hidden-id")).toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("2");
    expect(screen.getByRole("progressbar").getAttribute("max")).toBe("5");
  });
  it("limits select-all to 100 sorted tasks and keeps selection separate from opening", () => {
    const tasks = Array.from({ length: 101 }, (_, index) =>
      task(`Task ${index}`, { number: index }),
    );
    const onChange = vi.fn();
    const onOpen = vi.fn();
    const { rerender } = render(
      <DoskaTaskTable
        tasks={tasks}
        columns={columns}
        roster={[]}
        onOpen={onOpen}
        now={now}
        selection={{ selectedIds: new Set(), onChange }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "taskNumber" }));
    fireEvent.click(screen.getByRole("button", { name: "taskNumber" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "bulkSelectTasks" }));
    const selected = onChange.mock.calls[0][0] as Task[];
    expect(selected).toHaveLength(100);
    expect(selected[0].number).toBe(100);
    expect(selected[99].number).toBe(1);
    expect(onOpen).not.toHaveBeenCalled();
    rerender(
      <DoskaTaskTable
        tasks={tasks}
        columns={columns}
        roster={[]}
        onOpen={onOpen}
        now={now}
        selection={{
          selectedIds: new Set(selected.map((task) => task.id)),
          onChange,
        }}
      />,
    );
    const unchecked = screen
      .getAllByRole("checkbox")
      .filter((node) => !(node as HTMLInputElement).checked);
    expect(unchecked).toHaveLength(1);
    expect((unchecked[0] as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "bulkSelectTasks" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
  it("renders an empty state without a table", () => {
    mount([]);
    expect(screen.getByText("tableTasksEmpty")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
