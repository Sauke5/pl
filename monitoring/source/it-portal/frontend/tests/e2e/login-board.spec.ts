import { test, expect, type Page } from "@playwright/test";

const serviceID = "75bb074f-7095-4a9b-8d66-122ee00f5dab";
const storageKey = "pl-ui-login-board-service";
const name = "Опросы и тесты";
type State = {
  authenticated: boolean;
  destination?: string;
  published?: boolean;
  boardError?: boolean;
  reads: number;
};
async function fixture(page: Page, options: Partial<State> = {}) {
  const state: State = {
    authenticated: false,
    destination: "/forms/",
    published: true,
    reads: 0,
    ...options,
  };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(
      "/api/v1".length,
    );
    if (path === "/session")
      return route.fulfill({
        json: {
          authenticated: state.authenticated,
          user: state.authenticated
            ? { id: "fixture", name: "Проверка", admin: false }
            : undefined,
          csrf_token: "fixture",
          ad_login_enabled: true,
          local_login_enabled: true,
          oidc_login_enabled: true,
          board_anonymous_enabled: true,
        },
      });
    if (path === "/board") {
      if (state.authenticated) state.reads++;
      if (state.authenticated && state.boardError)
        return route.fulfill({
          status: 503,
          json: { message: "Источник недоступен" },
        });
      return route.fulfill({
        json: {
          title: "Сервисы PL",
          items:
            state.authenticated && !state.published
              ? []
              : [
                  {
                    id: serviceID,
                    name,
                    description: "",
                    status: "healthy",
                    ...(state.authenticated ? { url: state.destination } : {}),
                  },
                  {
                    id: "auditor",
                    name: "Файловый аудитор",
                    description: "",
                    status: "unknown",
                  },
                ],
        },
      });
    }
    if (path === "/dashboard-layout")
      return route.fulfill({
        json: { revision: 0, tiles: [], hidden: [] },
      });
    if (path === "/help-state")
      return route.fulfill({ json: { disabled: true, seen: [] } });
    return route.fulfill({ json: [] });
  });
  for (const method of ["ad", "local"])
    await page.route(`**/auth/${method}`, (route) => {
      state.authenticated = true;
      return route.fulfill({ json: {} });
    });
  await page.route("**/auth/login", (route) => {
    state.authenticated = true;
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<script>location.replace("/")</script>',
    });
  });
  for (const path of [
    "/forms/",
    "/forms/survey1",
    "/wiki/books/handbook",
    "/directory/people",
    "/doska/projects/p-1",
    "/updated-service/",
  ]) {
    await page.route(`**${path}`, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<meta charset="utf-8"><h1>Открыт ${path}</h1>`,
      }),
    );
  }
  return state;
}
async function login(page: Page, method = "ad") {
  if (method === "oidc") {
    await page.locator(".auth-oidc-link").click();
    return;
  }
  if (method === "local") await page.locator(".local-login summary").click();
  const form = page.locator(
    method === "local" ? ".local-login form" : ".domain-login",
  );
  await form.getByLabel("Логин", { exact: true }).fill("fixture");
  await form.getByLabel("Пароль", { exact: true }).fill("fixture-only");
  await form.locator("button[type=submit]").click();
}
async function choose(page: Page) {
  await page
    .getByRole("button", { name: `Войти и открыть ${name}`, exact: true })
    .click();
  await expect(page.locator(".board-login-selection")).toContainText(name);
}
for (const [width, height] of [[1920, 1080]])
  for (const theme of ["dark", "light"]) {
    test(`login board full card hit area and focus ${width} ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(
        (theme) => localStorage.setItem("pl-ui-theme", theme),
        theme,
      );
      await fixture(page);
      await page.goto("/");
      const card = page.getByRole("button", {
        name: `Войти и открыть ${name}`,
        exact: true,
      });
      await card.scrollIntoViewIfNeeded();
      await page
        .locator(".board-shell")
        .screenshot({ path: info.outputPath("board.png") });
      const box = await card.boundingBox();
      expect(box).not.toBeNull();
      // Hit the empty padded corner, rather than only the label.
      await card.click({
        position: { x: box!.width - 12, y: box!.height - 12 },
      });
      await expect(page.locator(".board-login-selection")).toContainText(name);
      await expect(
        page.locator('.domain-login input[autocomplete="username"]'),
      ).toBeFocused();
      await expect
        .poll(() =>
          page.evaluate((key) => sessionStorage.getItem(key), storageKey),
        )
        .toBe(serviceID);
      expect(await card.getAttribute("href")).toBeNull();
      expect(
        await page.evaluate(() => sessionStorage.getItem("pl-ui-login-return")),
      ).toBeNull();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page
        .locator(".auth-login")
        .screenshot({ path: info.outputPath("selected-login.png") });
      await page
        .getByRole("button", { name: "Отменить выбор", exact: true })
        .click();
      await expect(page.locator(".board-login-selection")).toHaveCount(0);
      await card.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(".board-login-selection")).toContainText(name);
    });
  }
for (const method of ["ad", "local", "oidc"])
  test(`selected service survives ${method} login and uses the refreshed board URL`, async ({
    page,
  }) => {
    const state = await fixture(page);
    await page.goto("/");
    await choose(page);
    // Publication metadata changed while the user was entering credentials.
    state.destination = "/updated-service/";
    await login(page, method);
    await expect(
      page.getByText("Вход выполнен", { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/updated-service\/$/);
    await expect(
      page.getByRole("heading", { name: "Открыт /updated-service/" }),
    ).toBeVisible();
    expect(state.reads).toBeGreaterThan(0);
    expect(
      await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
    ).toBeNull();
  });
for (const failure of ["unpublished", "unsafe", "error", "same-page"])
  test(`selected service ${failure} has a consumed fallback without a redirect loop`, async ({
    page,
  }) => {
    const state = await fixture(page);
    await page.goto("/");
    await choose(page);
    if (failure === "unpublished") state.published = false;
    if (failure === "unsafe") state.destination = "javascript:alert(1)";
    if (failure === "same-page") state.destination = "/";
    if (failure === "error") state.boardError = true;
    await login(page);
    await expect(
      page.getByRole("heading", { name: "Не удалось открыть сервис" }),
    ).toBeVisible();
    expect(state.reads).toBe(1);
    expect(
      await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
    ).toBeNull();
    state.boardError = false;
    await page.getByRole("button", { name: "На главную", exact: true }).click();
    await expect(page.locator(".employee-shell")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
    await page.reload();
    await expect(page.locator(".employee-shell")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Не удалось открыть сервис" }),
    ).toHaveCount(0);
  });
test("failed login keeps the chosen service and retry can open it", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.route("**/auth/ad", (route) =>
    route.fulfill({
      status: 400,
      json: { message: "Неверный логин или пароль" },
    }),
  );
  await page.goto("/");
  await choose(page);
  await login(page);
  await expect(page.getByRole("alert")).toContainText(
    "Неверный логин или пароль",
  );
  await expect(page.locator(".board-login-selection")).toContainText(name);
  expect(state.reads).toBe(0);
  await page.unroute("**/auth/ad");
  await page.route("**/auth/ad", (route) => {
    state.authenticated = true;
    return route.fulfill({ json: {} });
  });
  await login(page);
  await expect(page).toHaveURL(/\/forms\/$/);
});
for (const target of ["/doska/projects/p-1", "/directory/people"])
  test(`explicit return_to ${target} wins over a previous card selection`, async ({
    page,
  }) => {
    await fixture(page);
    await page.goto("/");
    await choose(page);
    await page.goto("/?return_to=" + encodeURIComponent(target));
    await expect(page.locator(".auth-login")).toBeVisible();
    expect(
      await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
    ).toBeNull();
    await login(page);
    await expect(page).toHaveURL(new RegExp(target + "$"));
  });
test("choosing a card replaces an earlier explicit return_to", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/?return_to=%2Fdoska%2Fprojects%2Fp-1");
  await choose(page);
  expect(new URL(page.url()).searchParams.has("return_to")).toBe(false);
  await login(page);
  await expect(page).toHaveURL(/\/forms\/$/);
});
test("tampered URL in the pending ID slot never becomes a destination", async ({
  page,
}) => {
  await page.addInitScript(
    (key) => sessionStorage.setItem(key, "https://example.invalid/"),
    storageKey,
  );
  const state = await fixture(page, { authenticated: true });
  await page.goto("/");
  await expect(page.locator(".employee-shell")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  // Board is read only by the ordinary employee view.
  expect(state.reads).toBe(1);
});

test("Forms document return_to survives the existing 401 login flow", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/401?return_to=" + encodeURIComponent("/forms/survey1"));
  await page
    .getByRole("link", { name: "Войти в Платформу", exact: true })
    .click();
  await login(page);
  await expect(page.getByText("Вход выполнен", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/forms\/survey1$/);
  await expect(
    page.getByRole("heading", { name: "Открыт /forms/survey1" }),
  ).toBeVisible();
});
test("Forms return_to retains API, credential query and external redirect restrictions", async ({
  page,
}) => {
  await fixture(page);
  for (const target of [
    "/forms/api/v1/context",
    "/forms/survey1?token=fixture",
    "/forms/survey1?redirect=https://example.invalid/",
    "/forms/survey1?url=//example.invalid/",
    "/forms/%2e%2e/auth/login",
    "//example.invalid/forms/survey1",
  ]) {
    await page.goto("/401?return_to=" + encodeURIComponent(target));
    await expect(
      page.getByRole("link", { name: "Войти в Платформу", exact: true }),
    ).toHaveAttribute("href", "/");
    expect(
      await page.evaluate(() => sessionStorage.getItem("pl-ui-login-return")),
    ).toBeNull();
  }
});
test("Wiki document return keeps the native page and rejects API and credential returns", async ({
  page,
}) => {
  const state = await fixture(page);
  const target = "/wiki/books/handbook";
  await page.goto("/401?return_to=" + encodeURIComponent(target));
  await page
    .getByRole("link", { name: "Войти в Платформу", exact: true })
    .click();
  await login(page);
  await expect(page).toHaveURL(/\/wiki\/books\/handbook$/);
  await expect(
    page.getByRole("heading", { name: "Открыт /wiki/books/handbook" }),
  ).toBeVisible();
  for (const rejected of [
    "/wiki/api/books",
    "/wiki/login?password=fixture",
    "/wiki/%2e%2e/auth/login",
  ]) {
    state.authenticated = false;
    await page.goto("/401?return_to=" + encodeURIComponent(rejected));
    await expect(
      page.getByRole("link", { name: "Войти в Платформу", exact: true }),
    ).toHaveAttribute("href", "/");
    expect(
      await page.evaluate(() => sessionStorage.getItem("pl-ui-login-return")),
    ).toBeNull();
  }
});
test("stale bounded service ID is consumed after login without navigation", async ({
  page,
}) => {
  await page.addInitScript(
    (key) => sessionStorage.setItem(key, "removed-service"),
    storageKey,
  );
  await fixture(page);
  await page.goto("/");
  await login(page);
  await expect(
    page.getByRole("heading", { name: "Не удалось открыть сервис" }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
  ).toBeNull();
});
test("blocked selection storage explains the fallback and leaves login usable", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === key) throw new Error("Fixture storage denied");
      return original.call(this, k, v);
    };
  }, storageKey);
  await fixture(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: `Войти и открыть ${name}`, exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "Браузер не сохранил выбор. После входа откройте сервис на главной.",
  );
  await login(page);
  await expect(
    page.getByRole("heading", { name: "Куда перейдём?", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Не удалось открыть сервис" }),
  ).toHaveCount(0);
});

test("authenticated employee card opens the published service directly", async ({
  page,
}) => {
  await fixture(page, { authenticated: true });
  await page.context().route("**/forms/", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<meta charset="utf-8"><h1>Сервис открыт напрямую</h1>',
    }),
  );
  await page.goto("/");
  const link = page
    .locator("a.employee-card-link")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(link).toHaveAttribute("href", /\/forms\/$/);
  const opened = page.waitForEvent("popup");
  await link.click();
  const popup = await opened;
  await expect(
    popup.getByRole("heading", { name: "Сервис открыт напрямую", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
  ).toBeNull();
  await popup.close();
});
