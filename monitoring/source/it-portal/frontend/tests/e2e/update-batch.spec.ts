import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { Delivery } from "../../src/UpdateSettings";
const key = "pl.update-batch.v1";
async function fixture(context: BrowserContext, core = true) {
  let lost = false,
    down = false,
    outageAfterCore = false,
    outages = 0;
  const writes: { path: string; body: Record<string, string> }[] = [];
  const status: Delivery = {
    current_version: "0.6.2",
    latest_version: "0.7.0",
    update_available: core,
    core_api: 1,
    modules: [
      {
        module_id: "netmap",
        version: "1.1.0",
        installed_version: "1.0.0",
        installed: true,
        update_available: true,
        upgrade_supported: !core,
        artifact_sha256: "a".repeat(64),
        blocked_reason: core ? "Обновите PL" : "",
      },
      {
        module_id: "forms",
        version: "3.0.5",
        installed_version: "3.0.4",
        installed: true,
        update_available: true,
        upgrade_supported: false,
        artifact_sha256: "b".repeat(64),
        blocked_reason: "Нужна отдельная миграция Forms",
      },
    ],
  };
  await context.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/stream")
      return route.fulfill({
        contentType: "text/event-stream",
        body: ": fixture\n\n",
      });
    if (path === "/delivery") {
      if (down) {
        const mode = outages++ % 4;
        return mode === 0
          ? route.abort("connectionreset")
          : route.fulfill({
              status: [0, 502, 503, 504][mode],
              json: { message: "Core restarts" },
            });
      }
      return route.fulfill({ json: status });
    }
    if (path === "/upgrade-status")
      return route.fulfill({
        json: {
          active:
            !!status.operation &&
            !["complete", "failed", "rolled_back"].includes(
              status.operation.phase,
            ),
          ready: status.operation?.phase === "complete",
          current_version: status.current_version,
          operation: status.operation,
        },
      });
    if (path === "/delivery/upgrade" || path === "/delivery/module-upgrade") {
      expect(route.request().headers()["x-csrf-token"]).toBe("batch-csrf");
      const body = route.request().postDataJSON();
      writes.push({ path, body });
      status.operation = {
        operation_id: body.operation_id,
        kind: body.module_id ? "module_upgrade" : "upgrade",
        scope: body.module_id ? "module" : undefined,
        module_id: body.module_id,
        version: body.version || status.current_version,
        phase: "snapshot",
      };
      if (outageAfterCore && !body.module_id) {
        down = true;
        lost = true;
      }
      return lost
        ? route.abort("connectionreset")
        : route.fulfill({ json: status });
    }
    const data: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "batch-admin", name: "Admin", admin: true },
        csrf_token: "batch-csrf",
        demo: false,
      },
      "/settings": {
        revision: 1,
        timezone: "UTC",
        stale_after_seconds: 180,
        session_lifetime_minutes: 480,
        local_password_min_length: 12,
      },
      "/runtime": {},
      "/dashboard-layout": { revision: 1, tiles: [], hidden: [] },
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
    return route.fulfill({ json: data[path] ?? [] });
  });
  return {
    status,
    writes,
    lose: () => {
      lost = true;
    },
    outageAfterCore: () => {
      outageAfterCore = true;
    },
    outages: () => outages,
    available: () => {
      down = false;
      lost = false;
    },
    finish: () => {
      status.operation!.phase = "complete";
      if (status.operation!.kind === "upgrade") {
        status.current_version = "0.7.0";
        status.update_available = false;
        status.modules[0].upgrade_supported = true;
        status.modules[0].blocked_reason = "";
      } else {
        const m = status.modules.find(
          (m) => m.module_id === status.operation!.module_id,
        )!;
        m.installed_version = m.version;
        m.update_available = false;
      }
    },
  };
}
async function begin(page: Page) {
  await page.goto("/#settings?section=updates");
  await page.getByRole("button", { name: "Обновить всё", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Обновить Платформу и модули" })
    .getByRole("button", { name: "Запустить обновления" })
    .click();
}
async function stored(page: Page) {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) || "null"),
    key,
  );
}
function notifications(page: Page) {
  return page.getByRole("region", { name: "Уведомления о действиях" });
}

test("core first survives reload, unlocks initially blocked module and clearly skips unsupported", async ({
  context,
  page,
}) => {
  const f = await fixture(context);
  await begin(page);
  await expect.poll(() => f.writes.length).toBe(1);
  const plan = await stored(page);
  expect(f.writes[0].path).toBe("/delivery/upgrade");
  await page.reload();
  f.finish();
  await expect.poll(() => f.writes.length).toBe(2);
  expect(f.writes[1]).toEqual({
    path: "/delivery/module-upgrade",
    body: {
      operation_id: plan.steps[1].operation_id,
      module_id: "netmap",
      artifact_sha256: "a".repeat(64),
    },
  });
  const toasts = notifications(page);
  await expect(toasts.getByRole("status")).toContainText(
    "Обновляем NetMap 1.1.0",
  );
  await expect(toasts.getByRole("status")).toContainText(
    "Шаг 2 из 3 · Создаём резервную копию",
  );
  f.status.operation!.phase = "verifying";
  await expect(toasts.getByRole("status")).toContainText(
    "Шаг 2 из 3 · Проверяем готовность",
  );
  await expect(toasts.getByRole("listitem")).toHaveCount(1);
  await expect(
    page.getByRole("region", { name: "Очередь обновлений" }),
  ).toHaveCount(0);
  await toasts.getByRole("button", { name: "Закрыть уведомление" }).click();
  await page.mouse.move(20, 300);
  await expect(toasts.getByRole("listitem")).toHaveCount(0);
  f.finish();
  await expect(toasts.getByRole("status")).toContainText(
    "Обновление завершено",
  );
  await expect(toasts.getByRole("status")).toContainText(
    "Пропущено: Forms 3.0.5. Нужна отдельная миграция Forms",
  );
  await expect(
    page.getByRole("button", { name: "Проверить обновления", exact: true }),
  ).toBeEnabled();
  expect(f.writes).toHaveLength(2);
  await expect.poll(() => stored(page)).toBeNull();
  await expect(toasts.getByRole("listitem")).toHaveCount(0);
});

test("lost accepted POST is reconciled with the stored UUID without a second POST", async ({
  context,
  page,
}) => {
  const f = await fixture(context, false);
  f.lose();
  await begin(page);
  await expect.poll(() => f.writes.length).toBe(1);
  const plan = await stored(page);
  expect(f.writes[0].body.operation_id).toBe(plan.steps[0].operation_id);
  await page.reload();
  f.finish();
  await expect(
    notifications(page).getByText("Обновление завершено", { exact: true }),
  ).toBeVisible();
  expect(f.writes).toHaveLength(1);
});

test("two tabs share one queue and one POST; terminal failure stops remaining modules", async ({
  context,
  page,
}) => {
  const f = await fixture(context, false);
  await begin(page);
  const other = await context.newPage();
  await other.goto("/#settings?section=updates");
  await expect.poll(() => f.writes.length).toBe(1);
  f.status.operation!.phase = "failed";
  f.status.operation!.error = "Fixture failed safely";
  await expect(
    notifications(page).getByText("Обновление остановлено", { exact: true }),
  ).toBeVisible();
  await expect(
    notifications(other).getByText("Обновление остановлено", { exact: true }),
  ).toBeVisible();
  expect((await stored(page)).error).toContain("Fixture failed safely");
  await expect(
    page.getByRole("button", { name: "Проверить обновления", exact: true }),
  ).toBeEnabled();
  expect(f.writes).toHaveLength(1);
});

test("catalog hash change and a foreign operation never launch a queued step", async ({
  context,
  page,
}) => {
  const f = await fixture(context);
  await begin(page);
  await expect.poll(() => f.writes.length).toBe(1);
  f.finish();
  f.status.modules[0].artifact_sha256 = "c".repeat(64);
  await expect(
    notifications(page).getByText("Обновление остановлено", { exact: true }),
  ).toBeVisible();
  expect(f.writes).toHaveLength(1);
});

test("foreign terminal operation pauses a persisted pending plan", async ({
  context,
  page,
}) => {
  const f = await fixture(context, false);
  await page.goto("/#settings?section=updates");
  await page.evaluate(
    (key) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          schema: 1,
          id: crypto.randomUUID(),
          actor: "batch-admin",
          origin: location.origin,
          created: Date.now(),
          steps: [
            {
              operation_id: crypto.randomUUID(),
              version: "1.1.0",
              module_id: "netmap",
              artifact_sha256: "a".repeat(64),
              state: "pending",
            },
          ],
        }),
      ),
    key,
  );
  f.status.operation = {
    operation_id: "f0b45baf-6875-41ee-a8f9-f156ce8b418a",
    kind: "module_upgrade",
    module_id: "forms",
    version: "0.6.2",
    phase: "complete",
  };
  await page.reload();
  await expect(
    notifications(page).getByText("Обновление остановлено", { exact: true }),
  ).toBeVisible();
  expect(f.writes).toHaveLength(0);
});

test("temporary API outage after lost accepted core POST waits for reconciliation without resending", async ({
  context,
  page,
}) => {
  const f = await fixture(context);
  f.outageAfterCore();
  await begin(page);
  await expect.poll(() => f.outages()).toBeGreaterThanOrEqual(4);
  const plan = await stored(page);
  expect(plan.error).toBeUndefined();
  expect(plan.steps[0].state).toBe("sent");
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].body.operation_id).toBe(plan.steps[0].operation_id);
  f.available();
  f.finish();
  await expect.poll(() => f.writes.length).toBe(2);
  expect(f.writes[1].body).toEqual({
    operation_id: plan.steps[1].operation_id,
    module_id: "netmap",
    artifact_sha256: "a".repeat(64),
  });
  f.finish();
  await expect(
    notifications(page).getByText("Обновление завершено", { exact: true }),
  ).toBeVisible();
  expect(f.writes).toHaveLength(2);
});

test("a completed queue left by an older version is cleared on launch", async ({
  context,
  page,
}) => {
  const f = await fixture(context, false);
  await page.goto("/");
  await page.evaluate((key) => {
    localStorage.setItem(
      key,
      JSON.stringify({
        schema: 1,
        id: crypto.randomUUID(),
        actor: "batch-admin",
        origin: location.origin,
        created: Date.now(),
        steps: [
          {
            operation_id: crypto.randomUUID(),
            version: "1.1.0",
            module_id: "netmap",
            artifact_sha256: "a".repeat(64),
            state: "done",
          },
        ],
      }),
    );
  }, key);
  await page.reload();
  await expect(notifications(page).getByRole("status")).toContainText(
    "Установлено: NetMap 1.1.0.",
  );
  await expect.poll(() => stored(page)).toBeNull();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Моё рабочее пространство" }),
  ).toBeVisible();
  await expect(notifications(page).getByRole("listitem")).toHaveCount(0);
  expect(f.writes).toHaveLength(0);
});
