import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { api } from "./api";
import { DoskaNotificationCenter } from "./notification-center";
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("./shell", () => ({ doskaHref: (path: string) => `/doska${path}` }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
function mount() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={cache}>
      <DoskaNotificationCenter onClose={() => {}} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  vi.spyOn(api, "listNotifications").mockResolvedValue({
    items: [],
    nextCursor: null,
  });
  vi.spyOn(api, "notificationPreferences").mockResolvedValue({
    dueDateReminderEnabled: true,
  });
  vi.spyOn(api, "updateNotificationPreferences").mockResolvedValue({
    dueDateReminderEnabled: false,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("saves the unchecked preference and reads the persisted value on reopening", async () => {
  const view = mount();
  const checkbox = await screen.findByLabelText("notificationReminders");
  expect(checkbox).toBeChecked();
  fireEvent.click(checkbox);
  await waitFor(() =>
    expect(api.updateNotificationPreferences).toHaveBeenCalledWith({
      dueDateReminderEnabled: false,
    }),
  );
  await waitFor(() => expect(checkbox).toBeEnabled());
  expect(checkbox).not.toBeChecked();
  view.unmount();
  vi.mocked(api.notificationPreferences).mockResolvedValue({
    dueDateReminderEnabled: false,
  });
  mount();
  expect(
    await screen.findByLabelText("notificationReminders"),
  ).not.toBeChecked();
});
it("rolls back a failed save and allows an explicit retry", async () => {
  vi.mocked(api.updateNotificationPreferences).mockRejectedValueOnce(
    new Error("offline"),
  );
  mount();
  const checkbox = await screen.findByLabelText("notificationReminders");
  fireEvent.click(checkbox);
  await screen.findByText("saveError");
  expect(checkbox).toBeChecked();
  expect(checkbox).toBeEnabled();
  fireEvent.click(screen.getByText("retry"));
  await waitFor(() => expect(checkbox).not.toBeChecked());
  expect(api.updateNotificationPreferences).toHaveBeenCalledTimes(2);
});
it("does not invent an enabled preference after loading fails", async () => {
  vi.mocked(api.notificationPreferences).mockRejectedValueOnce(
    new Error("offline"),
  );
  mount();
  await screen.findByText("notificationPreferencesError");
  expect(
    screen.queryByLabelText("notificationReminders"),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("retry"));
  expect(await screen.findByLabelText("notificationReminders")).toBeChecked();
});
it("renders both deadline event labels with task links", async () => {
  vi.mocked(api.listNotifications).mockResolvedValue({
    items: ["doska.task_due_reminder", "doska.task_overdue"].map(
      (type, index) => ({
        id: String(index),
        type,
        destination: "task",
        taskId: "task",
        taskTitle: `Task ${index}`,
        taskNumber: 1,
        projectId: "p",
        projectName: "Project",
        createdAt: "2026-10-23T10:00:00Z",
        isRead: true,
        invitationId: null,
        requestId: null,
        affectedUserName: null,
      }),
    ),
    nextCursor: null,
  } as never);
  mount();
  await screen.findByText("notificationDueReminder");
  expect(screen.getByText("notificationOverdue")).toBeInTheDocument();
  expect(screen.getByText("Task 0").closest("a")).toHaveAttribute(
    "href",
    "/doska/projects/p?taskId=task",
  );
});
