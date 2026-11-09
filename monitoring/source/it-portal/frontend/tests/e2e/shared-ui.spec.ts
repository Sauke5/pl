import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function fixture(page: Page) {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const data: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "engineer", name: "Инженер PL", admin: true },
        csrf_token: "fixture",
        timezone: "Europe/Moscow",
      },
      "/preferences": {
        revision: 1,
        favorites: [],
        hidden_sections: [],
        sidebar_collapsed: false,
      },
      "/resources": [],
      "/candidates": [],
      "/help-state": { disabled: true, seen: [] },
      "/dashboard-layout": { revision: 0, tiles: [], hidden: [] },
      "/workspace-preferences": { revision: 0, system_ids: [], groups: [] },
      "/chart-settings": { revision: 1, charts: [] },
      "/wayline": { sources: [] },
    };
    await route.fulfill({
      json:
        route.request().method() === "PUT"
          ? route.request().postDataJSON()
          : (data[path] ?? []),
    });
  });
  await page.route("**/forms/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/forms/", "");
    if (path.startsWith("api/v1/")) {
      await route.fulfill({
        json: path.endsWith("context")
          ? { name: "Инженер PL", admin: true, csrf_token: "fixture" }
          : { surveys: [] },
      });
      return;
    }
    const name = path || "index.html";
    if (!["index.html", "app.js", "theme.js", "styles.css"].includes(name))
      return route.abort();
    const body = await readFile(
      new URL(`../../../../../../apps/forms/static/${name}`, import.meta.url),
    );
    await route.fulfill({
      body,
      contentType: name.endsWith(".js")
        ? "text/javascript"
        : name.endsWith(".css")
          ? "text/css"
          : "text/html",
    });
  });
}

test("same shell, collapsed state and theme survive navigation between React and Forms", async ({
  page,
  context,
}) => {
  await fixture(page);
  await page.goto("/");
  const shell = page.locator(".pl-ui-shell");
  await expect(shell).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Свернуть меню", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Свернуть меню", exact: true })
    .click();
  await expect(shell).toHaveClass(/sidebar-collapsed/);
  const brand = await page.locator(".pl-ui-sidebar .pl-ui-brand").innerHTML();
  const other = await context.newPage();
  await fixture(other);
  await other.goto("/forms/");
  await expect(other.locator(".pl-ui-shell")).toHaveClass(/sidebar-collapsed/);
  expect(await other.locator(".pl-ui-sidebar .pl-ui-brand").innerHTML()).toBe(
    brand,
  );
  await other
    .getByRole("button", { name: "Развернуть меню", exact: true })
    .click();
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);
  await other
    .getByRole("button", { name: "Выбрать тему", exact: true })
    .click();
  await other
    .getByRole("menuitemradio", { name: "Хэллоуин", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
  await expect(page.locator(".pl-ui-shell")).not.toHaveClass(/sidebar-collapsed/);
  await other.close();
});

test("logout stays disabled until the request finishes and reports failure", async ({ page }) => {
  await fixture(page);
  let finish: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  let requests = 0;
  await page.route("**/auth/logout", async (route) => {
    requests++;
    await pending;
    await route.fulfill({ status: 503, json: { error: "Сервис временно недоступен" } });
  });
  await page.goto("/");
  const logout = page.getByRole("button", { name: "Выйти", exact: true });
  await logout.click();
  await expect(logout).toBeDisabled();
  await logout.evaluate((button: HTMLButtonElement) => button.click());
  expect(requests).toBe(1);
  finish!();
  await expect(logout).toBeEnabled();
  await expect(page.getByRole("alert").filter({ hasText: "Сервис временно недоступен" })).toBeVisible();
});

test("blocked browser storage retains the account sidebar preference", async ({ page }) => {
  await fixture(page);
  await page.route("**/api/v1/preferences", (route) => route.fulfill({ json: { revision: 1, favorites: [], hidden_sections: [], sidebar_collapsed: true } }));
  await page.addInitScript(() => Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } }));
  await page.goto("/");
  await expect(page.locator(".pl-ui-shell")).toHaveClass(/sidebar-collapsed/);
  await page.getByRole("button", { name: "Развернуть меню", exact: true }).click();
  await expect(page.locator(".pl-ui-shell")).not.toHaveClass(/sidebar-collapsed/);
});

test("shared dialog preserves its draft and focus when nested help closes", async ({ page }) => {
  await fixture(page);
  await page.goto("/#catalog");
  await page.getByRole("button", { name: "Добавить ресурс", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  const name = dialog.getByLabel(/^Название/);
  await name.fill("Черновик общего диалога");
  const help = dialog.getByRole("button", { name: "Показать подсказки", exact: true });
  await help.click();
  await expect(page.locator(".help-coach")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".help-coach")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(help).toBeFocused();
  await expect(name).toHaveValue("Черновик общего диалога");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

for (const { width, height, mode } of [
  { width: 1280, height: 600, mode: "expanded" },
  { width: 1024, height: 520, mode: "collapsed" },
  { width: 390, height: 540, mode: "drawer" },
]) {
  test(`full sidebar keeps settings reachable at ${width}x${height}`, async ({
    page,
  }) => {
    await fixture(page);
    await page.route("**/api/v1/modules", (route) =>
      route.fulfill({
        json: {
          items: ["prometheus", "alertmanager", "mailcow", "netmap", "sftpgo", "xray"].map((id) => ({
            id,
            module_id: id,
            name: id,
            mode: id === "mailcow" ? "external" : "local",
            desired_state: "enabled",
            observed_state: "running",
          })),
        },
      }),
    );
    await page.setViewportSize({ width, height });
    await page.goto("/");
    if (mode === "collapsed")
      await page.getByRole("button", { name: "Свернуть меню" }).click();
    if (mode === "drawer")
      await page.getByRole("button", { name: "Открыть меню" }).click();

    const navigation = page.getByRole("navigation", {
      name: "Основная навигация",
    });
    const settings = page.getByRole("link", { name: "Настройки", exact: true });
    const discovery = navigation.getByRole("link", { name: "Обнаружение" });
    await expect(
      navigation.getByRole("link", { name: "NetMap", exact: true }),
    ).toBeAttached();
    await expect(settings).toBeInViewport({ ratio: 1, timeout: 2500 });
    await navigation.hover();
    await page.mouse.wheel(0, 1500);
    await expect(discovery).toBeInViewport({ ratio: 1 });
    await expect
      .poll(() => navigation.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(settings).toBeInViewport({ ratio: 1 });
    await settings.click();
    await expect(page).toHaveURL(/#settings$/);
  });
}

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1920, height: 1200 },
  { width: 2560, height: 1440 },
  { width: 3440, height: 1440 },
  { width: 3840, height: 2160 },
]) {
  for (const theme of ["light", "dark", "night"]) {
    test(`shared shell geometry ${viewport.width}x${viewport.height} ${theme}`, async ({
      page,
    }) => {
      await fixture(page);
      await page.setViewportSize(viewport);
      await page.addInitScript(
        (theme) => localStorage.setItem("pl-ui-theme", theme),
        theme,
      );
      await page.goto("/");
      await expect(page.locator(".pl-ui-shell")).toBeVisible();
      const measure = () =>
        page.evaluate(() => {
          const box = (selector: string) =>
            document.querySelector(selector)!.getBoundingClientRect();
          const sidebar = box(".pl-ui-sidebar"),
            header = box(".pl-ui-topbar"),
            theme = box(".pl-ui-theme-toggle");
          const style = getComputedStyle(
            document.querySelector(".pl-ui-sidebar-toggle")!,
          );
          const brand = box(".pl-ui-sidebar .pl-ui-brand"),
            toggle = box(".pl-ui-sidebar-toggle");
          return {
            sidebar: sidebar.width,
            header: header.height,
            theme: theme.width,
            height: theme.height,
            font: style.fontSize,
            brand: {
              x: brand.x,
              y: brand.y,
              width: brand.width,
              height: brand.height,
            },
            toggleY: toggle.y,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
      const platform = await measure();
      expect(platform.sidebar).toBe(viewport.width >= 2200 ? 240 : 226);
      expect(platform.header).toBe(79);
      expect(platform.theme).toBe(34);
      expect(platform.height).toBe(34);
      expect(platform.overflow).toBe(false);
      await page.goto("/forms/");
      await expect(page.locator(".pl-ui-shell")).toBeVisible();
      expect(await measure()).toEqual(platform);
    });
  }
}
