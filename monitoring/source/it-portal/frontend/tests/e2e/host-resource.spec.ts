import { test, expect } from "@playwright/test";

test("host without URL opens details and candidate sources filter independently of state", async ({
  page,
}) => {
  const host = {
    id: "host1",
    revision: 1,
    name: "Server without web",
    description: "",
    type: "Сервер",
    url: "",
    hostname: "server.example",
    ip: "10.1.1.1",
    directions: [],
    aliases: [],
    tags: [],
    endpoints: [],
    links: [],
    relations: [],
    external_ids: [],
    operations: [],
    check: { kind: "", target: "", interval_seconds: 0 },
    source: "manual",
    lifecycle: "active",
  };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const data: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "admin", name: "Admin", admin: true },
        csrf_token: "test",
        demo: true,
        timezone: "Europe/Moscow",
      },
      "/modules": { items: [] },
      "/workspace-preferences": { revision: 0, system_ids: [], groups: [] },
      "/dashboard-layout": { revision: 0, tiles: [], hidden: [] },
      "/workspace-problems": [],
      "/events": [],
      "/systems": [],
      "/collections": [],
      "/resources/app1/configuration-history": [],
      "/resources/host1/configuration-history": [],
      "/chart-settings": { revision: 1, charts: [] },
      "/wayline": { sources: [] },
      "/time": { server_time: "2026-09-28T01:15:35Z" },
      "/help-state": { disabled: true, seen: [] },
      "/preferences": {
        favorites: ["host1", "app1"],
        hidden_sections: [],
        section_order: [],
        home_widgets: [],
      },
      "/resources": [
        host,
        {
          ...host,
          id: "app1",
          name: "Web application",
          type: "Web-сервис",
          url: "https://app.example/",
        },
      ],
      "/dictionaries": {
        types: ["Сервер"],
        sites: [],
        environments: [],
        directions: [],
      },
      "/integrations": [
        { id: "prom", name: "Prometheus", kind: "prometheus" },
        { id: "nb", name: "NetBox", kind: "netbox" },
      ],
      "/candidates": [
        {
          id: "a",
          integration_id: "prom",
          name: "Prom server",
          url: "http://server:9100/metrics",
          state: "pending",
          labels: {},
        },
        {
          id: "b",
          integration_id: "nb",
          name: "NetBox server",
          url: "https://netbox/device/1",
          state: "pending",
          labels: {},
        },
      ],
      "/resources/app1/inventory": { resource_id: "app1", sources: [] },
      "/resources/host1/inventory": { resource_id: "host1", sources: [] },
    };
    if (route.request().method() === "GET" && path === "/stream")
      return route.fulfill({
        contentType: "text/event-stream",
        body: "retry: 60000\n\n",
      });
    expect(route.request().method()).toBe("GET");
    expect(Object.hasOwn(data, path), `Unmocked API: ${path}`).toBe(true);
    await route.fulfill({ json: data[path] });
  });
  await page.goto("/");
  // Infrastructure has no launchable service URL; stale favorites must not
  // turn it into a misleading homepage launch card.
  await expect(
    page.getByRole("button", {
      name: "Подробнее: Server without web",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", {
      name: "Открыть: Server without web",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Подробнее: Web application", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Web application", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Каталог", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Инфраструктура 1", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Server without web", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Server without web", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog").locator('a[href=""]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Приложения 1", exact: true }).click();
  await page
    .getByRole("button", { name: "Web application", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("dialog").locator('a[href="https://app.example/"]'),
  ).toBeVisible();
  expect(page.context().pages()).toHaveLength(1);
  await page.keyboard.press("Escape");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: /Обнаружение/ })
    .click();
  await page.getByLabel("Источник кандидатов").selectOption("nb");
  await expect(page.getByText("NetBox server", { exact: true })).toBeVisible();
  await expect(page.getByText("Prom server", { exact: true })).toHaveCount(0);
  await page.getByLabel("Выбрать всех кандидатов").check();
  await page.getByLabel("Источник кандидатов").selectOption("prom");
  await expect(page.getByLabel("Выбрать всех кандидатов")).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "В каталог", exact: true }),
  ).toBeDisabled();
});
