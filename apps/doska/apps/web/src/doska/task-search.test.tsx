import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { api } from "./api";
import { DoskaTaskSearch } from "./task-search";
import { emptyTaskSearch, readTaskSearchContext } from "./task-search-context";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("./shell", () => ({ doskaHref: (path: string) => `/doska${path}` }));
vi.mock("./session", () => ({
  useDoskaSession: () => ({ context: { user: { id: "me", name: "Me" } } }),
}));
const task = {
  id: "t",
  projectId: "p",
  title: "Found task",
  projectName: "Project",
  columnName: "Todo",
  columnState: "planned",
  dueDate: null,
  number: 1,
};
function mount() {
  const root = createRootRoute({ component: Outlet });
  const search = createRoute({
    getParentRoute: () => root,
    path: "/search",
    component: DoskaTaskSearch,
  });
  const board = createRoute({
    getParentRoute: () => root,
    path: "/projects/$projectId",
    component: () => <p>Board</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([search, board]),
    history: createMemoryHistory({ initialEntries: ["/doska/search"] }),
    basepath: "/doska/",
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}
beforeEach(() => {
  vi.spyOn(api, "searchTasks").mockResolvedValue([task] as never);
  vi.spyOn(api, "listProjects").mockResolvedValue([
    { id: "p", name: "Project" },
  ] as never);
  vi.spyOn(api, "listMembers").mockResolvedValue({
    owner: { userId: "owner", name: "Owner" },
    members: [],
  } as never);
  vi.spyOn(api, "getProjectFields").mockResolvedValue({
    revision: 0,
    requiredTaskFields: [],
    fields: [],
  });
  vi.spyOn(api, "listProjectLabels").mockResolvedValue([]);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("task search", () => {
  it("debounces typing and resets pagination for a new query", async () => {
    vi.mocked(api.searchTasks).mockImplementation(async (query) =>
      query?.offset
        ? ([task] as never)
        : (Array.from({ length: 40 }, (_, i) => ({
            ...task,
            id: `t${i}`,
            title: `Task ${i}`,
          })) as never),
    );
    mount();
    await screen.findByText("Task 0");
    fireEvent.click(screen.getByRole("button", { name: "next" }));
    await screen.findByText("Found task");
    expect(api.searchTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 40 }),
    );
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "first" },
    });
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "final" },
    });
    expect(api.searchTasks).toHaveBeenCalledTimes(2);
    await waitFor(
      () =>
        expect(api.searchTasks).toHaveBeenLastCalledWith(
          expect.objectContaining({ q: "final", offset: 0 }),
        ),
      { timeout: 1500 },
    );
    expect(api.searchTasks).toHaveBeenCalledTimes(3);
  });
  it("preserves filters and scroll while opening and returning from a task", async () => {
    const router = mount();
    await screen.findByText("Found task");
    fireEvent.change(screen.getByLabelText("project"), {
      target: { value: "p" },
    });
    await screen.findAllByText("Owner");
    fireEvent.change(screen.getByLabelText("responsible"), {
      target: { value: "owner" },
    });
    await waitFor(() =>
      expect(api.searchTasks).toHaveBeenLastCalledWith(
        expect.objectContaining({ projectId: "p", assigneeId: "owner" }),
      ),
    );
    vi.spyOn(window, "scrollY", "get").mockReturnValue(180);
    fireEvent.click(await screen.findByRole("link", { name: "#1 Found task" }));
    await screen.findByText("Board");
    expect(readTaskSearchContext(router.state.location.state)).toMatchObject({
      filters: { projectId: "p", assigneeId: "owner" },
      page: 0,
      scrollY: 180,
    });
    await act(async () => router.history.back());
    await screen.findByText("Found task");
    expect(screen.getByLabelText("project")).toHaveValue("p");
    expect(screen.getByLabelText("responsible")).toHaveValue("owner");
    expect(window.scrollTo).toHaveBeenCalledWith({
      top: 180,
      behavior: "instant",
    });
    expect(
      screen.queryByRole("button", { name: "next" }),
    ).not.toBeInTheDocument();
  });
  it("shows roster errors without exposing user ids or hiding search results", async () => {
    vi.mocked(api.listMembers).mockRejectedValue(new Error("unavailable"));
    mount();
    await screen.findByText("Found task");
    fireEvent.change(screen.getByLabelText("project"), {
      target: { value: "p" },
    });
    await screen.findByText("membersLoadError");
    expect(screen.getByLabelText("responsible")).toBeDisabled();
    expect(
      screen.getByRole("link", { name: "#1 Found task" }),
    ).toBeInTheDocument();
  });
  it("includes active and archived projects when archive search is enabled", async () => {
    vi.mocked(api.listProjects).mockImplementation(
      async (query) =>
        (query?.archived
          ? [{ id: "archive", name: "Archived project" }]
          : [{ id: "p", name: "Active project" }]) as never,
    );
    mount();
    await screen.findByText("Found task");
    fireEvent.click(screen.getByText("searchFilters"));
    await screen.findByRole("option", { name: "Active project" });
    expect(
      screen.queryByRole("option", { name: "Archived project" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("searchIncludeArchived"));
    await screen.findByRole("option", { name: "Archived project" });
    expect(
      screen.getByRole("option", { name: "Active project" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("project"), {
      target: { value: "archive" },
    });
    await waitFor(() =>
      expect(api.searchTasks).toHaveBeenLastCalledWith(
        expect.objectContaining({ archived: true, projectId: "archive" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "searchClear" }));
    await waitFor(() =>
      expect(api.searchTasks).toHaveBeenLastCalledWith({
        limit: 40,
        offset: 0,
      }),
    );
    expect(screen.getByLabelText("project")).toHaveValue("");
  });
  it("rejects malformed navigation context", () => {
    expect(
      readTaskSearchContext({
        doskaTaskSearch: {
          filters: { ...emptyTaskSearch, state: "private" },
          page: 0,
          scrollY: 0,
        },
      }),
    ).toBeNull();
  });
});

it("searches labels globally and a boolean field in its project, then clears field on project switch", async () => {
  vi.mocked(api.getProjectFields).mockResolvedValue({
    revision: 0,
    requiredTaskFields: [],
    fields: [
      {
        id: "bool",
        name: "Checked",
        type: "boolean",
        required: false,
        defaultValue: null,
        options: null,
        archivedAt: null,
        position: 0,
      },
    ],
  });
  mount();
  const label = await screen.findByLabelText("searchLabel");
  fireEvent.change(label, { target: { value: "Release" } });
  await waitFor(() =>
    expect(api.searchTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ labelName: "Release" }),
    ),
  );
  fireEvent.change(screen.getByLabelText("project"), {
    target: { value: "p" },
  });
  await screen.findByRole("option", { name: "Checked" });
  fireEvent.change(screen.getByLabelText("searchCustomField"), {
    target: { value: "bool" },
  });
  fireEvent.change(await screen.findByLabelText("Checked"), {
    target: { value: "false" },
  });
  await waitFor(() =>
    expect(api.searchTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId: "p",
        customFieldId: "bool",
        customFieldValue: "false",
      }),
    ),
  );
  fireEvent.change(screen.getByLabelText("project"), { target: { value: "" } });
  await waitFor(() =>
    expect(api.searchTasks).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ customFieldId: "bool" }),
    ),
  );
  expect(screen.queryByLabelText("Checked")).toBeNull();
});

it("filters by a selected resource within the chosen project and clears it when project changes", async () => {
  const { resourceLinksApi } = await import("./resource-links-api");
  vi.spyOn(resourceLinksApi, "search").mockResolvedValue({
    version: 1,
    items: [
      {
        displayName: "Mail service",
        objectKind: "service",
        selection: {
          resourceId: "11111111-1111-4111-8111-111111111111",
          sourceKind: "platform",
        },
      },
    ],
    nextCursor: null,
  });
  vi.spyOn(resourceLinksApi, "resolve").mockResolvedValue({
    index: 0,
    available: true,
    descriptor: { displayName: "Mail service", objectKind: "service" },
  });
  mount();
  await screen.findByText("Found task");
  expect(screen.getByLabelText("searchResource")).toBeDisabled();
  fireEvent.change(screen.getByLabelText("project"), {
    target: { value: "p" },
  });
  fireEvent.change(screen.getByLabelText("searchResource"), {
    target: { value: "Mail" },
  });
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Mail service resourceKind_service",
    }),
  );
  await waitFor(() =>
    expect(api.searchTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId: "p",
        resourceId: "11111111-1111-4111-8111-111111111111",
        sourceKind: "platform",
      }),
    ),
  );
  expect(resourceLinksApi.search).toHaveBeenCalledWith(
    "p",
    "Mail",
    undefined,
    expect.any(AbortSignal),
  );
  expect(vi.mocked(api.searchTasks).mock.calls.at(-1)?.[0]).not.toHaveProperty(
    "resourceSource",
  );
  fireEvent.change(screen.getByLabelText("project"), { target: { value: "" } });
  await waitFor(() =>
    expect(api.searchTasks).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ resourceId: expect.anything() }),
    ),
  );
  expect(screen.getByLabelText("searchResource")).toBeDisabled();
});
