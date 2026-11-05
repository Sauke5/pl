import { test, expect } from "@playwright/test";
import type { DashboardLayoutState } from "../../src/DashboardLayout";
import type { WorkspacePreferences } from "../../src/workspaceTypes";
import { systemIconExamples } from "../fixtures/systemIcons";

const resources = systemIconExamples.map(([name], index) => ({
  id: `icon-example-${index}`,
  revision: 1,
  name,
  description: "",
  type: "Web-сервис",
  url: `https://service-${index}.example.test/`,
  lifecycle: "active",
  operations: [],
  directions: [],
  tags: [],
  aliases: [],
  endpoints: [],
  links: [],
  relations: [],
  external_ids: [],
  check: {},
}));
for (const [width, height, theme] of [
  [1920, 1080, "dark"],
  [1920, 1080, "light"],
] as const) {
  test(`semantic system SVGs ${width} ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    const unknownRequests: string[] = [];
    const workspace: WorkspacePreferences = {
      revision: 0,
      system_ids: [],
      groups: [],
    };
    const layout: DashboardLayoutState = { revision: 0, tiles: [], hidden: [] };
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await page.addInitScript(
      (theme) => localStorage.setItem("pl-ui-theme", theme),
      theme,
    );
    let employee = false;
    await page.route("**/api/v1/**", async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname.replace("/api/v1", "");
      const data: Record<string, unknown> = {
        "/session": {
          authenticated: true,
          user: {
            id: "icon-review",
            name: "Проверка иконок",
            admin: !employee,
          },
          csrf_token: "fixture",
          timezone: "Europe/Moscow",
        },
        "/resources": resources,
        "/dashboard-layout": layout,
        "/workspace-preferences": workspace,
        "/modules": { items: [] },
        "/systems": [],
        "/collections": [],
        "/candidates": [],
        "/integrations": [],
        "/events": [],
        "/workspace-problems": [],
        "/time": { server_time: "2026-10-26T12:00:00Z" },
        "/preferences": {
          favorites: resources.slice(0, 14).map((r) => r.id),
          hidden_sections: [],
          section_order: [],
          home_widgets: [],
        },
        "/help-state": { disabled: true, seen: [] },
        "/chart-settings": { revision: 1, charts: [] },
        "/wayline": { sources: [] },
        "/dictionaries": {
          types: ["Web-сервис"],
          sites: [],
          environments: [],
          directions: [],
        },
        "/board": {
          title: "Сервисы PL",
          items: resources
            .filter((_, index) => [0, 28, 30, 32, 33, 39].includes(index))
            .map((r, i) => ({
              id: r.id,
              name: r.name,
              description: "Корпоративный сервис",
              status: "unknown",
              url: r.url,
              icon:
                i === 2
                  ? "support"
                  : i === 3
                    ? "book"
                    : i === 5
                      ? "folder"
                      : "app",
            })),
        },
      };
      if (req.method() === "GET" && path in data)
        return route.fulfill({ json: data[path] });
      if (
        req.method() === "GET" &&
        resources.some(
          (resource) => path === `/resources/${resource.id}/inventory`,
        )
      )
        return route.fulfill({ json: { sources: [] } });
      if (
        req.method() === "GET" &&
        resources.some(
          (resource) => path === `/resources/${resource.id}/configuration-history`,
        )
      )
        return route.fulfill({ json: [] });
      if (req.method() === "GET" && path === "/stream")
        return route.fulfill({
          contentType: "text/event-stream",
          body: "retry: 60000\n\n",
        });
      unknownRequests.push(`${req.method()} ${path}`);
      return route.fulfill({
        status: 503,
        json: {
          message: `Unexpected semantic icon fixture request: ${req.method()} ${path}`,
        },
      });
    });
    await page.goto("/#catalog");
    await expect(page.locator(".resource-row [data-system-icon]")).toHaveCount(
      systemIconExamples.length,
    );
    const icons = await page
      .locator(".resource-row [data-system-icon]")
      .evaluateAll((nodes) =>
        nodes.map((svg) => ({
          key: svg.getAttribute("data-system-icon"),
          svg: svg.outerHTML,
          color: getComputedStyle(svg).color,
          name: svg.closest(".resource-row")!.querySelector(".resource-name")!
            .textContent,
        })),
      );
    expect(icons.map((icon) => icon.key).sort()).toEqual(
      systemIconExamples.map(([, key]) => key).sort(),
    );
    await expect(
      page.locator(".resource-row [data-system-icon=web]"),
    ).toHaveCount(0);
    expect(
      await page
        .locator(".resource-row [data-system-icon]")
        .evaluateAll((nodes) =>
          nodes.every(
            (svg) =>
              svg.getAttribute("aria-hidden") === "true" &&
              svg.getAttribute("focusable") === "false" &&
              svg.getAttribute("stroke-width") === "1.75",
          ),
        ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`catalog-${theme}-${width}.png`),
    });
    await page.getByRole("button", { name: "Grafana", exact: true }).click();
    await expect(
      page.getByRole("dialog").locator('[data-system-icon="grafana"]'),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`detail-${theme}-${width}.png`),
    });
    await page.keyboard.press("Escape");
    await page.goto("/");
    await expect(
      page.locator(".workspace-favorite [data-system-icon]"),
    ).toHaveCount(14);
    expect(
      await page
        .locator(".workspace-favorite [data-system-icon]")
        .evaluateAll((nodes) =>
          nodes.map((svg) => svg.getAttribute("data-system-icon")),
        ),
    ).toEqual(systemIconExamples.slice(0, 14).map(([, key]) => key));
    await page.screenshot({
      path: test.info().outputPath(`home-${theme}-${width}.png`),
    });
    employee = true;
    await page.reload();
    await expect(page.locator(".employee-card [data-system-icon]")).toHaveCount(
      6,
    );
    await expect(
      page.locator('.employee-card [data-system-icon="vega"]'),
    ).toBeVisible();
    await expect(
      page.locator('.employee-card [data-system-icon="folder"]'),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`employee-${theme}-${width}.png`),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    expect(unknownRequests).toEqual([]);
    // Contact sheet uses the actual SVG markup and resolved theme colors from the catalog.
    const sheet = await page.context().newPage();
    await sheet.setContent(
      `<html><body style="margin:0;padding:36px;background:${theme === "dark" ? "#0e1927" : "#edf3f9"};color:${theme === "dark" ? "#e6edf6" : "#21354b"};font:15px system-ui"><h1 style="font-size:24px;font-weight:560">Системы · SVG-иконки</h1><p>${systemIconExamples.length} приложений · ${new Set(systemIconExamples.map(([, key]) => key)).size} семейств · ${theme}</p><main style="display:grid;grid-template-columns:repeat(5,1fr);gap:16px">${icons.map((icon) => `<article style="display:flex;align-items:center;gap:14px;padding:18px;border:1px solid ${theme === "dark" ? "#abcbed29" : "#4666892e"};border-radius:12px"><span style="color:${icon.color};display:flex;padding:12px;border-radius:10px;background:${theme === "dark" ? "#abcbed0d" : "#ffffff99"}">${icon.svg}</span><span>${icon.name}</span></article>`).join("")}</main></body></html>`,
    );
    await sheet.setViewportSize({ width: 1920, height: 1120 });
    await sheet.bringToFront();
    await expect(
      sheet.getByRole("heading", { name: "Системы · SVG-иконки" }),
    ).toBeVisible();
    await expect(sheet.locator("article svg")).toHaveCount(
      systemIconExamples.length,
    );
    await sheet.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await sheet.screenshot({
      path: test.info().outputPath(`contact-sheet-${theme}.png`),
    });
  });
}
