import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DoskaTaskComments } from "./task-comments";
import { DoskaTaskChecklists } from "./task-checklists";
import { api, ApiError } from "./api";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) =>
      values?.name ? `${key}:${values.name}` : key,
  }),
}));
vi.mock("./session", () => ({
  useDoskaSession: () => ({ context: { user: { id: "me" } } }),
}));
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
    listComments: vi.fn(),
    listMembers: vi.fn(),
    createComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    getChecklists: vi.fn(),
    updateChecklist: vi.fn(),
    updateChecklistItem: vi.fn(),
    createChecklist: vi.fn(),
  },
}));
const comment = {
  id: "c",
  userId: "me",
  authorName: "Author",
  content: "Old text",
  mentionIds: [],
  mentions: [],
  revision: 1,
  deletedAt: null,
  createdAt: "2026-10-23T10:00:00Z",
};
function mount(node: React.ReactNode) {
  return render(
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
      {node}
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.listComments).mockResolvedValue([comment] as never);
  vi.mocked(api.listMembers).mockResolvedValue({
    owner: { userId: "owner", name: "Owner" },
    members: [{ userId: "observer", name: "Observer", role: "observer" }],
  } as never);
  vi.mocked(api.getChecklists).mockResolvedValue({
    taskRevision: 3,
    checklists: [
      {
        id: "l",
        title: "Work",
        position: 0,
        items: [{ id: "i", text: "One", done: false, position: 0 }],
      },
    ],
  });
});
afterEach(cleanup);
describe("Doska task details", () => {
  it("keeps archived/read-only comments and checklists readable without mutation controls", async () => {
    mount(
      <>
        <DoskaTaskComments
          projectId="p"
          taskId="t"
          canWork={false}
          canModerate={false}
        />
        <DoskaTaskChecklists projectId="p" taskId="t" canWork={false} />
      </>,
    );
    await screen.findByText("Old text");
    await screen.findByText("One");
    expect(screen.queryByRole("button", { name: "edit" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });
  it("renders a tombstone without content or edit/delete controls", async () => {
    vi.mocked(api.listComments).mockResolvedValue([
      { ...comment, content: null, deletedAt: "2026-10-23T11:00:00Z" },
    ] as never);
    mount(<DoskaTaskComments projectId="p" taskId="t" canWork canModerate />);
    await screen.findByText("commentDeleted");
    expect(screen.queryByRole("button", { name: "edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "delete" })).toBeNull();
  });
  it("allows owners to delete another author's comment but never edit it", async () => {
    vi.mocked(api.listComments).mockResolvedValue([
      { ...comment, userId: "other" },
    ] as never);
    mount(<DoskaTaskComments projectId="p" taskId="t" canWork canModerate />);
    await screen.findByText("Old text");
    expect(screen.queryByRole("button", { name: "edit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    expect(screen.getByText("commentDeleteConfirm")).toBeVisible();
    expect(api.deleteComment).not.toHaveBeenCalled();
  });
  it("keeps a conflicting comment draft and revision until explicit edit restart", async () => {
    vi.mocked(api.updateComment).mockRejectedValue(
      new ApiError(409, "Conflict"),
    );
    mount(
      <DoskaTaskComments
        projectId="p"
        taskId="t"
        canWork
        canModerate={false}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "edit" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "My draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await screen.findByText("commentConflict");
    expect(screen.getByRole("textbox")).toHaveValue("My draft");
    vi.mocked(api.listComments).mockResolvedValue([
      { ...comment, content: "New server text", revision: 5 },
    ] as never);
    fireEvent.click(screen.getByRole("button", { name: "detailsRefresh" }));
    await screen.findByText("New server text");
    expect(screen.getByRole("textbox")).toHaveValue("My draft");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    expect(api.updateComment).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "commentRestartEdit" }));
    expect(screen.getByRole("textbox")).toHaveValue("New server text");
  });
  it("includes observers in explicit mention selection and submits separate ids", async () => {
    vi.mocked(api.createComment).mockResolvedValue(comment as never);
    mount(
      <DoskaTaskComments
        projectId="p"
        taskId="t"
        canWork
        canModerate={false}
      />,
    );
    await screen.findByRole("option", { name: "Observer" });
    fireEvent.change(screen.getByLabelText("commentMention"), {
      target: { value: "observer" },
    });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Please check" },
    });
    fireEvent.click(screen.getByRole("button", { name: "commentSend" }));
    await waitFor(() =>
      expect(api.createComment).toHaveBeenCalledWith("p", "t", {
        content: "Please check",
        mentionIds: ["observer"],
      }),
    );
  });
  it("does not render raw HTML, remote images or unsafe links from comments", async () => {
    vi.mocked(api.listComments).mockResolvedValue([
      {
        ...comment,
        content:
          '<img src="https://example.com/a">\n\n![secret](https://example.com/a)\n\n[unsafe](javascript:alert(1)) [safe](https://example.com)',
      },
    ] as never);
    mount(
      <DoskaTaskComments
        projectId="p"
        taskId="t"
        canWork={false}
        canModerate={false}
      />,
    );
    await screen.findByText("unsafe");
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "https://example.com",
    );
  });
  it("retains a checklist rename draft on conflict without retrying it after refresh", async () => {
    vi.mocked(api.updateChecklist).mockRejectedValue(
      new ApiError(409, "Conflict"),
    );
    mount(<DoskaTaskChecklists projectId="p" taskId="t" canWork />);
    fireEvent.click(
      await screen.findByRole("button", { name: "checklistRename" }),
    );
    fireEvent.change(screen.getByLabelText("checklistName"), {
      target: { value: "My list draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await screen.findByText("checklistConflict");
    expect(screen.getByLabelText("checklistName")).toHaveValue("My list draft");
    fireEvent.click(screen.getByRole("button", { name: "detailsRefresh" }));
    await waitFor(() => expect(api.getChecklists).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("checklistName")).toHaveValue("My list draft");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    expect(api.updateChecklist).toHaveBeenCalledTimes(1);
    expect(api.updateChecklist).toHaveBeenCalledWith("p", "t", "l", {
      title: "My list draft",
      expectedRevision: 3,
    });
  });
});
