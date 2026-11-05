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
import { DoskaColumnsPanel } from "./columns-panel";
import { api, ApiError } from "./api";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) =>
      values?.name ? `${key}:${values.name}` : key,
  }),
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
    getProject: vi.fn(),
    listColumns: vi.fn(),
    getAccess: vi.fn(),
    createColumn: vi.fn(),
    updateColumn: vi.fn(),
    deleteColumn: vi.fn(),
    reorderColumns: vi.fn(),
  },
}));
const columns = [
  { id: "a", name: "Plan", semanticState: "planned" },
  { id: "b", name: "Done", semanticState: "completed" },
];
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DoskaColumnsPanel projectId="p" onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  vi.mocked(api.getProject).mockResolvedValue({
    revision: 3,
    archivedAt: null,
  } as never);
  vi.mocked(api.listColumns).mockResolvedValue(columns as never);
  vi.mocked(api.getAccess).mockResolvedValue({ manageSettings: true } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("Doska column settings", () => {
  it("preserves the draft on conflict and uses a refreshed revision only after an explicit refresh", async () => {
    vi.mocked(api.updateColumn)
      .mockRejectedValueOnce(new ApiError(409, "Project revision conflict"))
      .mockResolvedValueOnce({ revision: 8, columns: [] });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "columnEditNamed:Plan" }),
    );
    fireEvent.change(screen.getByLabelText("columnName"), {
      target: { value: "My draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await screen.findByText("columnsConflict");
    expect(
      (screen.getByLabelText("columnName") as HTMLInputElement).value,
    ).toBe("My draft");
    expect(api.updateColumn).toHaveBeenLastCalledWith(
      "p",
      "a",
      expect.objectContaining({ expectedRevision: 3, name: "My draft" }),
    );
    vi.mocked(api.getProject).mockResolvedValue({
      revision: 7,
      archivedAt: null,
    } as never);
    fireEvent.click(screen.getByRole("button", { name: "columnsRefresh" }));
    await waitFor(() =>
      expect(screen.queryByText("columnsConflict")).toBeNull(),
    );
    expect(
      (screen.getByLabelText("columnName") as HTMLInputElement).value,
    ).toBe("My draft");
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() =>
      expect(api.updateColumn).toHaveBeenLastCalledWith(
        "p",
        "a",
        expect.objectContaining({ expectedRevision: 7, name: "My draft" }),
      ),
    );
  });
  it("requires a destination and explicit unfinished-subtask confirmation when deleting", async () => {
    vi.mocked(api.deleteColumn)
      .mockRejectedValueOnce(new ApiError(409, "Есть незавершённые подзадачи"))
      .mockResolvedValueOnce({ revision: 4, columns: [] });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "columnDeleteNamed:Plan" }),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "columnDeleteAndMove",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("columnDestination"), {
      target: { value: "b" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "columnDeleteAndMove" }),
    );
    await screen.findByText("columnsIncompleteSubtasks");
    expect(api.deleteColumn).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "columnsConfirmCompletion" }),
    );
    await waitFor(() =>
      expect(api.deleteColumn).toHaveBeenLastCalledWith("p", "a", {
        expectedRevision: 3,
        destinationColumnId: "b",
        confirmIncompleteSubtasks: true,
      }),
    );
  });
  it("uses the reorder endpoint with the full order and project revision", async () => {
    vi.mocked(api.reorderColumns).mockResolvedValue({
      revision: 4,
      columns: [],
    });
    mount();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const top =
          this.textContent?.includes("Done") &&
          !this.textContent?.includes("Plan")
            ? 100
            : 0;
        return {
          x: 0,
          y: top,
          left: 0,
          top,
          right: 400,
          bottom: top + 80,
          width: 400,
          height: 80,
          toJSON: () => ({}),
        };
      },
    );
    const title = await screen.findByRole("button", {
      name: "columnDragNamed:Plan",
    });
    title.focus();
    fireEvent.keyDown(title, { code: "Space", key: " " });
    await waitFor(() =>
      expect(title.getAttribute("aria-pressed")).toBe("true"),
    );
    fireEvent.keyDown(document, { code: "ArrowDown", key: "ArrowDown" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    fireEvent.keyDown(document, { code: "Space", key: " " });
    await waitFor(() =>
      expect(api.reorderColumns).toHaveBeenCalledWith("p", {
        expectedRevision: 3,
        columnIds: ["b", "a"],
      }),
    );
  });
  it("cancels a keyboard drag without saving and disables dragging while editing", async () => {
    mount();
    const title = await screen.findByRole("button", {
      name: "columnDragNamed:Plan",
    });
    title.focus();
    fireEvent.keyDown(title, { code: "Space", key: " " });
    await waitFor(() =>
      expect(title.getAttribute("aria-pressed")).toBe("true"),
    );
    fireEvent.keyDown(document, { code: "Escape", key: "Escape" });
    await waitFor(() =>
      expect(title.getAttribute("aria-pressed")).not.toBe("true"),
    );
    expect(api.reorderColumns).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "columnEditNamed:Plan" }),
    );
    expect(title.getAttribute("aria-disabled")).toBe("true");
    expect(title.tabIndex).toBe(-1);
    expect(screen.getByRole("button", { name: "save" }).parentElement).toBe(
      screen.getByRole("button", { name: "cancel" }).parentElement,
    );
  });
  it("renders archived projects read-only", async () => {
    vi.mocked(api.getProject).mockResolvedValue({
      revision: 3,
      archivedAt: "2026-01-01",
    } as never);
    mount();
    await screen.findByText("archivedProject");
    expect(screen.queryByRole("button", { name: "columnAdd" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "columnEditNamed:Plan" }),
    ).toBeNull();
  });
});
