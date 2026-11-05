import { test, expect, type Page } from "@playwright/test";

async function mockPortal(page: Page, state: { authenticated: boolean }) {
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/session")
        ? {
            authenticated: state.authenticated,
            user: state.authenticated
              ? { id: "viewer", name: "Тест", admin: false }
              : undefined,
            csrf_token: "fixture",
            ad_login_enabled: true,
            board_anonymous_enabled: false,
          }
        : {},
    }),
  );
  await page.route("**/auth/ad", (route) => {
    state.authenticated = true;
    return route.fulfill({ json: {} });
  });
}

test("Doska document 401 button preserves the page through mocked AD login", async ({
  page,
}) => {
  const target = "/doska/projects/p-1";
  await mockPortal(page, { authenticated: false });
  await page.route("**" + target, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: "<h1>Задачи проекта</h1>",
    }),
  );
  await page.goto("/401?return_to=" + encodeURIComponent(target));
  const login = page.getByRole("link", { name: "Войти в Платформу" });
  await expect(login).toHaveAttribute(
    "href",
    "/?return_to=" + encodeURIComponent(target),
  );
  await login.click();
  await expect(page.locator(".auth-login")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("pl-ui-login-return")))
    .toBe(target);
  await page
    .locator(".domain-login input[autocomplete=username]")
    .fill("fixture");
  await page.locator(".domain-login input[type=password]").fill("fixture-only");
  await page.locator(".domain-login button[type=submit]").click();
  await expect(page).toHaveURL(new RegExp(target + "$"));
  await expect(
    page.getByRole("heading", { name: "Задачи проекта" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem("pl-ui-login-return")),
  ).toBeNull();
});

test("an authenticated mocked session consumes the pending Doska page", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("pl-ui-login-return", "/doska/"),
  );
  await mockPortal(page, { authenticated: true });
  await page.route("**/doska/", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: "<h1>Доска</h1>",
    }),
  );
  await page.goto("/");
  await expect(page).toHaveURL(/\/doska\/$/);
  await expect(page.getByRole("heading", { name: "Доска" })).toBeVisible();
});

test("a Doska API return cannot reach the 401 login button or pending state", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("pl-ui-login-return", "/doska/"),
  );
  await mockPortal(page, { authenticated: false });
  await page.goto(
    "/401?return_to=" + encodeURIComponent("/doska/api/doska/context"),
  );
  await expect(
    page.getByRole("link", { name: "Войти в Платформу" }),
  ).toHaveAttribute("href", "/");
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("pl-ui-login-return")))
    .toBeNull();
});
