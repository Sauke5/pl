import { afterEach, describe, it, expect, vi } from "vite-plus/test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DoskaTaskLabels, labelColor } from "./task-labels";
import { api } from "./api";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, args?: { name?: string }) =>
      args?.name ? `${key} ${args.name}` : key,
  }),
}));
vi.mock("./api", () => ({
  api: {
    listProjectLabels: vi
      .fn()
      .mockResolvedValue([{ name: "Сеть", color: "cyan" }]),
  },
}));
afterEach(cleanup);
function mount(editable = true, value: { name: string; color: string }[] = []) {
  const change = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <DoskaTaskLabels
        projectId="p1"
        value={value}
        editable={editable}
        onChange={change}
      />
    </QueryClientProvider>,
  );
  return change;
}
describe("task labels", () => {
  it("reuses project suggestions and their color", async () => {
    const change = mount();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Се" } });
    await waitFor(() =>
      expect(api.listProjectLabels).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ q: "Се" }),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Сеть" }));
    expect(change).toHaveBeenCalledWith([{ name: "Сеть", color: "cyan" }]);
    expect(api.listProjectLabels).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ q: "Се" }),
    );
  });
  it("adds trimmed labels and removes existing labels", () => {
    const change = mount(true, [{ name: "Сеть", color: "cyan" }]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "  Новая  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "taskLabelAdd" }));
    expect(change).toHaveBeenCalledWith([
      { name: "Сеть", color: "cyan" },
      { name: "Новая", color: "blue" },
    ]);
    fireEvent.click(
      screen.getByRole("button", { name: "taskLabelRemove Сеть" }),
    );
    expect(change).toHaveBeenLastCalledWith([]);
  });
  it("blocks duplicates and provides read-only chips", () => {
    const view = mount(true, [{ name: "Сеть", color: "cyan" }]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Сеть" },
    });
    expect(screen.getByRole("button", { name: "taskLabelAdd" })).toBeDisabled();
    expect(view).not.toHaveBeenCalled();
    cleanup();
    mount(false, [{ name: "Сеть", color: "cyan" }]);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Сеть")).toBeVisible();
    expect(labelColor("url(evil)")).toBe("#8293a4");
  });
});
