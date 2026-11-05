import { test, expect } from "@playwright/test";

for (const { kind, managedCredentials } of [
  { kind: "wayline", managedCredentials: false },
  { kind: "fileauditor", managedCredentials: false },
  { kind: "prometheus", managedCredentials: false },
  { kind: "mailcow", managedCredentials: true },
  { kind: "mailcow", managedCredentials: false },
] as const) {
  test(`Connector catalogue submits ${kind} with managed credentials ${managedCredentials}`, async ({
    page,
  }) => {
    const connectionName = {
      wayline: "Wayline",
      fileauditor: "File Auditor",
      prometheus: "Prometheus",
      mailcow: "Mailcow",
    }[kind];
    const address = {
      wayline: "https://wayline.example.org",
      fileauditor: "https://auditor.example.org/audit",
      prometheus: "http://prometheus.example.org:9090",
      mailcow: "https://mail.example.org",
    }[kind];
    const writes: Record<string, unknown>[] = [];
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace("/api/v1", "");
      if (request.method() === "POST" && path === "/modules") {
        expect(request.headers()["x-csrf-token"]).toBe("connector-csrf");
        writes.push(request.postDataJSON());
        return route.fulfill({
          status: 503,
          json: {
            error: "fixture_stop",
            message: "Проверка запроса завершена",
          },
        });
      }
      const responses: Record<string, unknown> = {
        "/session": {
          authenticated: true,
          user: { id: "admin", name: "Admin", admin: true },
          csrf_token: "connector-csrf",
        },
        "/help-state": { disabled: true, seen: [] },
        "/preferences": {
          favorites: [],
          hidden_sections: [],
          section_order: [],
          home_widgets: [],
        },
        "/chart-settings": { revision: 1, charts: [] },
        "/wayline": { sources: [] },
        "/modules": { items: [] },
        "/modules/catalog": {
          local_available: true,
          managed_credentials_available: managedCredentials,
          items: [
            {
              id: kind,
              name: kind === "mailcow" ? "Почта" : connectionName,
              description: "Подключение сервиса",
              modes: ["external"],
            },
          ],
        },
      };
      return route.fulfill({ json: responses[path] ?? [] });
    });
    await page.goto("/#module-catalog");
    await page
      .getByRole("button", { name: "Подключить существующий", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    const endpoint = dialog.getByRole("textbox", {
      name: new RegExp(`^Адрес ${connectionName}`),
    });
    await expect(endpoint).toHaveAttribute("placeholder", address);
    await endpoint.fill(address!);
    if (kind === "wayline")
      await page
        .getByRole("textbox", { name: /^Логин Wayline/ })
        .fill("connector-user");
    if (kind === "mailcow") {
      const guide = dialog.locator("details").filter({
        has: page.getByText("Как подключить Mailcow", { exact: true }),
      });
      const summary = guide.locator("summary");
      await expect(guide).not.toHaveAttribute("open", "");
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(guide).toHaveAttribute("open", "");
      await expect(guide.getByRole("listitem")).toHaveCount(5);
      await expect(guide.locator("ol")).toHaveCSS("list-style-type", "decimal");
      await expect(guide).toContainText("Система → Конфигурация");
      await expect(guide).toContainText("Настройки доступа → Администраторы");
      await expect(guide).toContainText("Доступ только для чтения");
      await expect(guide).toContainText("Включить API");
      await expect(guide).toContainText("Список IP-адресов для доступа к API");
      await expect(guide).toContainText("после NAT");
      await expect(guide).toContainText("Сохранить изменения");
      await expect(guide).toContainText("Ключ API");
      await expect(guide).toContainText("без /admin и /api/v1");
      await expect(guide).toContainText("Сбор данных");
      await expect(guide).not.toContainText("Edit administrator details");
      if (managedCredentials && process.env.PL_MAILCOW_GUIDE_REVIEW_DIR) {
        await guide.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `${process.env.PL_MAILCOW_GUIDE_REVIEW_DIR}/guide-1920.png`,
        });
        await page.setViewportSize({ width: 3440, height: 1440 });
        await page.screenshot({
          path: `${process.env.PL_MAILCOW_GUIDE_REVIEW_DIR}/guide-3440.png`,
        });
        await page.setViewportSize({ width: 1920, height: 1080 });
      }
      await summary.press("Enter");
      await expect(guide).not.toHaveAttribute("open", "");
      await expect(
        dialog.getByRole("combobox", { name: /^API-ключ/ }),
      ).toHaveValue(managedCredentials ? "key" : "reference");
    }
    if (kind === "mailcow" && managedCredentials) {
      await dialog
        .getByLabel(/^API-ключ Mailcow\b/)
        .fill("fixture-read-only-key");
      await expect(dialog.getByText(/file:имя|env:PORTAL_SECRET/)).toHaveCount(
        0,
      );
    } else if (kind !== "prometheus") {
      await dialog
        .getByRole("textbox", {
          name:
            kind === "wayline"
              ? /^Пароль Wayline на сервере/
              : kind === "fileauditor"
                ? /^Ключ доступа File Auditor на сервере/
                : /^API-ключ Mailcow на сервере/,
        })
        .fill("file:connector-key");
    }
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Подключить", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "Проверка запроса завершена",
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      module_id: kind,
      mode: "external",
      ...(kind === "mailcow" && managedCredentials
        ? { api_key: "fixture-read-only-key" }
        : kind !== "prometheus"
          ? { secret_ref: "file:connector-key" }
          : {}),
      ...(kind !== "prometheus"
        ? {
            config:
              kind === "wayline" ? { basic_username: "connector-user" } : {},
          }
        : {}),
    });
    expect(writes[0]).not.toHaveProperty("password");
    expect(writes[0]).not.toHaveProperty("token");
    if (kind === "mailcow" && managedCredentials)
      expect(writes[0]).not.toHaveProperty("secret_ref");
    if (kind === "mailcow" && !managedCredentials)
      expect(writes[0]).not.toHaveProperty("api_key");
  });
}
