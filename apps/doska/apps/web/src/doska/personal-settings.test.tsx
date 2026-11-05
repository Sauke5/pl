import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { api } from "./api";
import { DoskaPersonalSettings } from "./personal-settings";
import { DoskaStartPage, startPagePath } from "./start-page";
const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("./my-tasks", () => ({ DoskaMyTasks: () => <div>My task list</div> }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
function mount(entry = false) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {entry ? (
        <DoskaStartPage />
      ) : (
        <DoskaPersonalSettings onClose={() => {}} />
      )}
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  navigate.mockReset();
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  vi.spyOn(api, "preferences").mockResolvedValue({ startPage: "projects" });
  vi.spyOn(api, "updatePreferences").mockResolvedValue({ startPage: "search" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("loads and saves a selected start page", async () => {
  mount();
  const select = await screen.findByLabelText("startPageLabel");
  expect(select).toHaveValue("projects");
  fireEvent.change(select, { target: { value: "search" } });
  await waitFor(() =>
    expect(api.updatePreferences).toHaveBeenCalledWith({ startPage: "search" }),
  );
  await waitFor(() => expect(select).toBeEnabled());
  expect(select).toHaveValue("search");
});
it("restores confirmed choice after a failed save and retries explicitly", async () => {
  vi.mocked(api.updatePreferences).mockRejectedValueOnce(new Error("offline"));
  mount();
  const select = await screen.findByLabelText("startPageLabel");
  fireEvent.change(select, { target: { value: "search" } });
  await screen.findByText("saveError");
  expect(select).toHaveValue("projects");
  fireEvent.click(screen.getByText("retry"));
  await waitFor(() => expect(select).toHaveValue("search"));
});
it("does not invent a selected value after load error", async () => {
  vi.mocked(api.preferences).mockRejectedValue(new Error("offline"));
  mount();
  await screen.findByText("personalSettingsLoadError");
  expect(screen.queryByLabelText("startPageLabel")).not.toBeInTheDocument();
});
it("redirects only the entry component to the chosen page with replace", async () => {
  mount(true);
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({ to: "/projects", replace: true }),
  );
});
it("keeps My tasks usable when entry preference fails", async () => {
  vi.mocked(api.preferences).mockRejectedValue(new Error("offline"));
  mount(true);
  await screen.findByText("My task list");
  expect(navigate).not.toHaveBeenCalled();
  expect(screen.getByText("startPageLoadError")).toBeInTheDocument();
});
it("maps only local allowed paths, retaining direct My tasks", () => {
  for (const page of [
    "my-tasks",
    "projects",
    "search",
    "invitations",
    "management",
  ])
    expect(startPagePath(page)).toBe(`/${page}`);
  expect(startPagePath("https://evil.example")).toBe("/my-tasks");
  expect(startPagePath("toString")).toBe("/my-tasks");
});
