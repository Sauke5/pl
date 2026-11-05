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
import { api, ApiError } from "./api";
import { DoskaTemplateSelection } from "./template-selection";
import { DoskaTemplateSave } from "./template-save";
import { DoskaProjectCreateForm } from "./project-create-form";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const snapshot = {
  version: 1,
  columns: [
    {
      key: "c1",
      name: "Todo",
      slug: "todo",
      semanticState: "planned",
      color: null,
      icon: null,
      position: 0,
    },
  ],
  tasks: [
    {
      key: "t1",
      title: "Typical task",
      description: null,
      priority: "medium",
      columnKey: "c1",
      parentKey: null,
      position: 0,
      checklists: [
        { title: "Steps", items: [{ text: "Check this", done: false }] },
      ],
    },
  ],
  relations: [],
};
const template = {
  id: "tpl",
  name: "Reusable",
  visibility: "private",
  revision: 4,
  snapshotVersion: 1,
  canManage: true,
  snapshot,
};
function mount(element: React.ReactNode) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(<QueryClientProvider client={cache}>{element}</QueryClientProvider>);
  return cache;
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  vi.spyOn(api, "listTemplates").mockResolvedValue({
    items: [template],
    hasMore: false,
  } as never);
  vi.spyOn(api, "readTemplate").mockResolvedValue(template as never);
  vi.spyOn(api, "previewTemplate").mockResolvedValue({
    snapshot,
    fingerprint: "a".repeat(64),
    expandedTaskIds: ["original"],
  } as never);
  vi.spyOn(api, "saveTemplate").mockResolvedValue(template as never);
  vi.spyOn(api, "createTemplateProject").mockResolvedValue({
    id: "new",
  } as never);
  vi.spyOn(api, "getTemplateSelection").mockResolvedValue([
    { taskId: "task", selected: false, revision: 2 },
  ]);
  vi.spyOn(api, "setTemplateSelection").mockResolvedValue({
    selected: true,
    revision: 3,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("templates workflow", () => {
  it("persists selection with its own revision and requires refresh on conflict", async () => {
    vi.mocked(api.setTemplateSelection).mockRejectedValueOnce(
      new ApiError(409, "conflict"),
    );
    mount(<DoskaTemplateSelection projectId="project" taskId="task" />);
    const checkbox = screen.getByLabelText("templateSelectTask");
    await waitFor(() => expect(checkbox).not.toBeDisabled());
    fireEvent.click(checkbox);
    await screen.findByText("templateSelectionConflict");
    expect(api.setTemplateSelection).toHaveBeenCalledWith("project", "task", {
      selected: true,
      expectedRevision: 2,
    });
    expect(checkbox).toBeDisabled();
    vi.mocked(api.getTemplateSelection).mockResolvedValue([
      { taskId: "task", selected: true, revision: 3 },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(api.setTemplateSelection).toHaveBeenCalledTimes(1);
  });
  it("shows composition and audience, then saves an explicitly reviewed snapshot", async () => {
    const close = vi.fn();
    mount(<DoskaTemplateSave projectId="project" onClose={close} />);
    await screen.findByText("Typical task");
    expect(screen.getByText("Check this")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("templateName"), {
      target: { value: "IT start" },
    });
    fireEvent.change(screen.getByLabelText("templateAudience"), {
      target: { value: "company" },
    });
    expect(api.saveTemplate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "save", hidden: true }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(api.saveTemplate).toHaveBeenCalledWith({
      sourceProjectId: "project",
      name: "IT start",
      visibility: "company",
      fingerprint: "a".repeat(64),
    });
  });
  it("does not resave a stale preview until refreshed and reviewed again", async () => {
    vi.mocked(api.saveTemplate).mockRejectedValueOnce(
      new ApiError(409, "changed"),
    );
    mount(<DoskaTemplateSave projectId="project" onClose={() => {}} />);
    await screen.findByText("Typical task");
    fireEvent.change(screen.getByLabelText("templateName"), {
      target: { value: "Keep name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save", hidden: true }));
    await screen.findByText("templateChanged");
    expect(
      screen.getByRole("button", { name: "save", hidden: true }),
    ).toBeDisabled();
    vi.mocked(api.previewTemplate).mockResolvedValue({
      snapshot,
      fingerprint: "b".repeat(64),
      expandedTaskIds: [],
    } as never);
    fireEvent.click(
      screen.getByRole("button", {
        name: "templateRefreshPreview",
        hidden: true,
      }),
    );
    await waitFor(() => expect(api.previewTemplate).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "save", hidden: true }),
      ).not.toBeDisabled(),
    );
    expect(api.saveTemplate).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("templateName")).toHaveValue("Keep name");
    expect(
      screen.getByRole("button", { name: "save", hidden: true }),
    ).not.toBeDisabled();
  });
  it("updates an owned template with the reviewed revision", async () => {
    mount(<DoskaTemplateSave projectId="project" onClose={() => {}} />);
    await screen.findByText("Typical task");
    await screen.findByRole("option", { name: "Reusable", hidden: true });
    fireEvent.change(screen.getByLabelText("templateSaveAs"), {
      target: { value: "tpl" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("templateName")).toHaveValue("Reusable"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "templateUpdate", hidden: true }),
    );
    await waitFor(() =>
      expect(api.saveTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: "tpl", expectedRevision: 4 }),
      ),
    );
  });
  it("creates from a template without tasks only after composition review", async () => {
    mount(<DoskaProjectCreateForm onClose={() => {}} />);
    await screen.findByRole("option", { name: "Reusable" });
    fireEvent.change(screen.getByLabelText("projectName"), {
      target: { value: "New project" },
    });
    fireEvent.change(screen.getByLabelText(/^projectSlug/), {
      target: { value: "NEW" },
    });
    fireEvent.change(screen.getByLabelText("template"), {
      target: { value: "tpl" },
    });
    await screen.findByText("Typical task");
    fireEvent.click(screen.getByLabelText("templateIncludeTasks"));
    expect(screen.queryByText("Typical task")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "create" }));
    await waitFor(() =>
      expect(api.createTemplateProject).toHaveBeenCalledWith("tpl", {
        expectedRevision: 4,
        includeTasks: false,
        project: { name: "New project", slug: "NEW", visibility: "department" },
      }),
    );
  });
  it("keeps project fields after a template conflict and never retries creation automatically", async () => {
    vi.mocked(api.createTemplateProject).mockRejectedValueOnce(
      new ApiError(409, "changed"),
    );
    mount(<DoskaProjectCreateForm onClose={() => {}} />);
    await screen.findByRole("option", { name: "Reusable" });
    fireEvent.change(screen.getByLabelText("projectName"), {
      target: { value: "Keep project" },
    });
    fireEvent.change(screen.getByLabelText(/^projectSlug/), {
      target: { value: "KEEP" },
    });
    fireEvent.change(screen.getByLabelText("template"), {
      target: { value: "tpl" },
    });
    await screen.findByText("Typical task");
    fireEvent.click(screen.getByRole("button", { name: "create" }));
    await screen.findByText("templateChanged");
    expect(screen.getByRole("button", { name: "create" })).toBeDisabled();
    vi.mocked(api.readTemplate).mockResolvedValue({
      ...template,
      revision: 5,
    } as never);
    fireEvent.click(
      screen.getByRole("button", { name: "templateRefreshPreview" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "create" })).not.toBeDisabled(),
    );
    expect(api.createTemplateProject).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("projectName")).toHaveValue("Keep project");
    fireEvent.click(screen.getByRole("button", { name: "create" }));
    await waitFor(() =>
      expect(api.createTemplateProject).toHaveBeenLastCalledWith(
        "tpl",
        expect.objectContaining({ expectedRevision: 5 }),
      ),
    );
  });
  it("pins an update revision across background cache refreshes until explicit conflict refresh", async () => {
    vi.mocked(api.saveTemplate).mockRejectedValueOnce(
      new ApiError(409, "conflict"),
    );
    const cache = mount(
      <DoskaTemplateSave projectId="project" onClose={() => {}} />,
    );
    await screen.findByText("Typical task");
    await screen.findByRole("option", { name: "Reusable", hidden: true });
    fireEvent.change(screen.getByLabelText("templateSaveAs"), {
      target: { value: "tpl" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("templateName")).toHaveValue("Reusable"),
    );
    act(() =>
      cache.setQueryData(["doska", "template", "tpl"], {
        ...template,
        revision: 5,
        name: "Other edit",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "templateUpdate", hidden: true }),
    );
    await screen.findByText("templateChanged");
    expect(api.saveTemplate).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedRevision: 4, name: "Reusable" }),
    );
    vi.mocked(api.readTemplate).mockResolvedValue({
      ...template,
      revision: 6,
    } as never);
    fireEvent.click(
      screen.getByRole("button", {
        name: "templateRefreshPreview",
        hidden: true,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "templateUpdate", hidden: true }),
      ).not.toBeDisabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "templateUpdate", hidden: true }),
    );
    await waitFor(() =>
      expect(api.saveTemplate).toHaveBeenLastCalledWith(
        expect.objectContaining({ expectedRevision: 6 }),
      ),
    );
  });
  it("exposes task descriptions, hierarchy and relation direction in the preview", async () => {
    vi.mocked(api.previewTemplate).mockResolvedValue({
      fingerprint: "a".repeat(64),
      expandedTaskIds: [],
      snapshot: {
        ...snapshot,
        tasks: [
          { ...snapshot.tasks[0], description: "Detailed instructions" },
          {
            ...snapshot.tasks[0],
            key: "t2",
            title: "Child task",
            parentKey: "t1",
          },
        ],
        relations: [{ type: "blocks", sourceKey: "t1", targetKey: "t2" }],
      },
    } as never);
    mount(<DoskaTemplateSave projectId="project" onClose={() => {}} />);
    await screen.findByText("Detailed instructions");
    expect(
      screen.getByText("Detailed instructions").closest("details"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("templateParentTask: Typical task"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Typical task — templateRelation_blocks — Child task"),
    ).toBeInTheDocument();
  });
  it("loads further template pages", async () => {
    vi.mocked(api.listTemplates)
      .mockResolvedValueOnce({ items: [template], hasMore: true } as never)
      .mockResolvedValueOnce({
        items: [{ ...template, id: "next", name: "Next template" }],
        hasMore: false,
      } as never);
    mount(<DoskaProjectCreateForm onClose={() => {}} />);
    await screen.findByRole("button", { name: "loadMore" });
    fireEvent.click(screen.getByRole("button", { name: "loadMore" }));
    await screen.findByRole("option", { name: "Next template" });
    expect(api.listTemplates).toHaveBeenLastCalledWith(2);
  });
});

it.each(["native validation", "submit guard"])(
  "rejects Cyrillic project codes and accepts a corrected Latin code through %s",
  async (path) => {
    const close = vi.fn();
    const create = vi
      .spyOn(api, "createProject")
      .mockResolvedValue({ id: "new" } as never);
    mount(<DoskaProjectCreateForm onClose={close} />);
    fireEvent.change(screen.getByLabelText("projectName"), {
      target: { value: "Проект" },
    });
    const slug = screen.getByLabelText(/^projectSlug/);
    fireEvent.change(slug, { target: { value: "АП" } });
    const submit = screen.getByRole("button", { name: "create" });
    if (path === "native validation") fireEvent.click(submit);
    else fireEvent.submit(submit.closest("form")!);
    expect(create).not.toHaveBeenCalled();
    expect(api.createTemplateProject).not.toHaveBeenCalled();
    expect(slug).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("slugHelp");
    expect(close).not.toHaveBeenCalled();
    fireEvent.change(slug, { target: { value: "AP" } });
    expect(slug).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(create).toHaveBeenCalledExactlyOnceWith({
        name: "Проект",
        slug: "AP",
        visibility: "department",
      }),
    );
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  },
);
