import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, ApiError, type Task, type Column } from "./api";
import { DoskaTaskSubtasks } from "./task-subtasks";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) =>
      values?.name ? `${key}:${values.name}` : key,
  }),
}));
vi.mock("./shell", () => ({ doskaHref: (path: string) => `/doska${path}` }));
vi.mock("./api", () => ({
  ApiError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  api: {
    listTasks: vi.fn(),
    getTask: vi.fn(),
    searchTasks: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
  },
}));
const task = {
  id: "parent",
  projectId: "p",
  title: "Parent",
  number: 1,
  parentTaskId: null,
  revision: 3,
} as Task;
const child = {
  id: "child",
  projectId: "p",
  title: "Child",
  number: 2,
  parentTaskId: "parent",
  revision: 5,
  columnId: "active",
} as Task;
const candidate = {
  id: "other",
  projectId: "p",
  title: "Other",
  number: 3,
  parentTaskId: null,
  revision: 8,
} as Task;
const columns = [
  { id: "active", name: "In progress", position: 0, semanticState: "active" },
  { id: "planned", name: "Planned", position: 1, semanticState: "planned" },
] as Column[];
const dirty = vi.fn();
function mount(current = task, canWork = true) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <DoskaTaskSubtasks
        projectId="p"
        task={current}
        columns={columns}
        canWork={canWork}
        onDirtyChange={dirty}
      />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.listTasks).mockResolvedValue([child]);
  vi.mocked(api.getTask).mockResolvedValue(candidate);
  vi.mocked(api.searchTasks).mockResolvedValue([
    task,
    child,
    candidate,
  ] as never);
});
afterEach(cleanup);
it("queries only direct children, shows status and hides mutation controls for observers", async () => {
  mount(task, false);
  expect(await screen.findByRole("link", { name: "#2 Child" })).toBeTruthy();
  expect(screen.getByText("In progress")).toBeTruthy();
  expect(api.listTasks).toHaveBeenCalledWith("p", {
    parentTaskId: "parent",
    limit: 20,
    offset: 0,
    archived: false,
  });
  expect(screen.queryByRole("button", { name: "subtaskCreate" })).toBeNull();
});
it("creates a full child in the first planned column and clears dirty state", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "subtaskCreate" }));
  fireEvent.change(screen.getByLabelText("taskTitle"), {
    target: { value: " New child " },
  });
  fireEvent.click(screen.getByRole("button", { name: "subtaskCreate" }));
  await waitFor(() =>
    expect(api.createTask).toHaveBeenCalledWith("p", {
      title: "New child",
      parentTaskId: "parent",
      columnId: "planned",
    }),
  );
  await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
});
it("reads current candidate revision and excludes self and already attached tasks", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "subtaskAttach" }));
  fireEvent.click(await screen.findByRole("button", { name: "#3 Other" }));
  expect(screen.queryByRole("button", { name: "#1 Parent" })).toBeNull();
  expect(screen.queryByRole("button", { name: "#2 Child" })).toBeNull();
  await screen.findByText("subtaskSelected:Other");
  fireEvent.click(screen.getByRole("button", { name: "subtaskAttach" }));
  await waitFor(() =>
    expect(api.updateTask).toHaveBeenCalledWith("p", "other", {
      expectedRevision: 8,
      parentTaskId: "parent",
    }),
  );
});
it("requires explicit detach confirmation and uses the child revision", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "subtaskDetachNamed:Child" }),
  );
  expect(api.updateTask).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "cancel" }));
  expect(api.updateTask).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "subtaskDetachNamed:Child" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "subtaskDetach" }));
  await waitFor(() =>
    expect(api.updateTask).toHaveBeenCalledWith("p", "child", {
      expectedRevision: 5,
      parentTaskId: null,
    }),
  );
});
it("shows a child parent and never offers nested subtask creation", async () => {
  vi.mocked(api.getTask).mockResolvedValue(task);
  mount(child);
  expect(await screen.findByRole("link", { name: "#1 Parent" })).toBeTruthy();
  expect(api.listTasks).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "subtaskCreate" })).toBeNull();
});
it("preserves the confirmation on conflict and prevents blind retries", async () => {
  vi.mocked(api.updateTask).mockRejectedValue(new ApiError(409, "Changed"));
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "subtaskDetachNamed:Child" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "subtaskDetach" }));
  await screen.findByText("subtaskConflict");
  expect(
    (screen.getByRole("button", { name: "subtaskDetach" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(dirty).toHaveBeenLastCalledWith(true);
});
it("paginates direct children without changing the parent filter", async () => {
  vi.mocked(api.listTasks).mockResolvedValue(
    Array.from({ length: 20 }, (_, i) => ({
      ...child,
      id: `child${i}`,
      title: `Child${i}`,
    })),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "next" }));
  await waitFor(() =>
    expect(api.listTasks).toHaveBeenCalledWith("p", {
      parentTaskId: "parent",
      limit: 20,
      offset: 20,
      archived: false,
    }),
  );
});

it("switches to archived children at page zero and keeps archived cards readable without detach", async () => {
  const archivedChild = {
    ...child,
    id: "archived-child",
    title: "Archived child",
    archivedAt: "2026-10-24T00:00:00.000Z",
  } as Task;
  vi.mocked(api.listTasks).mockImplementation(async (_project, query) =>
    query?.archived
      ? [archivedChild]
      : Array.from({ length: 20 }, (_, index) => ({
          ...child,
          id: `child${index}`,
          title: `Child${index}`,
        })),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "next" }));
  await waitFor(() =>
    expect(api.listTasks).toHaveBeenCalledWith("p", {
      parentTaskId: "parent",
      limit: 20,
      offset: 20,
      archived: false,
    }),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "archived" }));
  expect(
    await screen.findByRole("link", { name: "#2 Archived child" }),
  ).toBeTruthy();
  expect(api.listTasks).toHaveBeenLastCalledWith("p", {
    parentTaskId: "parent",
    limit: 20,
    offset: 0,
    archived: true,
  });
  expect(
    (
      screen.getByRole("button", {
        name: "subtaskDetachNamed:Archived child",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.queryByRole("button", { name: "previous" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "archived" }));
  await screen.findByRole("link", { name: "#2 Child0" });
  expect(
    (
      screen.getByRole("button", {
        name: "subtaskDetachNamed:Child0",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
