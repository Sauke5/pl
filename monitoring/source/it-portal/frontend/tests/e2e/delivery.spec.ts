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
    page.getByText("Резервная копия установки", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Обновить до 0.3.1", exact: true }),
  ).toBeDisabled();
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
  await page.goto("/#settings?section=operations");
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
