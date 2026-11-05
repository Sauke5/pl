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
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "./api";
import { DoskaMyTasks } from "./my-tasks";
import { readMyTasksContext } from "./task-navigation";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("./shell", () => ({ doskaHref: (path: string) => `/doska${path}` }));
const task = {
  id: "t",
  projectId: "p",
  title: "Task",
  projectName: "Project",
  columnName: "Todo",
  dueDate: null,
};
function mount() {
  const root = createRootRoute({ component: Outlet });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/my-tasks",
    component: DoskaMyTasks,
  });
  const board = createRoute({
    getParentRoute: () => root,
    path: "/projects/$projectId",
    component: () => <p>Board</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([home, board]),
    history: createMemoryHistory({ initialEntries: ["/doska/my-tasks"] }),
    basepath: "/doska/",
  });
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={cache}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("My tasks navigation", () => {
  it("hides pagination for a single page", async () => {
    vi.spyOn(api, "listMyTasks").mockResolvedValue([task] as never);
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    mount();
    await screen.findByText("Task");
    expect(screen.queryByText("previous")).toBeNull();
    expect(screen.queryByText("next")).toBeNull();
  });
  it("preserves archive, page and scroll on task navigation and return", async () => {
    vi.spyOn(api, "listMyTasks").mockImplementation(
      async ({ offset } = {}) =>
        (offset
          ? [task]
          : Array.from({ length: 40 }, (_, i) => ({
              ...task,
              id: `t${i}`,
              title: `Task ${i}`,
            }))) as never,
    );
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const router = mount();
    await screen.findByText("Task 0");
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() =>
      expect(api.listMyTasks).toHaveBeenCalledWith({
        limit: 40,
        offset: 0,
        archived: true,
      }),
    );
    fireEvent.click(await screen.findByText("next"));
    await screen.findByText("Task");
    expect(screen.getByText("previous")).not.toHaveProperty("disabled", true);
    vi.spyOn(window, "scrollY", "get").mockReturnValue(325);
    fireEvent.click(screen.getByText("Task"));
    await screen.findByText("Board");
    const context = readMyTasksContext(router.state.location.state);
    expect(context).toEqual({ page: 1, archived: true, scrollY: 325 });
    expect(router.state.location.search).toEqual({ taskId: "t" });
    await act(async () => {
      await router.navigate({
        to: "/my-tasks",
        state: { doskaMyTasks: context },
        replace: true,
        resetScroll: false,
      } as never);
    });
    await screen.findByText("Task");
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 325, behavior: "instant" });
    fireEvent.click(screen.getByText("Task"));
    await screen.findByText("Board");
    await act(async () => {
      router.history.back();
    });
    await screen.findByText("Task");
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", true);
    expect(screen.getByText("previous")).not.toHaveProperty("disabled", true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 325, behavior: "instant" });
  });
  it("does not invent an origin for direct task links", () => {
    expect(readMyTasksContext({})).toBeNull();
    expect(
      readMyTasksContext({
        doskaMyTasks: { page: -1, archived: true, scrollY: 2 },
      }),
    ).toBeNull();
  });
});
