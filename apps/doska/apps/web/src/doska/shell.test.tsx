import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DoskaShell } from "./shell";
import { api } from "./api";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tanstack/react-router", () => ({
  Outlet: () => <div>Board content</div>,
  useRouterState: () => "/doska/projects/p1",
}));
vi.mock("./session", () => ({
  useDoskaSession: () => ({ context: { user: { name: "Иван Иванов" } } }),
}));
vi.mock("./notification-bell", () => ({
  DoskaNotificationBell: () => <button>Notifications</button>,
}));
vi.mock("./personal-settings", () => ({
  DoskaPersonalSettings: ({ onClose }: { onClose: () => void }) => (
    <button onClick={onClose}>Close settings</button>
  ),
}));
vi.mock("./breadcrumbs", () => ({
  DoskaBreadcrumbs: ({ embedded }: { embedded: boolean }) => (
    <span>{embedded ? "embedded path" : "unexpected full path"}</span>
  ),
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  delete window.PLTheme;
});
it("preserves project navigation, common controls, settings, and logout", async () => {
  const unmount = vi.fn();
  window.PLTheme = {
    version: 1,
    get: () => "dark",
    getColorScheme: () => "dark",
    set: vi.fn(),
    subscribe: vi.fn(),
    mountMenu: vi.fn(() => unmount),
  };
  const logout = vi.spyOn(api, "logout").mockResolvedValue(undefined);
  const view = render(<DoskaShell />);
  expect(await screen.findByText("Board content")).toBeInTheDocument();
  expect(screen.getByText("embedded path")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "projects" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(
    screen.getByRole("link", { name: "projects" }).getAttribute("href"),
  ).toMatch(/\/projects$/);
  expect(screen.getByText("PL")).toBeInTheDocument();
  expect(screen.getByRole("link", {name:"Platform"})).toHaveAttribute("href", "/");
  expect(screen.getByText("Иван Иванов")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "personalSettings" }));
  expect(
    screen.getByRole("button", { name: "Close settings" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Свернуть меню" }));
  expect(localStorage.getItem("pl-ui-sidebar-collapsed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
  await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  view.unmount();
  expect(unmount).toHaveBeenCalled();
});
it("retains an actionable error when platform logout fails", async () => {
  vi.spyOn(api, "logout").mockRejectedValue(new Error("network"));
  render(<DoskaShell />);
  fireEvent.click(await screen.findByRole("button", { name: "Выйти" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("logoutError");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Выйти" })).toBeEnabled(),
  );
});
