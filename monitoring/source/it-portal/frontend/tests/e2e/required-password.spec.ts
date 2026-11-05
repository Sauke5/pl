import { expect, test, type Page } from "@playwright/test";
const current = "Initial-pass-042!",
  next = "New-password-042!";
async function fixture(
  page: Page,
  options: {
    required?: boolean;
    admin?: boolean;
    id?: string;
    wrongCurrent?: boolean;
    delay?: boolean;
  } = {},
) {
  let authenticated = true;
  const reads: string[] = [],
    writes: { path: string; body: unknown }[] = [];
  let release = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (request.method() === "GET") reads.push(path);
    if (path === "/session")
      return route.fulfill({
        json: {
          authenticated,
          user: authenticated
            ? {
                id: options.id || "local-admin",
                name: "Администратор",
                admin: options.admin !== false,
              }
            : undefined,
          csrf_token: "password-fixture",
          local_login_enabled: true,
          ad_login_enabled: options.id?.startsWith("ad:"),
          local_password_change_enabled: true,
          local_password_change_required:
            authenticated && options.required !== false,
          local_password_min_length: 12,
          local_users_enabled: true,
          features: {},
        },
      });
    if (path === "/upgrade-status")
      return route.fulfill({
        json: { active: false, ready: false, current_version: "0.4.4" },
      });
    if (
      path === "/local-admin/password" ||
      path === "/local-users/me/password"
    ) {
      expect(request.headers()["x-csrf-token"]).toBe("password-fixture");
      writes.push({ path, body: request.postDataJSON() });
      if (options.delay) await barrier;
      if (options.wrongCurrent)
        return route.fulfill({
          status: 401,
          json: { error: "invalid_current_password" },
        });
      authenticated = false;
      return route.fulfill({ status: 204 });
    }
    const data: Record<string, unknown> = {
      "/settings": {
        revision: 1,
        timezone: "UTC",
        stale_after_seconds: 180,
        session_lifetime_minutes: 480,
        local_password_min_length: 12,
      },
      "/runtime": {},
      "/modules": { items: [] },
      "/workspace-preferences": { revision: 1, system_ids: [], groups: [] },
      "/preferences": {
        favorites: [],
        hidden_sections: [],
        section_order: [],
        home_widgets: [],
        system_ids: [],
      },
      "/help-state": { disabled: true, seen: [] },
      "/chart-settings": { revision: 1, charts: [] },
      "/wayline": { sources: [] },
      "/board": { items: [] },
    };
    return route.fulfill({ json: data[path] ?? [] });
  });
  await page.route("**/auth/logout", async (route) => {
    expect(route.request().headers()["x-csrf-token"]).toBe("password-fixture");
    writes.push({ path: "/auth/logout", body: route.request().postDataJSON() });
    authenticated = false;
    return route.fulfill({ status: 204 });
  });
  return { reads, writes, release };
}
async function fill(page: Page) {
  await page.getByLabel("Текущий пароль", { exact: true }).fill(current);
  await page.getByLabel("Новый пароль", { exact: true }).fill(next);
  await page.getByLabel("Повторите новый пароль", { exact: true }).fill(next);
}
async function evidence(page: Page, name: string) {
  if (process.env.PL_UI_EVIDENCE_DIR)
    await page.screenshot({
      path: process.env.PL_UI_EVIDENCE_DIR + "/" + name + ".png",
    });
}

test("marked initial session only mounts password setup and blocks cards, stream, board and address return", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("pl-ui-login-board-service", "wiki");
    sessionStorage.setItem("pl-ui-login-return", "/forms/");
    sessionStorage.setItem("pl-ui-login-animation", String(Date.now()));
    sessionStorage.setItem(
      "pl.installation-transition",
      JSON.stringify({
        operationId: "e343a354-a734-4a92-94d4-ce52f0ce8d1d",
        nextOrigin: "https://next.example.test",
        acceptedAt: Date.now(),
      }),
    );
  });
  const state = await fixture(page);
  await page.goto("/#settings?section=users");
  await expect(
    page.getByRole("heading", { name: "Задайте пароль", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Текущий пароль", { exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("navigation", { name: "Основная навигация" }),
  ).toHaveCount(0);
  expect(
    state.reads.filter((x) => !["/session", "/upgrade-status"].includes(x)),
  ).toEqual([]);
  expect(state.writes).toHaveLength(0);
  for (const input of await page.locator("input").all())
    await expect(input).toHaveAttribute("type", "password");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Задайте пароль", exact: true }),
  ).toBeVisible();
  expect(
    state.reads.filter((x) => !["/session", "/upgrade-status"].includes(x)),
  ).toEqual([]);
  expect(new URL(page.url()).pathname).toBe("/");
});
test("keyboard submit changes password once, disables concurrent actions and returns to revoked-session login", async ({
  page,
}) => {
  const state = await fixture(page, { delay: true });
  await page.goto("/");
  await expect(
    page.getByLabel("Текущий пароль", { exact: true }),
  ).toBeFocused();
  await fill(page);
  await page
    .getByLabel("Повторите новый пароль", { exact: true })
    .press("Enter");
  await expect(
    page.getByRole("button", { name: "Сохраняем…", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Выйти", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("Текущий пароль", { exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("form", { name: "Обязательная смена пароля" })
    .evaluate((el) => (el as HTMLFormElement).requestSubmit());
  expect(state.writes).toEqual([
    {
      path: "/local-admin/password",
      body: { current_password: current, new_password: next },
    },
  ]);
  state.release();
  await expect(page).toHaveURL(/\?password_changed=1$/);
  await expect(
    page.getByRole("heading", { name: "Вход в Платформу", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Пароль изменён. Войдите с новым паролем.", { exact: true }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(1);
});
test("password validation and server error remain on setup without mounting main data", async ({
  page,
}) => {
  const state = await fixture(page, { wrongCurrent: true });
  await page.goto("/");
  await fill(page);
  await page
    .getByLabel("Повторите новый пароль", { exact: true })
    .fill("Other-password-042!");
  await page
    .getByRole("button", { name: "Сохранить пароль", exact: true })
    .click();
  await expect(
    page.getByText("Новые пароли не совпадают.", { exact: true }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await page.getByLabel("Повторите новый пароль", { exact: true }).fill(next);
  await page
    .getByRole("button", { name: "Сохранить пароль", exact: true })
    .click();
  await expect(
    page.getByText("Текущий пароль указан неверно.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Текущий пароль", { exact: true })).toHaveValue(
    "",
  );
  await expect(page.getByLabel("Новый пароль", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    page.getByLabel("Текущий пароль", { exact: true }),
  ).toBeFocused();
  expect(
    state.reads.filter((x) => !["/session", "/upgrade-status"].includes(x)),
  ).toEqual([]);
  expect(state.writes).toHaveLength(1);
});
test("initial admin can explicitly log out without changing password", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Вход в Платформу", exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([{ path: "/auth/logout", body: {} }]);
});
for (const id of ["local-admin", "ad:employee"])
  test(`${id} without the marker keeps its normal interface`, async ({
    page,
  }) => {
    const state = await fixture(page, {
      required: false,
      id,
      admin: id === "local-admin",
    });
    await page.goto("/#catalog");
    await expect(
      page.getByRole("heading", {
        name: id === "local-admin" ? "Каталог ресурсов" : "Куда перейдём?",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Задайте пароль", exact: true }),
    ).toHaveCount(0);
    expect(state.writes).toHaveLength(0);
  });
for (const theme of ["light", "night"])
  test(`first password screen keeps ${theme} theme on desktop and mobile`, async ({
    page,
  }) => {
    await page.addInitScript(
      (theme) => localStorage.setItem("pl-ui-theme", theme),
      theme,
    );
    const state = await fixture(page);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Задайте пароль", exact: true }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await evidence(page, `required-password-${theme}-1920`);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("heading", { name: "Задайте пароль", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Сохранить пароль", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await evidence(page, `required-password-${theme}-mobile`);
    expect(
      state.reads.filter((x) => !["/session", "/upgrade-status"].includes(x)),
    ).toEqual([]);
  });
