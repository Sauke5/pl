import { expect, test, type Page } from "@playwright/test";
import type { Delivery } from "../../src/UpdateSettings";

async function fixture(page: Page, initial?: Partial<Delivery>) {
  let status: Delivery = {
    current_version: "0.3.0",
    latest_version: "0.3.1",
    update_available: true,
    core_api: 1,
    modules: [],
    ...initial,
  };
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (path === "/delivery") return route.fulfill({ json: status });
    if (path.startsWith("/delivery/")) {
      expect(request.headers()["x-csrf-token"]).toBe("delivery-csrf");
      const body = request.postDataJSON();
      writes.push({ path, body });
      if (path.endsWith("/upgrade")) {
        status = {
          ...status,
          operation: {
            operation_id: body.operation_id,
            version: body.version,
            phase: "backing_up",
          },
        };
        return route.abort("connectionreset");
      }
      if (path.endsWith("/recover"))
        status = {
          ...status,
          operation: { ...status.operation!, phase: "rolled_back" },
        };
      return route.fulfill({ json: status });
    }
    const responses: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "local-admin", name: "Admin", admin: true },
        csrf_token: "delivery-csrf",
      },
      "/settings": {
        revision: 1,
        timezone: "UTC",
        stale_after_seconds: 180,
        session_lifetime_minutes: 480,
        local_password_min_length: 12,
      },
      "/runtime": { session_lifetime_minutes: 480 },
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
    };
    return route.fulfill({ json: responses[path] ?? [] });
  });
  return { writes, status: () => status };
}

test("update notification opens settings and lost acceptance response reconciles without resending", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/#settings?section=general");
  await page.getByRole("button", { name: "PL 0.3.1", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Версия и обновления PL", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Обновить до 0.3.1", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Обновление PL до 0.3.1" });
  await expect(dialog).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await dialog
    .getByRole("button", { name: "Установить обновление", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Создаём резервную копию", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Платформа обновляется", exact: true }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].body).toEqual({
    version: "0.3.1",
    operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
});

test("interrupted upgrade recovers only its recorded operation", async ({
  page,
}) => {
  const operation_id = "727b18f8-99da-410f-b94f-e677f2967731";
  const state = await fixture(page, {
    operation: { operation_id, version: "0.3.1", phase: "recovery_required" },
  });
  await page.goto("/#settings?section=updates");
  await expect(
    page.getByText("Требуется восстановление установки", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Обновить до 0.3.1", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", {
      name: "Восстановить предыдущую версию",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Предыдущая версия восстановлена", { exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([
    { path: "/delivery/recover", body: { operation_id } },
  ]);
});

test("release story shows benefits before confirmation and renders content as text", async ({
  page,
}) => {
  const state = await fixture(page, {
    release_notes: {
      version: "0.3.1",
      title: "Теперь видно, ради чего обновляться",
      summary: "Главные изменения собраны рядом с кнопкой установки.",
      sections: [
        {
          kind: "new",
          items: [
            {
              title: "Описание перед установкой",
              description: "Прочитайте главное до перезапуска платформы.",
            },
          ],
        },
        {
          kind: "improved",
          items: [
            {
              title: "Описание под рукой",
              description: "Вернуться к нему можно в настройках.",
            },
          ],
        },
        {
          kind: "fixed",
          items: [
            {
              title: "Переход к новому адресу",
              description: "<b>Адрес остаётся доступен</b> как обычный текст.",
            },
          ],
        },
      ],
    },
  });
  await page.goto("/#settings?section=general");
  const notice = page.getByRole("button", { name: "PL 0.3.1", exact: true });
  await expect(notice).toContainText("Теперь видно, ради чего обновляться");
  await notice.click();
  const release = page.getByRole("article", {
    name: "Что нового в PL 0.3.1",
    exact: true,
  });
  await expect(
    release.getByRole("heading", { name: "Новое", exact: true }),
  ).toBeVisible();
  await expect(
    release.getByRole("heading", { name: "Стало удобнее", exact: true }),
  ).toBeVisible();
  await expect(
    release.getByRole("heading", { name: "Исправлено", exact: true }),
  ).toBeVisible();
  await expect(
    release.getByText("<b>Адрес остаётся доступен</b> как обычный текст.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(release.locator("b")).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(
    release.getByText("Переход к новому адресу", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Обновить до 0.3.1", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Обновление PL до 0.3.1" }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(0);
});

test("release notes for another version are not offered for this update", async ({
  page,
}) => {
  await fixture(page, {
    release_notes: {
      version: "9.0.0",
      title: "Другая версия",
      summary: "Чужое описание",
      sections: [],
    },
  });
  await page.goto("/#settings?section=updates");
  await expect(page.getByText("Другая версия", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Подробное описание этого релиза ещё не опубликовано.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Обновить до 0.3.1", exact: true }),
  ).toBeEnabled();
});
