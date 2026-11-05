import { useEffect } from "react";
import {
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
import { api, type Column, type CreateTaskInput } from "./api";
import { DoskaTaskImport } from "./task-import-panel";
import { TaskImportError } from "./task-import-error";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { row?: number }) =>
      values?.row ? `${key}:${values.row}` : key,
  }),
}));
vi.mock("./task-import-editor", () => ({
  TaskImportEditor: ({
    tasks,
    onValidityChange,
    onChange,
  }: {
    tasks: CreateTaskInput[];
    onValidityChange: (valid: boolean) => void;
    onChange: (tasks: CreateTaskInput[]) => void;
  }) => {
    useEffect(() => onValidityChange(true), [onValidityChange]);
    return (
      <div>
        <p>{tasks[0].title}</p>
        <button
          type="button"
          onClick={() =>
            onChange(tasks.map((task) => ({ ...task, title: "Edited" })))
          }
        >
          edit-preview
        </button>
      </div>
    );
  },
}));
const columns = [
  { id: "planned", name: "Planned", slug: "to-do", semanticState: "planned" },
] as Column[];
const source = [
  {
    title: "Server room",
    description: "**Keep Markdown**",
    status: "to-do",
    dueDate: "2026-11-10T00:00:00Z",
    userId: "user@example.com",
  },
];
function mount() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={cache}>
      <DoskaTaskImport projectId="p1" columns={columns} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  return cache;
}
async function load(content: unknown = source) {
  const file = new File([JSON.stringify({ tasks: content })], "tasks.json", {
    type: "application/json",
  });
  Object.defineProperty(file, "text", {
    value: async () => JSON.stringify({ tasks: content }),
  });
  fireEvent.change(screen.getByLabelText("importFile"), {
    target: { files: [file] },
  });
  await waitFor(() =>
    expect(screen.getByText("importReview")).not.toBeDisabled(),
  );
}
async function review() {
  fireEvent.click(screen.getByText("importReview"));
  await waitFor(() =>
    expect(screen.getByText("importSubmit")).not.toBeDisabled(),
  );
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  vi.spyOn(api, "listMembers").mockResolvedValue({
    owner: { userId: "owner", name: "Owner" },
    members: [
      { userId: "reader", name: "Observer", role: "observer" },
      { userId: "worker", name: "Worker", role: "participant" },
    ],
  } as Awaited<ReturnType<typeof api.listMembers>>);
  vi.spyOn(api, "importTasks").mockResolvedValue({
    taskIds: ["t1"],
    imported: 1,
    replayed: false,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("task import review", () => {
  it("does not import on selection, excludes observers, and submits reviewed dates and Markdown", async () => {
    mount();
    await load();
    expect(api.importTasks).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("option", { name: "Observer" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("importAssigneeFor")).toHaveValue(
      "user@example.com",
    );
    fireEvent.change(screen.getByLabelText("importAssigneeFor"), {
      target: { value: "worker" },
    });
    await review();
    fireEvent.click(screen.getByText("edit-preview"));
    fireEvent.click(screen.getByText("importSubmit"));
    await screen.findByText("importDone");
    expect(api.importTasks).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.importTasks).mock.calls[0][1].tasks[0]).toMatchObject({
      title: "Edited",
      description: "**Keep Markdown**",
      columnId: "planned",
      due: { date: "2026-11-10" },
      userId: "worker",
    });
  });
  it("locks editing and retries the identical request after a lost response", async () => {
    vi.mocked(api.importTasks).mockRejectedValueOnce(new TypeError("network"));
    mount();
    await load();
    await review();
    fireEvent.click(screen.getByText("importSubmit"));
    await screen.findByText("importUncertain");
    expect(screen.getByText("edit-preview")).toBeDisabled();
    fireEvent.click(screen.getByText("importRetry"));
    await screen.findByText("importDone");
    expect(vi.mocked(api.importTasks).mock.calls[1][1]).toBe(
      vi.mocked(api.importTasks).mock.calls[0][1],
    );
  });
  it("reports a rejected task row and allows review correction", async () => {
    vi.mocked(api.importTasks).mockRejectedValueOnce(
      new TaskImportError(400, "IMPORT_TASK_INVALID", [
        { path: "body.tasks.0", message: "required" },
      ]),
    );
    mount();
    await load();
    await review();
    fireEvent.click(screen.getByText("importSubmit"));
    await screen.findByText("importInvalidRow:1");
    expect(screen.getByText("edit-preview")).not.toBeDisabled();
    fireEvent.click(screen.getByText("edit-preview"));
    fireEvent.click(screen.getByText("importSubmit"));
    await screen.findByText("importDone");
    expect(
      vi.mocked(api.importTasks).mock.calls[1][1].clientRequestId,
    ).not.toBe(vi.mocked(api.importTasks).mock.calls[0][1].clientRequestId);
  });
  it("requires explicit acknowledgement before dropping unsupported fields", async () => {
    mount();
    await load([{ title: "Task", extra: "preserve me" }]);
    fireEvent.click(screen.getByText("importReview"));
    expect(screen.getByText("importSubmit")).toBeDisabled();
    expect(screen.getByText(/preserve me/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("importDiscardUnknown"));
    expect(screen.getByText("importSubmit")).not.toBeDisabled();
    expect(api.importTasks).not.toHaveBeenCalled();
  });
});
