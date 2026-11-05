import { expect, test } from "@playwright/test";

test("AD draft checks and persists credentials without exposing saved password", async ({
  page,
}) => {
  let state = {
    revision: 0,
    configured: false,
    writable: true,
    password_set: false,
    source: "web",
    url: "",
    base_dn: "",
    user_suffix: "",
    admin_group_dn: "",
    bind_username: "",
    ca_pem: "",
  };
  const writes: {
    method: string;
    path: string;
    body: Record<string, unknown>;
  }[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (path === "/settings/ad" && request.method() === "GET")
      return route.fulfill({ json: state });
    if (path.startsWith("/settings/ad") && request.method() !== "GET") {
      expect(request.headers()["x-csrf-token"]).toBe("ad-csrf");
      const body = request.postDataJSON();
      writes.push({ method: request.method(), path, body });
      if (path.endsWith("/test")) return route.fulfill({ json: { ok: true } });
      const { password: _password, ...configuration } = body;
      state = {
        ...state,
        ...configuration,
        configured: true,
        password_set: true,
        revision: state.revision + 1,
      };
      return route.fulfill({ json: state });
    }
    const responses: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "local-admin", name: "Admin", admin: true },
        csrf_token: "ad-csrf",
      },
      "/settings": { revision: 1, timezone: "UTC", stale_after_seconds: 180 },
      "/modules": { items: [] },
      "/preferences": {
        favorites: [],
        hidden_sections: [],
        section_order: [],
        home_widgets: [],
      },
      "/help-state": { disabled: true, seen: [] },
      "/chart-settings": { revision: 1, charts: [] },
      "/wayline": { sources: [] },
    };
    return route.fulfill({ json: responses[path] ?? [] });
  });
  await page.goto("/#settings?section=ad");
  await expect(
    page.getByRole("heading", { name: "Active Directory", exact: true }),
  ).toBeVisible();
  await page.getByLabel(/^Сервер AD/).fill("ldaps://dc.example.test:636");
  await page.getByLabel(/^Домен входа/).fill("example.test");
  await page.getByLabel(/^Base DN/).fill("DC=example,DC=test");
  await page
    .getByLabel(/^DN группы администраторов/)
    .fill("CN=PL Admins,DC=example,DC=test");
  await page.getByLabel(/^Учётная запись чтения/).fill("reader@example.test");
  await page
    .getByLabel(/^Пароль учётной записи чтения/)
    .fill("local-fixture-password");
  await page
    .getByRole("button", { name: "Проверить подключение", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Подключение проверено");
  expect(writes).toHaveLength(1);
  expect(state.revision).toBe(0);
  await page
    .getByRole("navigation", { name: "Разделы настроек" })
    .getByRole("button", { name: "Обзор", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Есть несохранённые изменения" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Остаться", exact: true }).click();
  await page
    .getByRole("button", { name: "Проверить и сохранить", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Настройки AD сохранены",
  );
  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({
    method: "PUT",
    path: "/settings/ad",
    body: {
      revision: 0,
      password: "local-fixture-password",
      url: "ldaps://dc.example.test:636",
    },
  });
  await expect(page.getByLabel(/^Пароль учётной записи чтения/)).toHaveValue(
    "",
  );
  await page.reload();
  await expect(page.getByText("AD настроен", { exact: true })).toBeVisible();
  await expect(page.getByLabel(/^Сервер AD/)).toHaveValue(
    "ldaps://dc.example.test:636",
  );
  await expect(page.getByLabel(/^Пароль учётной записи чтения/)).toHaveValue(
    "",
  );
  await page.getByLabel(/^Домен входа/).fill("other.example.test");
  await page
    .getByRole("button", { name: "Проверить и сохранить", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Настройки AD сохранены",
  );
  expect(writes[2].body.password).toBe("");
});

test("failed AD validation preserves entered settings and offers retry", async ({
  page,
}) => {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/settings/ad" && route.request().method() === "PUT")
      return route.fulfill({
        status: 503,
        json: {
          error: "ad_connection_failed",
          message: "Не удалось проверить AD",
        },
      });
    const responses: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "local-admin", admin: true },
        csrf_token: "ad-csrf",
      },
      "/settings/ad": {
        revision: 1,
        configured: true,
        writable: true,
        password_set: true,
        source: "web",
        url: "ldaps://dc.example.test",
        base_dn: "DC=example,DC=test",
        user_suffix: "example.test",
        admin_group_dn: "CN=Admins,DC=example,DC=test",
        bind_username: "reader@example.test",
        ca_pem: "",
      },
      "/modules": { items: [] },
      "/settings": { revision: 1 },
      "/help-state": { disabled: true, seen: [] },
      "/chart-settings": { revision: 1, charts: [] },
      "/wayline": { sources: [] },
      "/preferences": {
        favorites: [],
        hidden_sections: [],
        section_order: [],
        home_widgets: [],
      },
    };
    return route.fulfill({ json: responses[path] ?? [] });
  });
  await page.goto("/#settings?section=ad");
  await page
    .getByLabel(/^Учётная запись чтения/)
    .fill("new-reader@example.test");
  await page
    .getByLabel(/^Пароль учётной записи чтения/)
    .fill("retain-on-failure");
  await page
    .getByRole("button", { name: "Проверить и сохранить", exact: true })
    .click();
  await expect(
    page.getByText("Не удалось проверить AD", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel(/^Учётная запись чтения/)).toHaveValue(
    "new-reader@example.test",
  );
  await expect(page.getByLabel(/^Пароль учётной записи чтения/)).toHaveValue(
    "retain-on-failure",
  );
  await expect(
    page.getByRole("button", { name: "Проверить и сохранить", exact: true }),
  ).toBeEnabled();
});
