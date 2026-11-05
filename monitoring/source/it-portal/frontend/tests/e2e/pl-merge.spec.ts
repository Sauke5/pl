import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  const requests: string[] = [];
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    requests.push(path);
    const data: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "merge-admin", name: "Администратор", admin: true },
        csrf_token: "merge-fixture",
        local_users_enabled: true,
        local_password_change_enabled: true,
        local_password_change_required: true,
        features: { doska: false, sftp: false, sftp_exchange: false },
      },
      "/settings": {
        revision: 1,
        timezone: "UTC",
        stale_after_seconds: 180,
        session_lifetime_minutes: 480,
        local_password_min_length: 12,
        board_enabled: false,
        board_anonymous: false,
        board_title: "",
        board_resource_ids: [],
      },
      "/runtime": {
        host_error: "Нет данных хоста",
        session_lifetime_minutes: 480,
      },
      "/workspace-preferences": { revision: 0, system_ids: [], groups: [] },
      "/dashboard-layout": { revision: 0, tiles: [], hidden: [] },
      "/chart-settings": { revision: 1, charts: [] },
      "/wayline": { sources: [] },
      "/local-users": { items: [] },
      "/modules": { items: [] },
      "/modules/catalog": { items: [], local_available: false },
      "/preferences": { favorites: [], hidden_sections: [], section_order: [] },
      "/help-state": { disabled: true, seen: [] },
    };
    return route.fulfill({ json: data[path] ?? [] });
  });
  return requests;
}

test("PL operations draft remains protected when navigating to modules", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/#settings");
  await page.getByRole("button", { name: "Эксплуатация", exact: true }).click();
  const lifetime = page.getByRole("spinbutton", { name: /^Срок новой сессии/ });
  await lifetime.fill("15");
  await page
    .getByRole("link", { name: "Установленные модули", exact: true })
    .click();
  const guard = page.getByRole("dialog", {
    name: "Есть несохранённые изменения",
  });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Остаться", exact: true }).click();
  await expect(lifetime).toHaveValue("15");
  await page
    .getByRole("link", { name: "Установленные модули", exact: true })
    .click();
  await guard.getByRole("button", { name: "Отбросить", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Подключённые модули", exact: true }),
  ).toBeVisible();
});

test("unconfigured SFTP does not make requests to the optional service", async ({
  page,
}) => {
  const requests = await fixture(page);
  await page.goto("/sftp-server");
  await expect(
    page.getByText("Файловый сервис не подключён", { exact: true }),
  ).toBeVisible();
  expect(
    requests.filter(
      (path) =>
        path.startsWith("/sftp-server") ||
        path.startsWith("/sftpgo") ||
        /^\/modules\/[^/]+\/sftpgo(?:\/|$)/.test(path),
    ),
  ).toEqual([]);
});

test("PL local admin password prompt and local users survive the shared shell", async ({ page }) => {
  await fixture(page);
  const writes: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
  await page.goto('/');
  await expect(page.getByText('Задайте собственный пароль локального администратора.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Изменить пароль', exact: true }).click();
  const password = page.getByRole('dialog', { name: 'Изменить пароль', exact: true });
  await expect(password.getByLabel('Текущий пароль', { exact: true })).toBeVisible();
  await password.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.goto('/#settings');
  await page.getByRole('button', { name: 'Пользователи', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Локальные пользователи', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Добавить пользователя', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Добавить пользователя', exact: true }).getByRole('textbox', { name: /^Логин/ })).toBeVisible();
  expect(writes).toEqual([]);
});
