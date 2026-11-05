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
import type { ReactNode } from "react";
import type { Capabilities, Project } from "./api";
import { DoskaMemberJoin } from "./member-join";
import { DoskaMemberRoster } from "./member-roster";
import { DoskaInvitationInbox } from "./invitation-inbox";

const mocks = vi.hoisted(() => ({
  listMembers: vi.fn(),
  listMyInvitations: vi.fn(),
  respondInvitation: vi.fn(),
  listMemberPage: vi.fn(),
  listJoinRequests: vi.fn(),
  createJoinRequest: vi.fn(),
  cancelJoinRequest: vi.fn(),
  changeMember: vi.fn(),
  removeMember: vi.fn(),
}));
vi.mock("./api", () => ({
  api: mocks,
  ApiError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("./session", () => ({
  useDoskaSession: () => ({
    context: { user: { id: "reader" }, departmentId: "department" },
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const project = {
  id: "p",
  departmentId: "department",
  visibility: "department",
  archivedAt: null,
} as Project;
const access = { readContent: true, workOnTasks: false } as Capabilities;
const owner = { userId: "owner", name: "Owner" };
function mount(element: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  return client;
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("Doska member actions", () => {
  it("does not offer a participation request to an explicit observer", async () => {
    mocks.listMembers.mockResolvedValue({
      owner,
      members: [{ id: "m", userId: "reader", role: "observer" }],
    });
    mount(<DoskaMemberJoin project={project} access={access} />);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.queryByText("membersRequestJoin")).toBeNull();
    expect(mocks.listJoinRequests).not.toHaveBeenCalled();
  });
  it("loads the reader's pending request and cancels it after a fresh mount", async () => {
    mocks.listMembers.mockResolvedValue({ owner, members: [] });
    mocks.listJoinRequests.mockResolvedValue([
      { id: "request", applicantUserId: "reader", status: "pending" },
    ]);
    mocks.cancelJoinRequest.mockImplementation(async () => {
      mocks.listJoinRequests.mockResolvedValue([]);
      return {};
    });
    mount(<DoskaMemberJoin project={project} access={access} />);
    fireEvent.click(await screen.findByText("membersCancelRequest"));
    await screen.findByText("membersRequestJoin");
    expect(mocks.cancelJoinRequest).toHaveBeenCalledWith("p", "request");
    expect(mocks.listJoinRequests.mock.calls.length).toBeGreaterThan(1);
  });
  it("hides joining for an archived project or another department", () => {
    mount(
      <>
        <DoskaMemberJoin
          project={{ ...project, archivedAt: "2026-01-01T00:00:00Z" }}
          access={access}
        />
        <DoskaMemberJoin
          project={{ ...project, departmentId: "other" }}
          access={access}
        />
      </>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(mocks.listMembers).not.toHaveBeenCalled();
  });
  it("refreshes the roster after a role conflict and sends the expected role", async () => {
    const { ApiError } = await import("./api");
    const member = {
      id: "m",
      name: "Reader",
      userId: "reader",
      role: "participant",
    };
    mocks.listMemberPage.mockResolvedValue({ owner, members: [member] });
    mocks.changeMember.mockImplementation(async () => {
      mocks.listMemberPage.mockResolvedValue({
        owner,
        members: [{ ...member, role: "observer" }],
      });
      throw new ApiError(409, "Conflict");
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mount(<DoskaMemberRoster projectId="p" canManage />);
    fireEvent.click(await screen.findByText("membersMakeObserver"));
    await screen.findByText("membersConflict");
    expect(await screen.findByText("membersMakeParticipant")).toBeTruthy();
    expect(mocks.changeMember).toHaveBeenCalledWith("p", "m", {
      expectedRole: "participant",
      role: "observer",
    });
  });
  it("loads the next roster page instead of truncating members", async () => {
    mocks.listMemberPage.mockImplementation(async (_id, page) => ({
      owner,
      members:
        page.offset === 0
          ? Array.from({ length: 50 }, (_, index) => ({
              id: String(index),
              userId: String(index),
              name: `Person ${index}`,
              role: "participant",
            }))
          : [
              {
                id: "last",
                userId: "last",
                name: "Last person",
                role: "observer",
              },
            ],
    }));
    mount(<DoskaMemberRoster projectId="p" canManage={false} />);
    fireEvent.click(await screen.findByText("membersNext"));
    await screen.findByText("Last person");
    expect(mocks.listMemberPage).toHaveBeenLastCalledWith("p", {
      limit: 50,
      offset: 50,
    });
    expect(screen.getByText("membersNext")).toBeDisabled();
    expect(screen.getByText("membersPrevious")).not.toBeDisabled();
  });
  it("keeps decline available but disables accepting an archived project invitation", async () => {
    mocks.listMyInvitations.mockResolvedValue([
      {
        id: "i",
        projectId: "p",
        projectName: "Named project",
        role: "observer",
        projectArchivedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    mocks.respondInvitation.mockImplementation(async () => {
      mocks.listMyInvitations.mockResolvedValue([]);
      return {};
    });
    mount(<DoskaInvitationInbox />);
    await screen.findByText("Named project");
    expect(screen.getByText("membersAccept")).toBeDisabled();
    fireEvent.click(screen.getByText("membersDecline"));
    await screen.findByText("membersInboxEmpty");
    expect(mocks.respondInvitation).toHaveBeenCalledWith("p", "i", {
      accept: false,
    });
  });
  it("does not offer role changes to the owner even when an explicit membership remains", async () => {
    mocks.listMemberPage.mockResolvedValue({
      owner,
      members: [
        {
          id: "owner-member",
          userId: "owner",
          name: "Owner",
          role: "participant",
        },
      ],
    });
    mount(<DoskaMemberRoster projectId="p" canManage />);
    await screen.findByText("Owner");
    expect(screen.getAllByText("Owner")).toHaveLength(1);
    expect(screen.queryByText("membersRemove")).toBeNull();
    expect(screen.queryByText("membersMakeObserver")).toBeNull();
  });
  it("shows a read-only roster without management controls", async () => {
    mocks.listMemberPage.mockResolvedValue({
      owner,
      members: [
        { id: "m", name: "Reader", userId: "reader", role: "participant" },
      ],
    });
    mount(<DoskaMemberRoster projectId="p" canManage={false} />);
    await screen.findByText("Reader");
    expect(screen.queryByText("membersRemove")).toBeNull();
    expect(screen.queryByText("membersMakeObserver")).toBeNull();
  });
});
