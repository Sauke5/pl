import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { api, ApiError } from "./api";
import { resourceLinksApi } from "./resource-links-api";
import { ResourceCreateForm } from "./resource-create-form";
const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useBlocker: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("./task-editor", () => ({
  DoskaTaskEditor: ({
    createTask,
    canWork,
    onChanged,
  }: {
    createTask: (body: unknown) => Promise<void>;
    canWork: boolean;
    onChanged: () => void;
  }) => (
    <>
      <textarea aria-label="Draft" />
      <button
        disabled={!canWork}
        onClick={() =>
          void createTask({ title: "Original", columnId: "c" })
            .then(onChanged)
            .catch(() => {})
        }
      >
        Create
      </button>
    </>
  ),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.navigate.mockClear();
});
function mount() {
  vi.spyOn(api, "listColumns").mockResolvedValue([
    { id: "c", semanticState: "planned" },
  ] as never);
  vi.spyOn(resourceLinksApi, "resolve").mockResolvedValue({
    index: 0,
    available: true,
    descriptor: { displayName: "Service", objectKind: "service" },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ResourceCreateForm
        projectId="p"
        projectName="Project"
        selection={{
          resourceId: "11111111-1111-4111-8111-111111111111",
          sourceKind: "platform",
        }}
        onBack={() => {}}
      />
    </QueryClientProvider>,
  );
  return client;
}
it("does not create on load and retries uncertain outcomes with exactly the original body and key", async () => {
  const create = vi
    .spyOn(resourceLinksApi, "create")
    .mockRejectedValueOnce(new TypeError("Network"))
    .mockRejectedValueOnce(new ApiError(403, "access"))
    .mockResolvedValue({
      version: 1,
      revision: 1,
      linkId: "l",
      taskId: "t",
      projectId: "p",
      href: "/doska/projects/p?taskId=t",
    });
  mount();
  const submit = await screen.findByRole("button", { name: "Create" });
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(submit);
  fireEvent.click(
    await screen.findByRole("button", { name: "resourceRetryOriginal" }),
  );
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  expect(submit).toBeDisabled();
  expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "resourceRetryOriginal" }),
    ).not.toBeDisabled(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "resourceRetryOriginal" }),
  );
  await waitFor(() =>
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId",
      params: { projectId: "p" },
      search: { taskId: "t" },
    }),
  );
  expect(create.mock.calls[2]).toEqual(create.mock.calls[0]);
});
it.each([400, 401, 403, 404])(
  "allows correction after definite first-attempt rejection %s",
  async (status) => {
    const create = vi
      .spyOn(resourceLinksApi, "create")
      .mockRejectedValue(new ApiError(status, "validation"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    await screen.findByText("resourceCreateRejected");
    expect(screen.queryByText("resourceRetryOriginal")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]![1].clientRequestId).not.toEqual(
      create.mock.calls[0]![1].clientRequestId,
    );
  },
);

it("keeps the draft mounted across failed and revoked background resolutions", async () => {
  const client = mount();
  const draft = await screen.findByRole("textbox", { name: "Draft" });
  fireEvent.change(draft, { target: { value: "Keep this draft" } });
  vi.mocked(resourceLinksApi.resolve).mockRejectedValueOnce(
    new Error("Offline"),
  );
  await client.invalidateQueries({
    queryKey: ["doska", "resource-create-resolve"],
  });
  await screen.findByText("resourceCreateLoadError");
  expect(draft).toBeInTheDocument();
  expect(draft).toHaveValue("Keep this draft");
  expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
  vi.mocked(resourceLinksApi.resolve).mockResolvedValueOnce({
    index: 0,
    available: false,
  });
  await client.invalidateQueries({
    queryKey: ["doska", "resource-create-resolve"],
  });
  await screen.findByText("resourceLinksUnavailable");
  expect(draft).toBeInTheDocument();
  expect(draft).toHaveValue("Keep this draft");
  await client.invalidateQueries({
    queryKey: ["doska", "resource-create-resolve"],
  });
  await screen.findByRole("button", { name: "Create" });
  expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
});
