import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, ApiError } from "./api";
import { DoskaTaskRelations } from "./task-relations";
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
    getRelations: vi.fn(),
    listProjects: vi.fn(),
    getAccess: vi.fn(),
    searchTasks: vi.fn(),
    createRelation: vi.fn(),
    deleteRelation: vi.fn(),
    getTask: vi.fn(),
  },
}));
const dirty = vi.fn();
const relation = {
  id: "r",
  type: "blocks" as const,
  direction: "incoming" as const,
  task: { id: "other", projectId: "p2", title: "Dependency", number: 8 },
};
function mount(canWork = true) {
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
      <DoskaTaskRelations
        projectId="p"
        taskId="t"
        revision={3}
        canWork={canWork}
        onDirtyChange={dirty}
      />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getRelations).mockResolvedValue([relation]);
  vi.mocked(api.listProjects).mockResolvedValue([
    { id: "p", name: "Current" },
    { id: "p2", name: "Other" },
  ] as never);
  vi.mocked(api.getAccess).mockResolvedValue({ workOnTasks: true } as never);
  vi.mocked(api.searchTasks).mockResolvedValue([
    { id: "t", title: "Self", number: 1 },
    { id: "new", title: "Another task", number: 2 },
  ] as never);
});
afterEach(cleanup);
it("shows incoming relation and task link to observers without write controls", async () => {
  mount(false);
  await screen.findByText("relationBlockedBy");
  expect(
    screen.getByRole("link", { name: "#8 Dependency" }).getAttribute("href"),
  ).toBe("/doska/projects/p2?taskId=other");
  expect(screen.queryByRole("button", { name: "relationAdd" })).toBeNull();
  expect(api.searchTasks).not.toHaveBeenCalled();
});
it("selects an accessible target, excludes self, creates with current revision and clears dirty state", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "relationAdd" }));
  const result = await screen.findByRole("button", { name: "#2 Another task" });
  expect(screen.queryByRole("button", { name: "#1 Self" })).toBeNull();
  fireEvent.click(result);
  fireEvent.change(screen.getByLabelText("relationType"), {
    target: { value: "blocks" },
  });
  fireEvent.click(screen.getByRole("button", { name: "relationLink" }));
  await waitFor(() =>
    expect(api.createRelation).toHaveBeenCalledWith("p", "t", {
      expectedRevision: 3,
      targetTaskId: "new",
      type: "blocks",
    }),
  );
  await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
});
it("does not search or submit targets from a read-only project", async () => {
  vi.mocked(api.getAccess).mockResolvedValue({ workOnTasks: false } as never);
  mount();
  fireEvent.click(screen.getByRole("button", { name: "relationAdd" }));
  await screen.findByText("relationTargetReadOnly");
  expect(api.searchTasks).not.toHaveBeenCalled();
  expect(
    (screen.getByRole("button", { name: "relationLink" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("requires confirmation before deletion", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", {
      name: "relationRemoveNamed:Dependency",
    }),
  );
  expect(api.deleteRelation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "cancel" }));
  expect(api.deleteRelation).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "relationRemoveNamed:Dependency" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "relationRemove" }));
  await waitFor(() =>
    expect(api.deleteRelation).toHaveBeenCalledWith("p", "t", "r", {
      expectedRevision: 3,
    }),
  );
});
it("reloads a conflict revision but does not retry until the user confirms", async () => {
  vi.mocked(api.createRelation)
    .mockRejectedValueOnce(new ApiError(409, "conflict"))
    .mockResolvedValueOnce(relation);
  vi.mocked(api.getTask).mockResolvedValue({ revision: 8 } as never);
  mount();
  fireEvent.click(screen.getByRole("button", { name: "relationAdd" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "#2 Another task" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "relationLink" }));
  await screen.findByText("relationConflict");
  expect(
    (screen.getByRole("button", { name: "relationLink" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "relationReload" }));
  await waitFor(() =>
    expect(screen.queryByText("relationConflict")).toBeNull(),
  );
  expect(api.createRelation).toHaveBeenCalledTimes(1);
  expect(dirty).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "relationLink" }));
  await waitFor(() =>
    expect(api.createRelation).toHaveBeenLastCalledWith("p", "t", {
      expectedRevision: 8,
      targetTaskId: "new",
      type: "related",
    }),
  );
});
