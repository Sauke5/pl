import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DoskaProjectFieldsSettings } from "./project-fields-settings";
import { api, ApiError } from "./api";
import type { ProjectFields } from "./custom-fields";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, args?: { name?: string }) =>
      args?.name ? `${key}:${args.name}` : key,
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
    getProjectFields: vi.fn(),
    listMembers: vi.fn(),
    createProjectField: vi.fn(),
    updateProjectField: vi.fn(),
    reorderProjectFields: vi.fn(),
    setRequiredTaskFields: vi.fn(),
  },
}));
const data: ProjectFields = {
  revision: 3,
  requiredTaskFields: [],
  fields: [
    {
      id: "f",
      name: "Location",
      type: "text",
      required: false,
      defaultValue: null,
      options: null,
      position: 0,
      archivedAt: null,
    },
    {
      id: "g",
      name: "Cost",
      type: "number",
      required: false,
      defaultValue: null,
      options: null,
      position: 1,
      archivedAt: null,
    },
  ],
};
let cache: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getProjectFields).mockResolvedValue(data);
  vi.mocked(api.listMembers).mockResolvedValue({
    owner: { userId: "owner", name: "Owner" },
    members: [
      { userId: "worker", name: "Worker", role: "participant" },
      { userId: "reader", name: "Reader", role: "observer" },
    ],
  } as never);
  cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(cleanup);
function mount(disabled = false) {
  render(
    <QueryClientProvider client={cache}>
      <DoskaProjectFieldsSettings projectId="p" disabled={disabled} />
    </QueryClientProvider>,
  );
}
it("creates an employee field with an eligible default and revision", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "customFieldAdd" }),
  );
  fireEvent.change(screen.getByLabelText("customFieldName"), {
    target: { value: "Approver" },
  });
  fireEvent.change(screen.getByLabelText("customFieldType"), {
    target: { value: "user" },
  });
  await screen.findByRole("option", { name: "Worker" });
  expect(screen.queryByRole("option", { name: "Reader" })).toBeNull();
  fireEvent.change(screen.getByLabelText("customFieldDefault"), {
    target: { value: "worker" },
  });
  const form = screen.getByLabelText("customFieldName").closest("form")!;
  fireEvent.submit(form);
  await waitFor(() =>
    expect(api.createProjectField).toHaveBeenCalledWith("p", {
      expectedRevision: 3,
      name: "Approver",
      type: "user",
      required: false,
      defaultValue: "worker",
      options: null,
    }),
  );
});
it("archives only after confirmation, preserving the field and data contract", async () => {
  mount();
  const row = (await screen.findByText("Location")).closest("li")!;
  fireEvent.click(
    within(row).getByRole("button", { name: "customFieldArchive" }),
  );
  expect(api.updateProjectField).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "confirm" }));
  await waitFor(() =>
    expect(api.updateProjectField).toHaveBeenCalledWith("p", "f", {
      expectedRevision: 3,
      archived: true,
    }),
  );
});
it("reorders active definitions with current revision", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "customFieldMoveUp:Cost" }),
  );
  await waitFor(() =>
    expect(api.reorderProjectFields).toHaveBeenCalledWith("p", {
      expectedRevision: 3,
      fieldIds: ["g", "f"],
    }),
  );
});
it("keeps standard requirements on their original revision after external changes", async () => {
  vi.mocked(api.setRequiredTaskFields).mockRejectedValue(
    new ApiError(409, "Conflict"),
  );
  mount();
  fireEvent.click(await screen.findByRole("checkbox", { name: "description" }));
  await act(async () => {
    cache.setQueryData(["doska", "project-fields", "p"], {
      ...data,
      revision: 4,
      requiredTaskFields: ["priority"],
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "save" }));
  await waitFor(() =>
    expect(api.setRequiredTaskFields).toHaveBeenCalledWith("p", {
      expectedRevision: 3,
      requiredTaskFields: ["description"],
    }),
  );
  await screen.findByText("customFieldsConflict");
  expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
});
it("disables mutation controls for archived projects", async () => {
  mount(true);
  expect(
    await screen.findByRole("button", { name: "customFieldAdd" }),
  ).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "description" })).toBeDisabled();
});
