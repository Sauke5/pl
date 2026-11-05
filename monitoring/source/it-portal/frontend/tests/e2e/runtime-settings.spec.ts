import { test, expect } from "@playwright/test";

test("Operations saves independent settings and preserves unrelated board values", async ({
  page,
}) => {
  let settings = {
    revision: 1,
    timezone: "UTC",
    stale_after_seconds: 180,
    board_enabled: true,
    board_anonymous: false,
    board_title: "Operations board",
    board_resource_ids: ["keep-resource"],
    session_lifetime_minutes: 480,
    local_password_min_length: 12,
  };
  const writes: (typeof settings)[] = [];
  let conflict = false;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (path === "/settings" && request.method() === "PUT") {
      expect(request.headers()["x-csrf-token"]).toBe("operations-csrf");
      writes.push(request.postDataJSON());
      if (conflict)
        return route.fulfill({
          status: 409,
          json: {
            error: "revision_conflict",
            message: "Настройки уже изменены",
          },
        });
      settings = { ...request.postDataJSON(), revision: settings.revision + 1 };
      return route.fulfill({ json: settings });
    }
    const responses: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "admin", name: "Admin", admin: true },
        csrf_token: "operations-csrf",
        timezone: settings.timezone,
      },
      "/settings": settings,
      "/runtime": {
        host: {
          hostname: "pl-lab-fixture",
          kernel: "linux-fixture",
          cpus: 6,
          load_average: [0.25, 0.5, 0.75],
          uptime_seconds: 90061,
          memory: { total_bytes: 8589934592, available_bytes: 4294967296 },
          storage: {
            total_bytes: 107374182400,
            used_bytes: 42949672960,
            free_bytes: 64424509440,
          },
          observed_at: "2026-10-18T09:00:00Z",
        },
        go_version: "go-fixture",
        os: "linux",
        architecture: "amd64",
        process_memory_bytes: 104857600,
        process_heap_bytes: 52428800,
        available_cpus: 4,
        goroutines: 20,
        session_lifetime_minutes: 480,
        allowed_cidrs: ["127.0.0.1/32"],
        allowed_ports: [443],
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
    };
    return route.fulfill({ json: responses[path] ?? [] });
  });
  await page.goto("/#settings");
  await page.getByRole("button", { name: "Эксплуатация", exact: true }).click();
  await expect(page.getByText("pl-lab-fixture", { exact: true })).toBeVisible();
  await expect(
    page.getByText("4.0 ГиБ / 8.0 ГиБ", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("40.0 ГиБ / 60.0 ГиБ / 100.0 ГиБ", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("1 дн. 1 ч. 1 мин.", { exact: true }),
  ).toBeVisible();
  await page
    .getByText("Процесс API и ограничения проверок", { exact: true })
    .click();
  await expect(page.getByText("go-fixture", { exact: false })).toBeVisible();
  await expect(page.getByText("100.0 МБ", { exact: true })).toBeVisible();
  await page.getByRole("spinbutton", { name: /^Срок новой сессии/ }).fill("15");
  await page
    .getByRole("spinbutton", { name: /^Минимальная длина пароля/ })
    .fill("8");
  await expect(
    page.getByRole("spinbutton", { name: /^Порог устаревания/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /^Часовой пояс/ })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Сохранить настройки", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Настройки сохранены");
  expect(writes[0]).toMatchObject({
    session_lifetime_minutes: 15,
    local_password_min_length: 8,
    timezone: "UTC",
    stale_after_seconds: 180,
    board_enabled: true,
    board_title: "Operations board",
    board_resource_ids: ["keep-resource"],
  });
  conflict = true;
  await page
    .getByRole("spinbutton", { name: /^Минимальная длина пароля/ })
    .fill("24");
  await page
    .getByRole("button", { name: "Сохранить настройки", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Запись уже изменена");
  await expect(
    page.getByRole("button", { name: "Сохранить настройки", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("spinbutton", { name: /^Минимальная длина пароля/ }),
  ).toHaveValue("24");
  await page
    .getByRole("button", { name: "Загрузить актуальные", exact: true })
    .click();
  await expect(
    page.getByRole("spinbutton", { name: /^Минимальная длина пароля/ }),
  ).toHaveValue("8");
  await expect(
    page.getByRole("button", { name: "Сохранить настройки", exact: true }),
  ).toBeEnabled();
});
