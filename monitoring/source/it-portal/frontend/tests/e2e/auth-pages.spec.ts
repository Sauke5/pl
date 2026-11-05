import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

type State = { authenticated: boolean; local: boolean; admin: boolean };

async function capture(page: Page, name: string) {
  const dir = process.env.AUTH_SCREENSHOT_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({
    path: join(dir, `${name}.png`),
    animations: "disabled",
  });
}

async function mockPortal(page: Page, state: State) {
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/session"))
      return route.fulfill({
        json: {
          authenticated: state.authenticated,
          user: state.authenticated
            ? {
                id: "test",
                name: "Проверенный пользователь",
                admin: state.admin,
              }
            : undefined,
          csrf_token: state.authenticated ? "test-csrf" : undefined,
          ad_login_enabled: true,
          local_login_enabled: state.local,
          oidc_login_enabled: true,
          board_anonymous_enabled: false,
          timezone: "Europe/Moscow",
        },
      });
    if (path.endsWith("/preferences"))
      return route.fulfill({
        json: { favorites: [], hidden_sections: [], section_order: [] },
      });
    if (path.endsWith("/help-state"))
      return route.fulfill({ json: { disabled: true, seen: [] } });
    if (path.endsWith("/board"))
      return route.fulfill({ json: { title: "Проверка", items: [] } });
    return route.fulfill({ json: [] });
  });
  await page.route("**/auth/ad", (route) => {
    state.authenticated = true;
    return route.fulfill({ json: { ok: true } });
  });
}

for (const [width, height] of [
  [1920, 1080],
]) {
  for (const theme of ["dark", "light"]) {
    test(`login and error scenes ${width}×${height} ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(
        (value) => localStorage.setItem("pl-ui-theme", value),
        theme,
      );
      await mockPortal(page, {
        authenticated: false,
        local: true,
        admin: false,
      });
      await page.goto("/");
      await expect(
        page.getByRole("heading", { name: "Вход в Платформу" }),
      ).toBeVisible();
      await expect(
        page.locator(".domain-login").getByLabel("Логин", { exact: true }),
      ).toBeVisible();
      await expect(
        page.locator(".domain-login").getByLabel("Пароль", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("Локальный вход")).toBeVisible();
      await expect(page.locator(".local-login form")).toBeHidden();
      await expect(page.locator(".app-shell")).toHaveCount(0);
      await expect(
        page.getByRole("button", {
          name: "Выбрать тему",
        }),
      ).toBeVisible();
      await capture(page, `login-${width}-${theme}`);
      await page.goto("/401?return_to=%2Faudit-arch%2Fdepartments%2F12");
      await expect(
        page.getByRole("heading", { name: "Требуется вход" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Войти в Платформу" }),
      ).toHaveAttribute("href", "/?return_to=%2Faudit-arch%2Fdepartments%2F12");
      await capture(page, `401-${width}-${theme}`);
      await page.goto("/");
      await page.goto("/missing-page");
      await expect(
        page.getByRole("heading", { name: "Страница не найдена" }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await capture(page, `404-${width}-${theme}`);
      await page.getByRole("button", { name: "Назад" }).click();
      await expect(
        page.getByRole("heading", { name: "Вход в Платформу" }),
      ).toBeVisible();
    });
  }
}

test("local login stays absent when disabled and successful AD login animates before deep link", async ({
  page,
}) => {
  const state = { authenticated: false, local: false, admin: false };
  await mockPortal(page, state);
  await page.route("**/audit-arch/departments/12", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Auditor ARCH</h1>" }),
  );
  await page.goto("/?return_to=%2Faudit-arch%2Fdepartments%2F12");
  await expect(page.locator(".local-login")).toHaveCount(0);
  await page.getByLabel("Логин", { exact: true }).fill("test-user");
  await page.getByLabel("Пароль", { exact: true }).fill("fixture-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByText("Вход выполнен")).toBeVisible();
  await capture(page, "login-success-1920-dark");
  await expect(
    page.getByRole("heading", { name: "Auditor ARCH" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/audit-arch\/departments\/12$/);
});

test("failed AD login keeps the form and does not start success animation", async ({
  page,
}) => {
  const state = { authenticated: false, local: false, admin: false };
  await mockPortal(page, state);
  await page.route("**/auth/ad", (route) =>
    route.fulfill({
      status: 400,
      json: {
        error: "invalid_credentials",
        message: "Неверный логин или пароль",
      },
    }),
  );
  await page.goto("/");
  await page.getByLabel("Логин", { exact: true }).fill("test-user");
  await page.getByLabel("Пароль", { exact: true }).fill("wrong-value");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByText("Неверный логин или пароль")).toBeVisible();
  await expect(page.getByText("Вход выполнен")).toHaveCount(0);
  await expect(page.getByLabel("Логин", { exact: true })).toHaveValue(
    "test-user",
  );
  expect(
    await page.evaluate(() => sessionStorage.getItem("pl-ui-login-animation")),
  ).toBeNull();
});

test("401 fragment preserves a safe monitoring deep link without putting its query in the request URL", async ({
  page,
}) => {
  const state = { authenticated: false, local: false, admin: false };
  await mockPortal(page, state);
  await page.route("**/grafana/d/abc*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Grafana dashboard</h1>",
    }),
  );
  await page.goto("/401#return_to:/grafana/d/abc?var_site=MSK");
  await expect(
    page.getByRole("heading", { name: "Требуется вход" }),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  await page.getByRole("link", { name: "Войти в Платформу" }).click();
  await page.locator(".domain-login").getByLabel("Логин").fill("test-user");
  await page
    .locator(".domain-login")
    .getByLabel("Пароль", { exact: true })
    .fill("fixture-only");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Grafana dashboard" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/grafana\/d\/abc\?var_site=MSK$/);
});

test("authenticated 404 and 403 retain shell; lost session hides it", async ({
  page,
}) => {
  const state = { authenticated: true, local: false, admin: true };
  await mockPortal(page, state);
  await page.goto("/404");
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Страница не найдена" }),
  ).toBeVisible();
  await expect(page.getByText("Проверенный пользователь")).toBeVisible();
  await capture(page, "404-authenticated-1920-dark");
  await page.goto("/403");
  await expect(
    page.getByRole("heading", { name: "Нет доступа" }),
  ).toBeVisible();
  state.authenticated = false;
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Требуется вход" }),
  ).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveCount(0);
  await expect(page.getByText("Проверенный пользователь")).toHaveCount(0);
});

test("return target rejects external URLs, encoded separators and credential query", async ({
  page,
}) => {
  await mockPortal(page, { authenticated: true, local: false, admin: false });
  for (const target of [
    "https://example.org/",
    "//example.org/",
    "/audit-arch/%2e%2e/admin",
    "/audit-arch/departments/12?token=secret",
    "/audit-arch/api/findings",
    "/api/v1/resources",
  ]) {
    await page.goto("/?return_to=" + encodeURIComponent(target));
    await expect(page.locator(".employee-shell")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
  }
});

test("reduced motion removes success panel movement", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() =>
    sessionStorage.setItem("pl-ui-login-animation", String(Date.now())),
  );
  await mockPortal(page, { authenticated: true, local: false, admin: false });
  await page.goto("/");
  await expect.poll(async () => {
    await page.clock.runFor(10);
    return page.getByText("Вход выполнен", { exact: true }).isVisible();
  }).toBe(true);
  expect(
    await page
      .locator(".login-success-panel-left")
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
  await page.clock.runFor(200);
  await expect(page.locator(".employee-shell")).toBeVisible();
});
