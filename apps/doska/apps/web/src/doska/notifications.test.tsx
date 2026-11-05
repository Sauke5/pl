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
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { api } from "./api";
import { DoskaNotificationBell } from "./notification-bell";
const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("./shell", () => ({ doskaHref: (path: string) => `/doska${path}` }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const item = {
  id: "n1",
  destination: "task",
  invitationId: null,
  requestId: null,
  type: "doska.task_assigned",
  isRead: false,
  createdAt: "2026-10-23T10:00:00.000000Z",
  taskId: "t",
  taskTitle: "Private task",
  taskNumber: 12,
  projectId: "p",
  projectName: "Project",
};
function mount() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={cache}>
      <DoskaNotificationBell />
    </QueryClientProvider>,
  );
  return cache;
}
beforeEach(() => {
  vi.spyOn(api, "notificationPreferences").mockResolvedValue({
    dueDateReminderEnabled: true,
  });
  navigate.mockReset();
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(api, "notificationUnreadCount").mockResolvedValue({ count: 2 });
  vi.spyOn(api, "listNotifications").mockResolvedValue({
    items: [item],
    nextCursor: null,
  } as never);
  vi.spyOn(api, "markNotificationRead").mockResolvedValue({ id: "n1" });
  vi.spyOn(api, "readAllNotifications").mockResolvedValue({ count: 1 });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("notification center", () => {
  it("loads more with the opaque cursor and marks a task notification before navigating", async () => {
    vi.mocked(api.listNotifications)
      .mockResolvedValueOnce({ items: [item], nextCursor: "opaque" } as never)
      .mockResolvedValueOnce({
        items: [{ ...item, id: "n2", taskTitle: "Second task", isRead: true }],
        nextCursor: null,
      } as never);
    mount();
    await screen.findByRole("button", { name: "notificationsUnread" });
    fireEvent.click(
      screen.getByRole("button", { name: "notificationsUnread" }),
    );
    await screen.findByText("Private task");
    fireEvent.click(
      screen.getByRole("button", { name: "loadMore", hidden: true }),
    );
    await screen.findByText("Second task");
    expect(api.listNotifications).toHaveBeenCalledWith({
      limit: 30,
      cursor: "opaque",
    });
    fireEvent.click(screen.getByText("Private task"));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/projects/$projectId",
        params: { projectId: "p" },
        search: { taskId: "t" },
      }),
    );
    expect(api.markNotificationRead).toHaveBeenCalledWith("n1");
  });
  it.each([
    ["invitations", "/doska/invitations", { to: "/invitations" }],
    [
      "members",
      "/doska/projects/p?panel=members",
      {
        to: "/projects/$projectId",
        params: { projectId: "p" },
        search: { panel: "members" },
      },
    ],
    [
      "project",
      "/doska/projects/p",
      { to: "/projects/$projectId", params: { projectId: "p" }, search: {} },
    ],
  ])(
    "routes %s notifications alongside tasks without task links",
    async (destination, href, target) => {
      vi.mocked(api.listNotifications).mockResolvedValue({
        items: [
          item,
          {
            ...item,
            id: "membership",
            type: "doska.join_requested",
            destination,
            projectName: "Membership project",
            taskId: null,
            taskTitle: null,
            taskNumber: null,
          },
        ],
        nextCursor: null,
      } as never);
      mount();
      fireEvent.click(
        await screen.findByRole("button", { name: "notificationsUnread" }),
      );
      const title = await screen.findByText("Membership project");
      expect(title.closest("a")).toHaveAttribute("href", href);
      expect(screen.getByText("Private task").closest("a")).toHaveAttribute(
        "href",
        "/doska/projects/p?taskId=t",
      );
      fireEvent.click(title);
      await waitFor(() => expect(navigate).toHaveBeenCalledWith(target));
      expect(api.markNotificationRead).toHaveBeenCalledWith("membership");
    },
  );
  it.each(["Иван Иванов", null])(
    "shows a department transfer for %s once with its project and members link",
    async (affectedUserName) => {
      vi.mocked(api.listNotifications).mockResolvedValue({
        items: [
          item,
          {
            ...item,
            id: "transfer",
            type: "doska.member_department_changed",
            destination: "members",
            affectedUserName,
            projectName: "Transfer project",
            taskId: null,
            taskTitle: null,
            taskNumber: null,
          },
        ],
        nextCursor: null,
      } as never);
      mount();
      fireEvent.click(
        await screen.findByRole("button", { name: "notificationsUnread" }),
      );
      const name = await screen.findByText(
        affectedUserName ?? "notificationEmployee",
      );
      const link = name.closest("a")!;
      expect(link).toHaveAttribute("href", "/doska/projects/p?panel=members");
      expect(link).toHaveTextContent("notificationDepartmentChanged");
      expect(screen.getAllByText(/Transfer project/)).toHaveLength(1);
      expect(screen.getByText("Private task")).toBeInTheDocument();
      fireEvent.click(name);
      await waitFor(() =>
        expect(navigate).toHaveBeenCalledWith({
          to: "/projects/$projectId",
          params: { projectId: "p" },
          search: { panel: "members" },
        }),
      );
      expect(api.markNotificationRead).toHaveBeenCalledWith("transfer");
    },
  );
  it("hides cached rows and the unread badge after refetch errors", async () => {
    const cache = mount();
    await screen.findByText("2");
    fireEvent.click(
      screen.getByRole("button", { name: "notificationsUnread" }),
    );
    await screen.findByText("Private task");
    vi.mocked(api.listNotifications).mockRejectedValue(
      new Error("access changed"),
    );
    vi.mocked(api.notificationUnreadCount).mockRejectedValue(
      new Error("access changed"),
    );
    await act(async () => {
      await cache.invalidateQueries({ queryKey: ["doska", "notifications"] });
    });
    await screen.findByText("loadError");
    expect(screen.queryByText("Private task")).not.toBeInTheDocument();
    expect(screen.queryByText("2")).not.toBeInTheDocument();
  });
  it("marks all read and refreshes count and list", async () => {
    mount();
    await screen.findByRole("button", { name: "notificationsUnread" });
    fireEvent.click(
      screen.getByRole("button", { name: "notificationsUnread" }),
    );
    await screen.findByText("Private task");
    vi.mocked(api.listNotifications).mockResolvedValue({
      items: [{ ...item, isRead: true }],
      nextCursor: null,
    } as never);
    vi.mocked(api.notificationUnreadCount).mockResolvedValue({ count: 0 });
    fireEvent.click(
      screen.getByRole("button", {
        name: "notificationsReadAll",
        hidden: true,
      }),
    );
    await waitFor(() =>
      expect(api.readAllNotifications).toHaveBeenCalledOnce(),
    );
    await waitFor(() =>
      expect(screen.queryByText("2")).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", {
        name: "notificationMarkRead",
        hidden: true,
      }),
    ).not.toBeInTheDocument();
  });
  it("closes with Escape and restores focus to the bell", async () => {
    mount();
    const bell = await screen.findByRole("button", {
      name: "notificationsUnread",
    });
    bell.focus();
    fireEvent.click(bell);
    await screen.findByText("Private task");
    const dialog = document.querySelector("dialog")!;
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(document.querySelector("dialog")).toBeNull();
    expect(bell).toHaveFocus();
  });
  it("polls every 30 seconds only while visible", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    mount();
    await waitFor(() =>
      expect(api.notificationUnreadCount).toHaveBeenCalledOnce(),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    await waitFor(() =>
      expect(api.notificationUnreadCount).toHaveBeenCalledTimes(2),
    );
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(api.notificationUnreadCount).toHaveBeenCalledTimes(2);
  });
  it("does not request notifications while the tab is hidden", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    mount();
    await act(async () => {});
    expect(api.notificationUnreadCount).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(api.notificationUnreadCount).toHaveBeenCalledOnce(),
    );
  });
});
