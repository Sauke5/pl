import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { appPath } from "./app-path";
import { generateLink } from "./generate-link";
import { buildInvitationLink } from "./invitation-link";
import { getApiUrl } from "@/fetchers/get-api-url";

afterEach(() => vi.unstubAllEnvs());

describe("deployment prefix", () => {
  it("keeps standalone root routes and assets", () => {
    expect(appPath("/dashboard", "/")).toBe("/dashboard");
    expect(appPath("favicon.svg", "/")).toBe("/favicon.svg");
  });

  it("keeps deep links, invitation links and assets inside Doska", () => {
    vi.stubEnv("BASE_URL", "/doska/");
    vi.stubEnv("VITE_APP_URL", "");
    expect(appPath("/favicon.svg")).toBe("/doska/favicon.svg");
    expect(generateLink("/dashboard?taskId=42")).toBe(
      `${window.location.origin}/doska/dashboard?taskId=42`,
    );
    expect(buildInvitationLink("invite-1")).toBe(
      `${window.location.origin}/doska/invitation/accept/invite-1`,
    );
  });

  it("uses same-origin prefixed API by default and honors a separate API", () => {
    vi.stubEnv("BASE_URL", "/doska/");
    vi.stubEnv("VITE_API_URL", "");
    expect(getApiUrl("/task/42")).toBe("/doska/api/task/42");
    vi.stubEnv("VITE_API_URL", "https://api.example.test/service/api/");
    expect(getApiUrl("/task/42")).toBe(
      "https://api.example.test/service/api/task/42",
    );
  });

  it("treats explicit VITE_APP_URL as the complete public application base", () => {
    vi.stubEnv("BASE_URL", "/doska/");
    vi.stubEnv("VITE_APP_URL", "https://example.test/doska/");
    expect(generateLink("/dashboard")).toBe(
      "https://example.test/doska/dashboard",
    );
  });
});

it("redirects an expired session under the prefix without duplicating the return route", async () => {
  const { handleUnauthorized } = await import("./http-error");
  vi.stubEnv("BASE_URL", "/doska/");
  const replace = vi.fn();
  vi.stubGlobal("window", {
    location: {
      pathname: "/doska/dashboard/workspace/it",
      search: "?taskId=42",
      hash: "#details",
      replace,
    },
  });
  try {
    handleUnauthorized();
    expect(replace).toHaveBeenCalledWith(
      "/doska/auth/sign-in?redirect=%2Fdashboard%2Fworkspace%2Fit%3FtaskId%3D42%23details",
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it("resolves prefixed deep links and builds prefixed navigation targets", async () => {
  const { createRouter, createRootRoute, createRoute, createMemoryHistory } =
    await import("@tanstack/react-router");
  const rootRoute = createRootRoute();
  const taskRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/dashboard/$projectId",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([taskRoute]),
    basepath: "/doska/",
    history: createMemoryHistory({ initialEntries: ["/doska/dashboard/it"] }),
  });
  await router.load();
  expect(router.state.matches.at(-1)?.params).toEqual({ projectId: "it" });
  expect(router.buildLocation({ to: "/dashboard/other" }).href).toBe(
    "/doska/dashboard/other",
  );
});
