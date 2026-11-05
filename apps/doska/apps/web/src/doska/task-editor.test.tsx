import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DoskaTaskEditor } from "./task-editor";
import { DoskaTaskDrawer } from "./task-drawer";
import { api, ApiError, type Task } from "./api";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("./members-panel", () => ({
  DoskaMembersPanel: ({ onClose }: { onClose: () => void }) => (
    <dialog
      open
      aria-label="Project members"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <button onClick={onClose}>Close members</button>
    </dialog>
  ),
}));
vi.mock("./template-selection", () => ({
  DoskaTemplateSelection: () => (
    <label className="doska-template-selection">
      <input type="checkbox" />
      Template selection
    </label>
  ),
}));
vi.mock("./task-history", () => ({ DoskaTaskHistory: () => null }));
vi.mock("./task-comments", () => ({
  DoskaTaskComments: ({
    onDirtyChange,
  }: {
    onDirtyChange: (dirty: boolean) => void;
  }) => <button onClick={() => onDirtyChange(true)}>Mock comment draft</button>,
}));
vi.mock("./task-checklists", () => ({ DoskaTaskChecklists: () => null }));
vi.mock("./task-attachments", () => ({ DoskaTaskAttachments: () => null }));
vi.mock("./task-subtasks", () => ({
  DoskaTaskSubtasks: ({ onCreate }: { onCreate?: () => void }) =>
    onCreate ? <button onClick={onCreate}>Create child</button> : null,
}));
vi.mock("./task-resource-links", () => ({
  DoskaTaskResourceLinks: () => null,
}));
vi.mock("./task-resource-links", () => ({
  DoskaTaskResourceLinks: () => null,
}));
vi.mock("./task-relations", () => ({ DoskaTaskRelations: () => null }));
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
    listMembers: vi.fn(),
    getProjectFields: vi.fn(),
    listProjectLabels: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(),
    updateTask: vi.fn(),
    createTask: vi.fn(),
  },
}));
const task = {
  id: "t",
  title: "Original",
  description: "Description",
  columnId: "todo",
  revision: 1,
  coexecutorIds: [],
  priority: "low",
  userId: null,
  startDate: null,
  dueDate: null,
  dueDateHasTime: false,
  archivedAt: null,
} as unknown as Task;
const columns = [{ id: "todo", name: "Todo" }] as never;
let client: QueryClient;
const changed = vi.fn();
const closed = vi.fn();
const editor = (value?: Task, parentTaskId?: string) => (
  <QueryClientProvider client={client}>
    <DoskaTaskEditor
      projectId="p"
      task={value}
      parentTaskId={parentTaskId}
      columns={columns}
      canWork
      canDelete
      onChanged={changed}
      onClose={closed}
    />
  </QueryClientProvider>
);
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.mocked(api.listMembers).mockResolvedValue({
    owner: { userId: "me", name: "Me" },
    members: [],
  } as never);
  vi.mocked(api.getTask).mockResolvedValue(task);
  const fields = { revision: 1, requiredTaskFields: [], fields: [] };
  vi.mocked(api.getProjectFields).mockResolvedValue(fields);
  client.setQueryData(["doska", "project-fields", "p"], fields);
});
afterEach(cleanup);
describe("task draft lifecycle", () => {
  it("opens project members over a new-task draft and preserves it on close", async () => {
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
    const view = render(
      <QueryClientProvider client={client}>
        <DoskaTaskDrawer
          projectId="p"
          columns={columns}
          canWork
          canDelete
          canManageParticipants
          onChanged={changed}
          onClose={closed}
        />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText("taskTitle"), {
      target: { value: "Draft before members" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "taskProjectParticipants",
        hidden: true,
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "Project members" }),
    ).toBeInTheDocument();
    const taskDialog = view.container.querySelector(".doska-task-drawer")!;
    fireEvent.keyDown(taskDialog, { key: "Escape" });
    expect(closed).not.toHaveBeenCalled();
    expect(screen.queryByText("taskDiscardPrompt")).not.toBeInTheDocument();
    fireEvent(
      taskDialog.nextElementSibling!,
      new Event("cancel", { bubbles: false, cancelable: true }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Project members" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("taskTitle")).toHaveValue(
      "Draft before members",
    );
    expect(closed).not.toHaveBeenCalled();
  });
  it("does not offer participant management without the capability", () => {
    render(editor());
    expect(screen.getByText("taskParticipantAssignment")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "taskProjectParticipants" }),
    ).not.toBeInTheDocument();
  });

  it("shows a discoverable required title and creates consecutive tasks", async () => {
    vi.mocked(api.createTask).mockResolvedValue(task);
    const first = render(editor());
    const title = screen.getByLabelText("taskTitle");
    expect(title).toHaveAttribute("placeholder", "taskTitlePlaceholder");
    expect(title.closest("label")).toHaveClass("is-new");
    fireEvent.change(screen.getByLabelText("description"), {
      target: { value: "Only description" },
    });
    fireEvent.blur(title);
    expect(screen.getByText("taskTitleRequired")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "createTask" })).toBeDisabled();
    fireEvent.change(title, { target: { value: "First task" } });
    fireEvent.click(screen.getByRole("button", { name: "createTask" }));
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(api.createTask).toHaveBeenCalledWith(
      "p",
      expect.objectContaining({
        title: "First task",
        description: "Only description",
      }),
    );
    first.unmount();
    render(editor());
    fireEvent.change(screen.getByLabelText("taskTitle"), {
      target: { value: "Second task" },
    });
    fireEvent.click(screen.getByRole("button", { name: "createTask" }));
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(2));
  });
  it("shows retry after an autosave error and keeps task actions in the menu", async () => {
    vi.mocked(api.updateTask)
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce({ ...task, title: "Retry draft", revision: 2 });
    render(editor(task));
    expect(
      screen.queryByRole("button", { name: "save" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("taskActions").closest("details"),
    ).not.toHaveAttribute("open");
    fireEvent.change(screen.getByLabelText("taskTitle"), {
      target: { value: "Retry draft" },
    });
    await screen.findByRole("button", { name: "retry" }, { timeout: 1600 });
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    await screen.findByText("taskSaved");
    expect(api.updateTask).toHaveBeenCalledTimes(2);
  });
  it("keeps the drawer open and updates the baseline after saving", async () => {
    vi.mocked(api.updateTask).mockResolvedValue({
      ...task,
      title: "Edited",
      revision: 2,
    });
    render(editor(task));
    fireEvent.change(screen.getByLabelText("taskTitle"), {
      target: { value: "Edited" },
    });
    fireEvent.submit(document.getElementById("doska-task-edit-form")!);
    await screen.findByText("taskSaved");
    expect(closed).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "save" }),
    ).not.toBeInTheDocument();
  });
  it("autosaves serially and retains text typed during the first request", async () => {
    let resolveFirst!: (value: Task) => void;
    vi.mocked(api.updateTask)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ ...task, title: "Second", revision: 3 });
    const view = render(editor(task));
    fireEvent.change(screen.getByLabelText("taskTitle"), {
      target: { value: "First" },
    });
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledTimes(1), {
      timeout: 1600,
    });
    expect(screen.getByLabelText("taskTitle")).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText("taskTitle"), {
      target: { value: "Second" },
    });
    await act(async () => {
      resolveFirst({ ...task, title: "First", revision: 2 });
    });
    view.rerender(editor({ ...task, title: "First", revision: 2 }));
    expect(screen.getByLabelText("taskTitle")).toHaveValue("Second");
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledTimes(2), {
      timeout: 1600,
    });
    expect(api.updateTask).toHaveBeenLastCalledWith(
      "p",
      "t",
      expect.objectContaining({ title: "Second", expectedRevision: 2 }),
    );
    await screen.findByText("taskSaved");
  });
  it("pauses autosave after conflict even when the draft changes", async () => {
    vi.mocked(api.updateTask).mockRejectedValue(new ApiError(409, "Conflict"));
    render(editor(task));
    fireEvent.change(screen.getByLabelText("taskTitle"), {
      target: { value: "Draft" },
    });
    await screen.findByText("taskConflict", {}, { timeout: 1600 });
    fireEvent.change(screen.getByLabelText("taskTitle"), {
      target: { value: "Keep this" },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    expect(api.updateTask).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("taskTitle")).toHaveValue("Keep this");
  });
  it("accepts a new pristine server baseline before the next edit", async () => {
    const view = render(editor(task));
    view.rerender(editor({ ...task, title: "New server title", revision: 4 }));
    await waitFor(() =>
      expect(screen.getByLabelText("taskTitle")).toHaveValue(
        "New server title",
      ),
    );
    fireEvent.change(screen.getByLabelText("taskTitle"), {
      target: { value: "Next edit" },
    });
    fireEvent.submit(document.getElementById("doska-task-edit-form")!);
    await waitFor(() =>
      expect(api.updateTask).toHaveBeenCalledWith(
        "p",
        "t",
        expect.objectContaining({ expectedRevision: 4, title: "Next edit" }),
      ),
    );
  });
  it("advances revision for checklist/comment changes without losing an unsaved task draft", async () => {
    const view = render(editor(task));
    fireEvent.change(screen.getByLabelText("taskTitle"), {
      target: { value: "My draft" },
    });
    view.rerender(editor({ ...task, revision: 5 }));
    fireEvent.submit(document.getElementById("doska-task-edit-form")!);
    await waitFor(() =>
      expect(api.updateTask).toHaveBeenCalledWith(
        "p",
        "t",
        expect.objectContaining({ expectedRevision: 5, title: "My draft" }),
      ),
    );
  });
  it("never rebases a dirty draft over changed server fields and retains the draft after conflict", async () => {
    vi.mocked(api.updateTask).mockRejectedValue(new ApiError(409, "Conflict"));
    const view = render(editor(task));
    fireEvent.change(screen.getByLabelText("taskTitle"), {
      target: { value: "My draft" },
    });
    view.rerender(
      editor({ ...task, description: "Other person's edit", revision: 6 }),
    );
    fireEvent.submit(document.getElementById("doska-task-edit-form")!);
    await screen.findByText("taskConflict");
    expect(api.updateTask).toHaveBeenCalledWith(
      "p",
      "t",
      expect.objectContaining({ expectedRevision: 1 }),
    );
    expect(screen.getByLabelText("taskTitle")).toHaveValue("My draft");
    expect(closed).not.toHaveBeenCalled();
    vi.mocked(api.getTask).mockResolvedValue({
      ...task,
      title: "Latest",
      revision: 7,
    });
    fireEvent.click(screen.getByRole("button", { name: "taskLoadLatest" }));
    await waitFor(() =>
      expect(screen.getByLabelText("taskTitle")).toHaveValue("Latest"),
    );
  });
  it("requires confirmation to close dirty content", async () => {
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <DoskaTaskDrawer
          projectId="p"
          taskId="t"
          columns={columns}
          canWork
          canDelete
          onChanged={changed}
          onClose={closed}
        />
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByLabelText("taskTitle"), {
      target: { value: "Unsaved" },
    });
    // jsdom has no modal implementation; inspect the dialog's descendants directly.
    fireEvent.click(
      screen.getByRole("button", { name: "close", hidden: true }),
    );
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByText("taskDiscardPrompt")).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    expect(api.updateTask).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "taskKeepEditing", hidden: true }),
    );
    expect(screen.getByLabelText("taskTitle")).toHaveValue("Unsaved");
    fireEvent.click(
      screen.getByRole("button", { name: "close", hidden: true }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "taskDiscard", hidden: true }),
    );
    expect(closed).toHaveBeenCalledOnce();
  });
  it("closes only after both pointer edges land outside the drawer", async () => {
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
    vi.stubGlobal("PointerEvent", MouseEvent);
    const view = render(
      <QueryClientProvider client={client}>
        <DoskaTaskDrawer
          projectId="p"
          taskId="t"
          columns={columns}
          canWork
          canDelete
          onChanged={changed}
          onClose={closed}
        />
      </QueryClientProvider>,
    );
    await screen.findByLabelText("taskTitle");
    const dialog = view.container.querySelector("dialog")!;
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
      left: 500,
      right: 1000,
      top: 0,
      bottom: 800,
    } as DOMRect);
    fireEvent.pointerDown(dialog, { clientX: 600, clientY: 100 });
    fireEvent.pointerUp(dialog, { clientX: 100, clientY: 100 });
    fireEvent.click(dialog, { clientX: 100, clientY: 100 });
    expect(closed).not.toHaveBeenCalled();
    fireEvent.pointerDown(dialog, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(dialog, { clientX: 100, clientY: 100 });
    fireEvent.click(dialog, { clientX: 100, clientY: 100 });
    expect(closed).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
  it("saves before closing when the user confirms", async () => {
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
    vi.mocked(api.updateTask).mockResolvedValue({
      ...task,
      title: "Saved on exit",
      revision: 2,
    });
    render(
      <QueryClientProvider client={client}>
        <DoskaTaskDrawer
          projectId="p"
          taskId="t"
          columns={columns}
          canWork
          canDelete
          onChanged={changed}
          onClose={closed}
        />
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByLabelText("taskTitle"), {
      target: { value: "Saved on exit" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "close", hidden: true }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "taskSaveAndClose", hidden: true }),
    );
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(api.updateTask).toHaveBeenCalledWith(
      "p",
      "t",
      expect.objectContaining({ title: "Saved on exit" }),
    );
  });
  it("protects auxiliary drafts without auto-submitting them", async () => {
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <DoskaTaskDrawer
          projectId="p"
          taskId="t"
          columns={columns}
          canWork
          canDelete
          onChanged={changed}
          onClose={closed}
        />
      </QueryClientProvider>,
    );
    await screen.findByLabelText("taskTitle");
    fireEvent.click(
      screen.getByRole("button", { name: "Mock comment draft", hidden: true }),
    );
    fireEvent.change(screen.getByLabelText("taskTitle"), {
      target: { value: "Dirty with comment" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "close", hidden: true }),
    );
    expect(screen.getByText("taskAuxiliaryDraftPrompt")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "taskSaveAndClose", hidden: true }),
    ).not.toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    expect(api.updateTask).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "taskKeepEditing", hidden: true }),
    );
    expect(screen.getByLabelText("taskTitle")).toHaveValue(
      "Dirty with comment",
    );
  });
  it("protects a draft when input and outside click arrive before the next render", async () => {
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
    vi.stubGlobal("PointerEvent", MouseEvent);
    const view = render(
      <QueryClientProvider client={client}>
        <DoskaTaskDrawer
          projectId="p"
          taskId="t"
          columns={columns}
          canWork
          canDelete
          onChanged={changed}
          onClose={closed}
        />
      </QueryClientProvider>,
    );
    const description = await screen.findByLabelText("description");
    const dialog = view.container.querySelector("dialog")!;
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
      left: 500,
      right: 1000,
      top: 0,
      bottom: 800,
    } as DOMRect);
    act(() => {
      fireEvent.input(description, { target: { value: "Immediate draft" } });
      fireEvent.pointerDown(dialog, { clientX: 100, clientY: 100 });
      fireEvent.pointerUp(dialog, { clientX: 100, clientY: 100 });
      fireEvent.click(dialog, { clientX: 100, clientY: 100 });
    });
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByText("taskDiscardPrompt")).toBeInTheDocument();
    expect(description).toHaveValue("Immediate draft");
    vi.unstubAllGlobals();
  });
});

it("places actions in the drawer header and template selection beside history", async () => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <DoskaTaskDrawer
        projectId="p"
        taskId="t"
        columns={columns}
        canWork
        canDelete
        canManageParticipants
        onClose={closed}
        onChanged={changed}
      />
    </QueryClientProvider>,
  );
  await screen.findByDisplayValue("Original");
  const actions = document.querySelector<HTMLDetailsElement>(
    ".doska-task-action-menu",
  )!;
  expect(actions.closest(".doska-drawer-heading")).toBeTruthy();
  expect(
    screen
      .getByLabelText("Template selection")
      .closest(".doska-task-footer")
      ?.querySelector(".doska-task-history-section"),
  ).toBeTruthy();
  actions.open = true;
  fireEvent.keyDown(actions.querySelector("summary")!, { key: "Escape" });
  expect(actions.open).toBe(false);
  expect(closed).not.toHaveBeenCalled();
  expect(actions.querySelector("summary")).toHaveFocus();
  actions.open = true;
  fireEvent.pointerDown(screen.getByDisplayValue("Original"));
  expect(actions.open).toBe(false);
  expect(closed).not.toHaveBeenCalled();
});
it("closes only the open action menu on the first backdrop click", async () => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <DoskaTaskDrawer
        projectId="p"
        taskId="t"
        columns={columns}
        canWork
        canDelete
        onClose={closed}
        onChanged={changed}
      />
    </QueryClientProvider>,
  );
  await screen.findByDisplayValue("Original");
  const actions = document.querySelector<HTMLDetailsElement>(
    ".doska-task-action-menu",
  )!;
  actions.open = true;
  const dialog = actions.closest("dialog")!;
  fireEvent.pointerDown(dialog, { clientX: -10, clientY: -10 });
  fireEvent.pointerUp(dialog, { clientX: -10, clientY: -10 });
  fireEvent.click(dialog, { clientX: -10, clientY: -10 });
  expect(actions.open).toBe(false);
  expect(closed).not.toHaveBeenCalled();
});

it("autosaves a selected card color and resets it with the latest revision", async () => {
  vi.mocked(api.updateTask)
    .mockResolvedValueOnce({ ...task, cardColor: "purple", revision: 2 })
    .mockResolvedValueOnce({ ...task, cardColor: null, revision: 3 });
  render(editor({ ...task, cardColor: null }));
  fireEvent.click(screen.getByText("taskProperties"));
  expect(
    screen.getByRole("radio", { name: "cardColor_default" }),
  ).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: "cardColor_purple" }));
  await waitFor(
    () =>
      expect(api.updateTask).toHaveBeenCalledWith(
        "p",
        "t",
        expect.objectContaining({ cardColor: "purple", expectedRevision: 1 }),
      ),
    { timeout: 2000 },
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("taskSaved"),
  );
  expect(screen.getByRole("radio", { name: "cardColor_purple" })).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: "cardColor_default" }));
  await waitFor(
    () =>
      expect(api.updateTask).toHaveBeenLastCalledWith(
        "p",
        "t",
        expect.objectContaining({ cardColor: null, expectedRevision: 2 }),
      ),
    { timeout: 2000 },
  );
});
it("keeps the selected color when a concurrent task change causes conflict", async () => {
  vi.mocked(api.updateTask).mockRejectedValue(new ApiError(409, "Conflict"));
  const view = render(editor({ ...task, cardColor: null }));
  fireEvent.click(screen.getByText("taskProperties"));
  fireEvent.click(screen.getByRole("radio", { name: "cardColor_blue" }));
  view.rerender(editor({ ...task, cardColor: "red", revision: 2 }));
  fireEvent.submit(document.getElementById("doska-task-edit-form")!);
  await waitFor(() =>
    expect(api.updateTask).toHaveBeenCalledWith(
      "p",
      "t",
      expect.objectContaining({ cardColor: "blue", expectedRevision: 1 }),
    ),
  );
  expect(screen.getByRole("radio", { name: "cardColor_blue" })).toBeChecked();
});

it.each([undefined, "parent-task"])(
  "requires configured fields on creation including subtask %s",
  async (parentTaskId) => {
    const fields = {
      revision: 1,
      requiredTaskFields: ["description"],
      fields: [
        {
          id: "f",
          name: "Location",
          type: "text",
          required: true,
          defaultValue: null,
          options: null,
          position: 0,
          archivedAt: null,
        },
      ],
    };
    vi.mocked(api.getProjectFields).mockResolvedValue(fields as never);
    client.setQueryData(["doska", "project-fields", "p"], fields);
    vi.mocked(api.createTask).mockResolvedValue(task);
    render(editor(undefined, parentTaskId));
    fireEvent.change(screen.getByLabelText("taskTitle"), {
      target: { value: "New" },
    });
    expect(screen.getByRole("button", { name: "createTask" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("description *"), {
      target: { value: "Details" },
    });
    fireEvent.change(screen.getByLabelText("Location *"), {
      target: { value: "Moscow" },
    });
    fireEvent.click(screen.getByRole("button", { name: "createTask" }));
    await waitFor(() =>
      expect(api.createTask).toHaveBeenCalledWith(
        "p",
        expect.objectContaining({
          customValues: [{ fieldId: "f", value: "Moscow" }],
          description: "Details",
          ...(parentTaskId ? { parentTaskId } : {}),
        }),
      ),
    );
  },
);
it("allows unrelated updates to old tasks missing required fields without clearing fields", async () => {
  const fields = {
    revision: 1,
    requiredTaskFields: ["description"],
    fields: [
      {
        id: "f",
        name: "Location",
        type: "text",
        required: true,
        defaultValue: null,
        options: null,
        position: 0,
        archivedAt: null,
      },
    ],
  };
  vi.mocked(api.getProjectFields).mockResolvedValue(fields as never);
  client.setQueryData(["doska", "project-fields", "p"], fields);
  render(editor({ ...task, description: null, customValues: [] }));
  fireEvent.change(screen.getByLabelText("taskTitle"), {
    target: { value: "Renamed" },
  });
  fireEvent.submit(document.getElementById("doska-task-edit-form")!);
  await waitFor(() =>
    expect(api.updateTask).toHaveBeenCalledWith("p", "t", {
      expectedRevision: 1,
      title: "Renamed",
      customValues: [],
    }),
  );
});
it("does not autosave explicit removal of a required custom value", async () => {
  const fields = {
    revision: 1,
    requiredTaskFields: [],
    fields: [
      {
        id: "f",
        name: "Location",
        type: "text",
        required: true,
        defaultValue: null,
        options: null,
        position: 0,
        archivedAt: null,
      },
    ],
  };
  vi.mocked(api.getProjectFields).mockResolvedValue(fields as never);
  client.setQueryData(["doska", "project-fields", "p"], fields);
  render(
    editor({ ...task, customValues: [{ fieldId: "f", value: "Moscow" }] }),
  );
  fireEvent.click(screen.getByText("taskProperties"));
  fireEvent.change(screen.getByLabelText("Location *"), {
    target: { value: "" },
  });
  fireEvent.submit(document.getElementById("doska-task-edit-form")!);
  expect(api.updateTask).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Location *")).toHaveValue("");
});

it("opens full child editor and submits its own form with parent linkage", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.mocked(api.getTask).mockResolvedValue(task);
  vi.mocked(api.createTask).mockResolvedValue({ ...task, id: "child" });
  render(
    <QueryClientProvider client={client}>
      <DoskaTaskDrawer
        projectId="p"
        taskId={task.id}
        columns={columns}
        canWork
        canDelete
        onChanged={changed}
        onClose={closed}
      />
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: "Create child" });
  fireEvent.click(screen.getByRole("button", { name: "Create child" }));
  fireEvent.change(screen.getByRole("textbox", { name: "taskTitle" }), {
    target: { value: "Full child" },
  });
  const submit = screen.getByRole("button", {
    name: "createTask",
  }) as HTMLButtonElement;
  expect(submit.form).toBeTruthy();
  expect(submit.form?.querySelector("input")?.value).toBe("Full child");
  fireEvent.click(submit);
  await waitFor(() =>
    expect(api.createTask).toHaveBeenCalledWith(
      "p",
      expect.objectContaining({ parentTaskId: task.id, title: "Full child" }),
    ),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Create child" })).toBeVisible(),
  );
  expect(closed).not.toHaveBeenCalled();
});

it("persists label removal with the task revision", async () => {
  vi.mocked(api.updateTask).mockResolvedValue({
    ...task,
    labels: [],
    revision: 2,
  });
  render(editor({ ...task, labels: [{ name: "Network", color: "blue" }] }));
  fireEvent.click(screen.getByRole("button", { name: "taskLabelRemove" }));
  fireEvent.submit(document.getElementById("doska-task-edit-form")!);
  await waitFor(() =>
    expect(api.updateTask).toHaveBeenCalledWith(
      "p",
      "t",
      expect.objectContaining({ labels: [], expectedRevision: 1 }),
    ),
  );
});

it("uses the atomic creation override after the same required-field validation", async () => {
  const fields = {
    revision: 1,
    requiredTaskFields: ["description"],
    fields: [],
  } as const;
  client.setQueryData(["doska", "project-fields", "p"], fields);
  vi.mocked(api.getProjectFields).mockResolvedValue(fields as never);
  const create = vi.fn().mockResolvedValue(undefined);
  render(
    <QueryClientProvider client={client}>
      <DoskaTaskEditor
        projectId="p"
        columns={columns}
        canWork
        canDelete={false}
        createTask={create}
        onChanged={changed}
        onClose={closed}
      />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("taskTitle"), {
    target: { value: "Atomic task" },
  });
  expect(screen.getByRole("button", { name: "createTask" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("description *"), {
    target: { value: "Required description" },
  });
  fireEvent.click(screen.getByRole("button", { name: "createTask" }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Atomic task",
        description: "Required description",
      }),
    ),
  );
  expect(api.createTask).not.toHaveBeenCalled();
  expect(closed).toHaveBeenCalledOnce();
});
