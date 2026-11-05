import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { api, type Project } from "./api";
import { DoskaBreadcrumbs } from "./breadcrumbs";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("links back to projects, follows the active project and uses shared project cache", async () => {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  cache.setQueryData(["doska", "project", "p1"], { name: "Pi-pi" });
  vi.spyOn(api, "getProject").mockImplementation(
    async (id) =>
      ({ name: id === "p1" ? "Pi-pi" : "Another project" }) as Project,
  );
  const wrap = (path: string) => (
    <QueryClientProvider client={cache}>
      <DoskaBreadcrumbs pathname={path} />
    </QueryClientProvider>
  );
  const view = render(wrap("/doska/projects/p1"));
  expect(await screen.findByText("Pi-pi")).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(
    screen.getByRole("link", { name: "projects" }).getAttribute("href"),
  ).toMatch(/\/projects$/);
  expect(screen.getByRole("link", { name: "platform" })).toHaveAttribute(
    "href",
    "/",
  );
  view.rerender(wrap("/doska/projects/p2"));
  expect(await screen.findByText("Another project")).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.queryByText("Pi-pi")).not.toBeInTheDocument();
});
it("labels sections without loading a project", () => {
  const load = vi.spyOn(api, "getProject");
  const cache = new QueryClient();
  const view = render(
    <QueryClientProvider client={cache}>
      <DoskaBreadcrumbs pathname="/doska/my-tasks" />
    </QueryClientProvider>,
  );
  expect(screen.getByText("myTasks")).toHaveAttribute("aria-current", "page");
  view.rerender(
    <QueryClientProvider client={cache}>
      <DoskaBreadcrumbs pathname="/doska/search" />
    </QueryClientProvider>,
  );
  expect(screen.getByText("taskSearch")).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(load).not.toHaveBeenCalled();
});
it("embeds project breadcrumbs after the shared Platform link", async () => {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  cache.setQueryData(["doska", "project", "p1"], { name: "Тестовый проект" });
  vi.spyOn(api, "getProject").mockResolvedValue({
    name: "Тестовый проект",
  } as Project);
  render(
    <QueryClientProvider client={cache}>
      <DoskaBreadcrumbs pathname="/doska/projects/p1" embedded />
    </QueryClientProvider>,
  );
  expect(
    screen.queryByRole("link", { name: "platform" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "projects" })).toHaveAttribute(
    "href",
    expect.stringMatching(/\/projects$/),
  );
  expect(await screen.findByText("Тестовый проект")).toHaveAttribute(
    "aria-current",
    "page",
  );
});
