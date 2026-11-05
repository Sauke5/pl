import {
  beforeEach,
  afterEach,
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
import { DoskaProjectManagement } from "./project-management";
import { DoskaProjectSettings } from "./project-settings";
import { api, ApiError } from "./api";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
    getManagement: vi.fn(),
    getProject: vi.fn(),
    employeeOptions: vi.fn(),
    archiveProject: vi.fn(),
    transferProject: vi.fn(),
    updateProject: vi.fn(),
    getProjectFields: vi.fn(),
  },
}));
function mount(children: React.ReactNode) {
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
      {children}
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getProjectFields).mockResolvedValue({
    revision: 1,
    requiredTaskFields: [],
    fields: [],
  });
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  vi.mocked(api.getManagement).mockResolvedValue({
    id: "p",
    name: "Private project",
    ownerUserId: "owner",
    archivedAt: null,
    revision: 4,
  });
  vi.mocked(api.employeeOptions).mockResolvedValue([
    { userId: "next", name: "New owner", departmentId: "d" },
  ]);
});
afterEach(cleanup);
describe("Project lifecycle controls", () => {
  it("manages head-visible metadata without fetching project content and requires archive confirmation", async () => {
    vi.mocked(api.archiveProject).mockResolvedValue({
      id: "p",
      name: "Private project",
      ownerUserId: "owner",
      archivedAt: "2026-10-23T00:00:00Z",
      revision: 5,
    });
    const closed = vi.fn();
    mount(<DoskaProjectManagement projectId="p" onClose={closed} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "archiveProject" }),
    );
    expect(api.archiveProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));
    await waitFor(() => expect(closed).toHaveBeenCalled());
    expect(api.archiveProject).toHaveBeenCalledWith("p", {
      expectedRevision: 4,
      archived: true,
    });
    expect(api.getProject).not.toHaveBeenCalled();
  });
  it("keeps the displayed revision on conflict until explicit reload", async () => {
    vi.mocked(api.archiveProject).mockRejectedValue(
      new ApiError(409, "Conflict"),
    );
    mount(<DoskaProjectManagement projectId="p" onClose={vi.fn()} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "archiveProject" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));
    await screen.findByText("projectConflict");
    vi.mocked(api.getManagement).mockResolvedValue({
      id: "p",
      name: "Private project",
      ownerUserId: "owner",
      archivedAt: null,
      revision: 8,
    });
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));
    await waitFor(() => expect(api.archiveProject).toHaveBeenCalledTimes(2));
    expect(api.archiveProject).toHaveBeenLastCalledWith("p", {
      expectedRevision: 4,
      archived: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "reloadProject" }));
    await waitFor(() =>
      expect(screen.queryByText("projectConflict")).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "archiveProject" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));
    await waitFor(() =>
      expect(api.archiveProject).toHaveBeenLastCalledWith("p", {
        expectedRevision: 8,
        archived: true,
      }),
    );
  });
  it("requires explicit confirmation before opening a private project to the department", async () => {
    mount(
      <DoskaProjectSettings
        project={
          {
            id: "p",
            name: "Private",
            revision: 4,
            visibility: "private",
            description: null,
            archivedAt: null,
          } as never
        }
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("visibility"), {
      target: { value: "department" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    expect(api.updateProject).not.toHaveBeenCalled();
    expect(screen.getByText("confirmOpenProject")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "confirm" }));
    await waitFor(() =>
      expect(api.updateProject).toHaveBeenCalledWith(
        "p",
        expect.objectContaining({
          expectedRevision: 4,
          visibility: "department",
        }),
      ),
    );
  });
});
