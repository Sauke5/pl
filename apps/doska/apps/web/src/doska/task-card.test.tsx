import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DoskaTaskCard, type BoardTask } from "./task-card";
import { api } from "./api";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("./api", () => ({
  api: { updateChecklistItem: vi.fn() },
  ApiError: class extends Error {
    status = 409;
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const task = {
  id: "t",
  projectId: "p",
  title: "Prepare release",
  number: 7,
  priority: "low",
  revision: 3,
  checklistProgress: { total: 1, done: 0 },
  checklistPreview: [
    { id: "i", checklistId: "l", text: "Check backup", done: false },
  ],
} as BoardTask;
function mount(canWork = true) {
  const open = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      }
    >
      <DoskaTaskCard
        task={task}
        selected={false}
        canWork={canWork}
        onOpen={open}
      />
    </QueryClientProvider>,
  );
  return open;
}
describe("board checklist quick action", () => {
  it("toggles a persisted item without opening the drawer", async () => {
    vi.mocked(api.updateChecklistItem).mockResolvedValue({} as never);
    const open = mount();
    fireEvent.click(screen.getByRole("checkbox", { name: "Check backup" }));
    await waitFor(() =>
      expect(api.updateChecklistItem).toHaveBeenCalledWith("p", "t", "l", "i", {
        expectedRevision: 3,
        done: true,
      }),
    );
    expect(open).not.toHaveBeenCalled();
  });
  it("does not offer writes to a reader", () => {
    mount(false);
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });
  it("rolls back the optimistic tick and explains a failed save", async () => {
    vi.mocked(api.updateChecklistItem).mockRejectedValue(new Error("offline"));
    mount();
    fireEvent.click(screen.getByRole("checkbox"));
    await screen.findByRole("alert");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent("boardChecklistError");
  });
});

it("collapses completed items on the board and expands them without opening the task", () => {
  const open = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DoskaTaskCard
        task={{
          ...task,
          checklistProgress: { total: 1, done: 1 },
          checklistPreview: task.checklistPreview.map((item) => ({
            ...item,
            done: true,
          })),
        }}
        selected={false}
        canWork
        onOpen={open}
      />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "1");
  fireEvent.click(screen.getByRole("button", { name: "checklistExpand" }));
  expect(screen.getByRole("checkbox")).toBeChecked();
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "checklistCollapse" }));
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});

it("applies the persisted card tint and removes it when reset", () => {
  const client = new QueryClient();
  const card = (cardColor: BoardTask["cardColor"]) => (
    <QueryClientProvider client={client}>
      <DoskaTaskCard
        task={{ ...task, cardColor }}
        selected={true}
        onOpen={() => {}}
      />
    </QueryClientProvider>
  );
  const view = render(card("green"));
  expect(screen.getByRole("article")).toHaveClass(
    "doska-card-colored",
    "doska-card-color-green",
    "selected",
  );
  view.rerender(card(null));
  expect(screen.getByRole("article")).not.toHaveClass(
    "doska-card-colored",
    "doska-card-color-green",
  );
  expect(screen.getByRole("article")).toHaveClass("selected");
});

it("collapses completed groups independently while keeping other checklist items visible", () => {
  const open = vi.fn();
  const groups = [
    {
      id: "done",
      title: "Ready",
      total: 1,
      done: 1,
      preview: [
        { id: "a", checklistId: "done", text: "Completed item", done: true },
      ],
    },
    {
      id: "active",
      title: "Work",
      total: 1,
      done: 0,
      preview: [
        {
          id: "b",
          checklistId: "active",
          text: "Several words in a task",
          done: false,
        },
      ],
    },
  ];
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DoskaTaskCard
        task={{ ...task, checklistGroups: groups }}
        selected={false}
        canWork
        onOpen={open}
      />
    </QueryClientProvider>,
  );
  expect(screen.getByText("Ready")).toBeInTheDocument();
  expect(screen.getByText("Work")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "Completed item" })).toBeNull();
  expect(
    screen.getByRole("checkbox", { name: "Several words in a task" }),
  ).toBeInTheDocument();
  expect(
    screen.getAllByRole("progressbar").map((e) => e.getAttribute("value")),
  ).toEqual(["1", "0"]);
  fireEvent.click(screen.getByRole("button", { name: "checklistExpand" }));
  expect(
    screen.getByRole("checkbox", { name: "Completed item" }),
  ).toBeChecked();
  expect(open).not.toHaveBeenCalled();
  const input = screen.getByRole("checkbox", {
    name: "Several words in a task",
  });
  expect(input.closest("label")?.parentElement).toHaveClass(
    "doska-card-check-row",
  );
});
