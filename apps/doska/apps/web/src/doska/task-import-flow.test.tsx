import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { api, type Column } from "./api";
import { DoskaTaskImport } from "./task-import-panel";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("repairs malformed values in the composed preview and imports every row only after correction", async () => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  vi.spyOn(api, "listMembers").mockResolvedValue({
    owner: { userId: "owner", name: "Owner" },
    members: [],
  } as Awaited<ReturnType<typeof api.listMembers>>);
  vi.spyOn(api, "getProjectFields").mockResolvedValue({
    revision: 1,
    requiredTaskFields: [],
    fields: [],
  });
  vi.spyOn(api, "importTasks").mockResolvedValue({
    taskIds: ["t1", "t2"],
    imported: 2,
    replayed: false,
  });
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={cache}>
      <DoskaTaskImport
        projectId="p"
        columns={
          [
            {
              id: "planned",
              name: "Planned",
              slug: "to-do",
              semanticState: "planned",
            },
          ] as Column[]
        }
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const file = new File([""], "tasks.json");
  Object.defineProperty(file, "text", {
    value: async () =>
      JSON.stringify({
        tasks: [
          {
            title: "",
            dueDate: "bad date",
            status: "unknown",
            userId: "user@example.com",
            priority: "Critical",
          },
          { title: "Second", description: "**Preserve me**", status: "to-do" },
        ],
      }),
  });
  fireEvent.change(screen.getByLabelText("importFile"), {
    target: { files: [file] },
  });
  await waitFor(() =>
    expect(screen.getByText("importReview")).not.toBeDisabled(),
  );
  fireEvent.click(screen.getByText("importReview"));
  await screen.findByLabelText("taskTitle *");
  expect(screen.getByText("importSubmit")).toBeDisabled();
  expect(screen.getByLabelText("dueDate")).toHaveValue("bad date");
  expect(api.importTasks).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("taskTitle *"), {
    target: { value: "Repaired" },
  });
  fireEvent.change(screen.getByLabelText("dueDate"), {
    target: { value: "2026-11-10" },
  });
  fireEvent.change(screen.getByLabelText("column *"), {
    target: { value: "planned" },
  });
  fireEvent.change(screen.getByLabelText("responsible"), {
    target: { value: "" },
  });
  fireEvent.change(screen.getByLabelText("priority"), {
    target: { value: "medium" },
  });
  await waitFor(() =>
    expect(screen.getByText("importSubmit")).not.toBeDisabled(),
  );
  fireEvent.click(screen.getByText("importSubmit"));
  await screen.findByText("importDone");
  const tasks = vi.mocked(api.importTasks).mock.calls[0][1].tasks;
  expect(tasks).toHaveLength(2);
  expect(tasks[0]).toMatchObject({
    title: "Repaired",
    columnId: "planned",
    priority: "medium",
    due: { date: "2026-11-10" },
    userId: null,
  });
  expect(tasks[1]).toMatchObject({
    title: "Second",
    description: "**Preserve me**",
  });
});
