import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { api } from "./api";
import { DoskaBoard } from "./board";
const navigate = vi.fn();
const search = { panel: "members", taskId: "existing-task" };
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useSearch: () => search,
  useRouterState: () => null,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("./members-panel", () => ({
  DoskaMembersPanel: ({ onClose }: { onClose: () => void }) => (
    <button onClick={onClose}>Close members</button>
  ),
}));
vi.mock("./task-drawer", () => ({ DoskaTaskDrawer: () => null }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  search.panel = "members";
  navigate.mockClear();
});
function renderBoard() {
  vi.spyOn(api, "getProject").mockResolvedValue({
    id: "p",
    name: "Project",
    archivedAt: null,
  } as never);
  vi.spyOn(api, "getAccess").mockResolvedValue({
    readContent: true,
    workOnTasks: false,
    manageSettings: true,
  } as never);
  vi.spyOn(api, "listColumns").mockResolvedValue([]);
  vi.spyOn(api, "listTasks").mockResolvedValue([]);
  vi.spyOn(api, "listMembers").mockResolvedValue({
    owner: { userId: "me", name: "Me" },
    members: [],
  } as never);
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={cache}>
      <DoskaBoard projectId="p" />
    </QueryClientProvider>,
  );
}
it("opens members from the deep link and removes only the panel query when closing", async () => {
  renderBoard();
  fireEvent.click(await screen.findByText("Close members"));
  expect(navigate).toHaveBeenCalledWith({
    to: "/projects/$projectId",
    params: { projectId: "p" },
    search: { taskId: "existing-task" },
    replace: true,
    resetScroll: false,
  });
});

it("keeps project actions clickable when Safari blurs without a related target", async () => {
  search.panel = "";
  renderBoard();
  const trigger = await screen.findByText("projectMenu");
  const menu = trigger.closest("details")!;
  menu.open = true;
  trigger.focus();
  const action = screen.getByRole("button", { name: "participants" });
  fireEvent.pointerDown(action);
  fireEvent.blur(trigger, { relatedTarget: null });
  expect(menu.open).toBe(true);
  fireEvent.click(action);
  expect(await screen.findByText("Close members")).toBeInTheDocument();
  expect(menu.open).toBe(false);
});
it("dismisses the project menu on outside pointer and keyboard focus", async () => {
  search.panel = "";
  renderBoard();
  const trigger = await screen.findByText("projectMenu");
  const menu = trigger.closest("details")!;
  menu.open = true;
  fireEvent.pointerDown(document.body);
  expect(menu.open).toBe(false);
  menu.open = true;
  render(<button>Outside menu</button>);
  fireEvent.focusIn(screen.getByRole("button", { name: "Outside menu" }), {
    relatedTarget: trigger,
  });
  expect(menu.open).toBe(false);
});
