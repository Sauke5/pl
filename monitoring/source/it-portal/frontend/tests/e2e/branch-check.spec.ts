import { test, expect } from "@playwright/test";

async function setup(page: import("@playwright/test").Page, failed = false) {
  let posts = 0;
  const result = {
    id: 19,
    target_id: 7,
    kind: "path",
    status: "degraded",
    finished_at: "2026-09-28T01:15:35Z",
    loss_percent: 5,
    avg_latency_ms: 25,
    jitter_ms: 2,
    hops: [
      {
        hop_number: 1,
        host: "gateway",
        ip: "10.0.0.1",
        loss_percent: 0,
        avg_ms: 1,
      },
      {
        hop_number: 2,
        host: "branch",
        ip: "10.1.0.1",
        loss_percent: 5,
        avg_ms: 25,
      },
    ],
  };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/wayline/api/v1/")) {
      if (route.request().method() === "POST") {
        expect(path).toBe("/wayline/api/v1/targets/7/checks");
        posts++;
        expect(route.request().postDataJSON()).toEqual({ kind: "path" });
        expect(route.request().headers()["x-csrf-token"]).toBe("test");
        await route.fulfill({
          status: failed ? 502 : 201,
          json: failed ? { message: "Wayline не ответил" } : result,
        });
        return;
      }
      expect(route.request().method()).toBe("GET");
      expect(["/wayline/api/v1/targets", "/wayline/api/v1/checks"]).toContain(
        path,
      );
      if (path === "/wayline/api/v1/checks") {
        const query = new URL(route.request().url()).searchParams;
        expect(query.get("target_id")).toBe("7");
        expect(query.get("limit")).toBe("5");
      }
      await route.fulfill({
        json: path.endsWith("/targets")
          ? {
              targets: [
                {
                  id: 7,
                  name: "Филиал",
                  host: "10.1.0.1",
                  enabled: true,
                  probe_mode: "mtr",
                  execution_type: "local",
                },
                {
                  id: 8,
                  name: "Отключённый",
                  host: "10.2.0.1",
                  enabled: false,
                  probe_mode: "mtr",
                },
              ],
            }
          : { checks: [result] },
      });
      return;
    }
    const data: Record<string, unknown> = {
      "/api/v1/session": {
        authenticated: true,
        user: { id: "admin", name: "Admin", admin: true },
        csrf_token: "test",
        demo: true,
      },
      "/api/v1/time": { server_time: "2026-09-28T01:15:35Z" },
      "/api/v1/help-state": { disabled: true, seen: [] },
      "/api/v1/preferences": {
        favorites: [],
        hidden_sections: [],
        section_order: [],
        home_widgets: [],
      },
      "/api/v1/modules": { items: [] },
      "/api/v1/resources": [],
      "/api/v1/candidates": [],
      "/api/v1/integrations": [],
      "/api/v1/workspace-problems": [],
      "/api/v1/events": [],
      "/api/v1/systems": [],
      "/api/v1/workspace-preferences": {
        revision: 0,
        system_ids: [],
        groups: [],
      },
      "/api/v1/dashboard-layout": { revision: 0, tiles: [], hidden: [] },
      "/api/v1/chart-settings": { revision: 1, charts: [] },
      "/api/v1/wayline": { sources: [] },
      "/api/v1/dictionaries": {
        types: [],
        sites: [],
        environments: [],
        directions: [],
      },
    };
    if (route.request().method() === "GET" && path === "/api/v1/stream")
      return route.fulfill({
        contentType: "text/event-stream",
        body: "retry: 60000\n\n",
      });
    expect(route.request().method()).toBe("GET");
    expect(Object.hasOwn(data, path), `Unmocked API: ${path}`).toBe(true);
    await route.fulfill({ json: data[path] });
  });
  return () => posts;
}

test("MTR uses existing enabled target, readable hops and one POST", async ({
  page,
}) => {
  const posts = await setup(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Проверить адрес", exact: true })
    .click();
  const checks = page.getByRole("dialog", {
    name: "Проверка адреса",
    exact: true,
  });
  await checks
    .getByRole("button", { name: "MTR через Wayline", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Маршрут и потери (MTR)",
    exact: true,
  });
  await expect(dialog.getByLabel("Направление")).toHaveValue("7");
  await expect(dialog.locator("option")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Запустить MTR" }).click();
  await expect(
    dialog.getByText("Обнаружены потери", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("cell", { name: "gateway 10.0.0.1" }),
  ).toBeVisible();
  await expect(dialog.locator(".branch-metrics")).toContainText("5 %");
  await expect(dialog.locator(".json-view")).not.toBeVisible();
  expect(posts()).toBe(1);
  for (const size of [{ width: 1920, height: 1080 }])
    for (const theme of ["dark", "light"]) {
      await page.setViewportSize(size);
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await page.screenshot({
        path: `artifacts/mtr-${size.width}-${theme}.png`,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
});

test("uncertain MTR reads history without retrying execution", async ({
  page,
}) => {
  const posts = await setup(page, true);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Проверить адрес", exact: true })
    .click();
  const checks = page.getByRole("dialog", {
    name: "Проверка адреса",
    exact: true,
  });
  await checks
    .getByRole("button", { name: "MTR через Wayline", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Маршрут и потери (MTR)",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Запустить MTR" }).click();
  await expect(
    dialog.getByRole("button", { name: "Запустить MTR" }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Посмотреть последние проверки" })
    .click();
  await dialog.getByRole("button", { name: /Проверка №19/ }).click();
  await expect(
    dialog.getByText("Обнаружены потери", { exact: true }),
  ).toBeVisible();
  expect(posts()).toBe(1);
});
