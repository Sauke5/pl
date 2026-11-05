import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api, type Column, type CreateTaskInput } from "./api";
import { TaskImportEditor } from "./task-import-editor";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const columns = [{ id: "c1", name: "Planned" }] as Column[];
function mount(tasks: CreateTaskInput[]) {
  const valid = vi.fn();
  function Harness() {
    const [value, change] = useState(tasks);
    return (
      <TaskImportEditor
        tasks={value}
        onChange={change}
        onValidityChange={valid}
        columns={columns}
        people={[{ userId: "u1", name: "Owner" }]}
        projectId="p1"
      />
    );
  }
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Harness />
    </QueryClientProvider>,
  );
  return valid;
}
describe("import editor", () => {
  it("preserves malformed values and enables import only after corrections and required fields", async () => {
    vi.spyOn(api, "getProjectFields").mockResolvedValue({
      revision: 1,
      requiredTaskFields: ["description"],
      fields: [],
    });
    const valid = mount([
      {
        title: "Good title",
        columnId: "",
        userId: "missing@example.com",
        startDate: "yesterday",
        due: { date: "2026-11-10" },
      },
    ]);
    await screen.findByLabelText("taskTitle *");
    expect(screen.getByLabelText("startDate")).toHaveValue("yesterday");
    expect(valid).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText("column *"), {
      target: { value: "c1" },
    });
    fireEvent.change(screen.getByLabelText("responsible"), {
      target: { value: "u1" },
    });
    fireEvent.change(screen.getByLabelText("startDate"), {
      target: { value: "2026-11-09" },
    });
    expect(valid).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText("description"), {
      target: { value: "**Kept** markdown" },
    });
    await waitFor(() => expect(valid).toHaveBeenLastCalledWith(true));
    expect(screen.getByLabelText("description")).toHaveValue(
      "**Kept** markdown",
    );
  });
  it("keeps invalid custom values blocking and handles false as a required value", async () => {
    vi.spyOn(api, "getProjectFields").mockResolvedValue({
      revision: 1,
      requiredTaskFields: [],
      fields: [
        {
          id: "f1",
          name: "Approved",
          type: "boolean",
          required: true,
          defaultValue: null,
          options: null,
          position: 0,
          archivedAt: null,
        },
      ],
    });
    const valid = mount([{ title: "Task", columnId: "c1" }]);
    await screen.findByLabelText("Approved *");
    expect(valid).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText("Approved *"), {
      target: { value: "false" },
    });
    await waitFor(() => expect(valid).toHaveBeenLastCalledWith(true));
  });
});
