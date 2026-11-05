import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Existing work-flow tests model a returning user who disabled automatic help.
// The dedicated onboarding suite covers first visits and real persistence.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/help-state", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { disabled: true, seen: [] } })
      : route.continue(),
  );
});

async function login(page: Page, role = "admin") {
  await page.route("**/api/v1/help-state", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { disabled: true, seen: [] } })
      : route.continue(),
  );
  const session = await (await page.request.get("/api/v1/session")).json();
  expect(session.demo).toBe(true);
  await expect(
    await page.request.post("/auth/demo", { data: { role } }),
  ).toBeOK();
  await page.goto("/");
  if (role === "admin")
    await expect(
      page.getByRole("heading", {
        name: "Моё рабочее пространство",
        exact: true,
      }),
    ).toBeVisible();
}
async function write(
  request: APIRequestContext,
  path: string,
  data: unknown,
  method = "POST",
) {
  const session = await (await request.get("/api/v1/session")).json();
  return request.fetch(`/api/v1${path}`, {
    method,
    data,
    headers: { "X-CSRF-Token": session.csrf_token },
  });
}
async function resource(page: Page, name: string) {
  const response = await write(page.request, "/resources", {
    name,
    url: `https://${randomUUID()}.example.invalid`,
    aliases: ["проверка поиска"],
    hostname: "e2e-host.example.invalid",
    ip: "192.0.2.200",
    directions: ["Мониторинг"],
    site: "E2E",
    environment: "Lab",
    tags: ["приёмка"],
  });
  await expect(response).toBeOK();
  return response.json();
}

test("demo login and catalog are real API data", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Войти как IT-специалист", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Моё рабочее пространство" }),
  ).toBeVisible();
  const resources = await (await page.request.get("/api/v1/resources")).json();
  expect(resources.length).toBeGreaterThanOrEqual(100);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Каталог", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Grafana", exact: true }),
  ).toBeVisible();
});

test("add through UI, find by multiple fields, visible in another session, edit and archive", async ({
  page,
  browser,
}) => {
  await login(page);
  const name = `E2E ресурс ${randomUUID().slice(0, 8)}`;
  await page
    .getByRole("button", { name: "Добавить ресурс", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Название/).fill(name);
  await dialog
    .getByLabel(/^Основной адрес/)
    .fill("https://e2e-shared.example.invalid");
  await dialog
    .getByLabel("Hostname", { exact: true })
    .fill("e2e-shared.example.invalid");
  await dialog.getByLabel("IP", { exact: true }).fill("192.0.2.199");
  await dialog
    .getByLabel("Альтернативные названия", { exact: true })
    .fill("общая карточка");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Каталог", exact: true })
    .click();
  for (const q of [
    name,
    "общая карточка",
    "e2e-shared.example.invalid",
    "192.0.2.199",
  ]) {
    await page.getByLabel("Поиск в каталоге", { exact: true }).fill(q);
    await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  }
  const second = await browser.newContext({
    baseURL: process.env.PORTAL_E2E_URL || "http://localhost:8099",
  });
  const other = await second.newPage();
  await login(other);
  await other.goto("/#catalog?q=" + encodeURIComponent(name));
  await expect(other.getByRole("link", { name, exact: true })).toBeVisible();
  await second.close();
  await page
    .getByRole("button", { name: `Подробнее: ${name}`, exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Редактировать", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Описание", { exact: true })
    .fill("Общее описание после редактирования");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.reload();
  await expect(
    page.getByText("Общее описание после редактирования", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `Подробнее: ${name}`, exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "В архив", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Архивировать", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
});

test("command palette keyboard, Escape and focus restoration", async ({
  page,
}) => {
  await login(page);
  const search = page.getByRole("button", {
    name: /Название, IP, hostname или команда/,
  });
  await search.focus();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").fill("графана");
  await expect(dialog.getByText("Grafana", { exact: true })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(search).toBeFocused();
  await page.keyboard.press("Meta+k");
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("preferences survive reload and remain personal", async ({ page }) => {
  await login(page);
  await page
    .getByRole("button", { name: "Свернуть меню", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Развернуть меню", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Развернуть меню", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Развернуть меню", exact: true })
    .click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Каталог", exact: true })
    .click();
  await page.getByLabel("Поиск в каталоге", { exact: true }).fill("Grafana");
  await page
    .getByRole("button", { name: "Открепить Grafana", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Закрепить Grafana", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Закрепить Grafana", exact: true })
    .click();
});

test("board projection and forbidden direct admin requests", async ({
  page,
  browser,
}) => {
  await login(page);
  const r = await resource(page, `Board ${randomUUID()}`);
  const settings = await (await page.request.get("/api/v1/settings")).json();
  await expect(
    await write(
      page.request,
      "/settings",
      {
        ...settings,
        board_enabled: true,
        board_anonymous: false,
        board_title: "E2E board",
        board_resource_ids: [r.id],
      },
      "PUT",
    ),
  ).toBeOK();
  const ctx = await browser.newContext({
    baseURL: process.env.PORTAL_E2E_URL || "http://localhost:8099",
  });
  const viewer = await ctx.newPage();
  await login(viewer, "viewer");
  await expect(
    viewer.getByRole("heading", { name: "E2E board" }),
  ).toBeVisible();
  const payload = await (await viewer.request.get("/api/v1/board")).json();
  expect(payload.items).toHaveLength(1);
  expect(Object.keys(payload.items[0]).sort()).toEqual([
    "description",
    "id",
    "name",
    "status",
  ]);
  expect(JSON.stringify(payload)).not.toContain("example.invalid");
  for (const path of [
    "resources",
    "jobs",
    "integrations",
    "settings",
    "export",
    "audit",
  ])
    expect((await viewer.request.get(`/api/v1/${path}`)).status()).toBe(403);
  expect(
    (
      await write(viewer.request, "/resources", {
        name: "Denied",
        url: "https://denied.example.invalid",
      })
    ).status(),
  ).toBe(403);
  await ctx.close();
  const latest = await (await page.request.get("/api/v1/settings")).json();
  await expect(
    await write(
      page.request,
      "/settings",
      { ...settings, revision: latest.revision },
      "PUT",
    ),
  ).toBeOK();
});

test("SSE reconnect resynchronizes data created in a separate session", async ({
  page,
  browser,
}) => {
  await login(page);
  const name = `Reconnect ${randomUUID()}`;
  await page.goto("/#catalog?q=" + encodeURIComponent(name));
  await expect(
    page.getByText("Ничего не найдено", { exact: true }),
  ).toBeVisible();
  await page.context().setOffline(true);
  const ctx = await browser.newContext({
    baseURL: process.env.PORTAL_E2E_URL || "http://localhost:8099",
  });
  const writer = await ctx.newPage();
  await login(writer);
  await resource(writer, name);
  await page.context().setOffline(false);
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible({
    timeout: 20000,
  });
  await ctx.close();
});

test("denied network check is durable after reload and retries deduplicate", async ({
  page,
}) => {
  await login(page);
  const target = `http://127.0.0.1:1/${randomUUID()}`;
  const data = {
    kind: "check",
    parameters: { kind: "http", target },
    idempotency_key: randomUUID(),
  };
  const first = await (await write(page.request, "/jobs", data)).json();
  const repeat = await (await write(page.request, "/jobs", data)).json();
  expect(repeat.id).toBe(first.id);
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/v1/jobs/${first.id}`)).json())
          .status,
    )
    .toBe("failed");
  await page.goto("/#tools");
  await expect(
    page.getByRole("cell", { name: target, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("cell", { name: target, exact: true }),
  ).toBeVisible();
});

test("local administrator signs in without Keycloak", async ({ page }) => {
  const text = readFileSync(resolve("../credentials/LOCAL-ADMIN.txt"), "utf8");
  const username = text.match(
    /(?:Username|Имя пользователя|Логин|username)\s*:\s*(\S+)/,
  )?.[1];
  const password = text.match(/(?:Password|Пароль|password)\s*:\s*(\S+)/)?.[1];
  expect(Boolean(username && password)).toBe(true);
  await page.goto("/");
  await page
    .getByText("Вход локального администратора", { exact: true })
    .click();
  await page.getByLabel("Логин", { exact: true }).fill(username!);
  await page.getByLabel("Пароль", { exact: true }).fill(password!);
  await page
    .getByRole("button", { name: "Войти локально", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Настройки", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await expect(page.getByRole("button", { name: /board/i })).toBeVisible();
  const original = await (await page.request.get("/api/v1/settings")).json();
  await page
    .getByRole("button", { name: "Доступ и board", exact: true })
    .click();
  await page.getByLabel("Включить ограниченный board", { exact: true }).check();
  await page
    .getByLabel("Заголовок board", { exact: true })
    .fill("Локальная настройка board");
  await page
    .getByRole("button", { name: "Сохранить настройки", exact: true })
    .click();
  await expect(page.getByText("Сохранено", { exact: true })).toBeVisible();
  const updated = await (await page.request.get("/api/v1/settings")).json();
  expect(updated.board_title).toBe("Локальная настройка board");
  expect(updated.board_enabled).toBe(true);
  await expect(
    await write(
      page.request,
      "/settings",
      { ...original, revision: updated.revision },
      "PUT",
    ),
  ).toBeOK();
});

test("import requires preview and persists the confirmed shared resource", async ({
  page,
}) => {
  await login(page);
  const name = `Импорт ${randomUUID().slice(0, 8)}`;
  await page.goto("/#catalog");
  await page.getByRole("button", { name: "Импорт", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Содержимое импорта", { exact: true }).fill(
    JSON.stringify({
      schema_version: 1,
      resources: [{ name, url: `https://${randomUUID()}.example.invalid` }],
      collections: [],
    }),
  );
  await dialog
    .getByRole("button", { name: "Проверить файл", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", {
      name: "Предварительный просмотр",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    (
      await (
        await page.request.get(
          "/api/v1/resources?q=" + encodeURIComponent(name),
        )
      ).json()
    ).length,
  ).toBe(0);
  await dialog.getByRole("button", { name: /Применить 1 изменений/ }).click();
  await expect(dialog).toBeHidden();
  await page.getByLabel("Поиск в каталоге", { exact: true }).fill(name);
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
});

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 1100, height: 800 },
  { width: 760, height: 900 },
]) {
  test(`layout ${viewport.width}×${viewport.height}, key content and no horizontal overflow`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await login(page);
    await expect(
      page.getByRole("heading", { name: "Моё рабочее пространство" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Состояние интеграций" }),
    ).toBeAttached();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    const output = resolve("../output/playwright");
    mkdirSync(output, { recursive: true });
    await page.screenshot({
      path: `${output}/home-${viewport.width}.png`,
      fullPage: true,
    });
  });
}

test("problem hiding persists, is shared across sessions, and can be restored", async ({
  page,
  browser,
}) => {
  await login(page);
  const problems = await (
    await page.request.get("/api/v1/workspace-problems")
  ).json();
  const target = problems.find(
    (p: any) =>
      p.status === "firing" &&
      !p.marketing &&
      !p.hidden &&
      p.labels?.portal_silenced !== "true" &&
      p.labels?.portal_inhibited !== "true",
  );
  expect(target).toBeTruthy();
  const context = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  try {
    await page.goto("/#problems");
    await page
      .locator(".workspace-problem-row")
      .filter({ hasText: target.title })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", {
        name: "Скрыть из требующих внимания",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("dialog").getByRole("button", {
        name: "Вернуть в требующие внимания",
        exact: true,
      }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(
      page.locator(".workspace-problem-row").filter({ hasText: target.title }),
    ).toHaveCount(0);
    const other = await context.newPage();
    await login(other);
    const shared = await (await other.request.get("/api/v1/problems")).json();
    expect(shared.find((p: any) => p.id === target.id)).toMatchObject({
      hidden: true,
      status: "firing",
    });
    await other.goto("/#problems");
    await expect(
      other.locator(".workspace-problem-row").filter({ hasText: target.title }),
    ).toHaveCount(0);
    await other
      .getByRole("button", { name: /^Скрытые и приглушённые/ })
      .click();
    await other
      .locator(".workspace-problem-row")
      .filter({ hasText: target.title })
      .click();
    await other
      .getByRole("dialog")
      .getByRole("button", {
        name: "Вернуть в требующие внимания",
        exact: true,
      })
      .click();
    await expect(
      other.getByRole("dialog").getByRole("button", {
        name: "Скрыть из требующих внимания",
        exact: true,
      }),
    ).toBeVisible();
    await other.keyboard.press("Escape");
    await other.locator(".workspace-problem-trigger button").first().click();
    await other.getByRole("button", { name: /^Требуют внимания/ }).click();
    await expect(
      other.locator(".workspace-problem-row").filter({ hasText: target.title }),
    ).toBeVisible();
    const restored = await (await other.request.get("/api/v1/problems")).json();
    expect(restored.find((p: any) => p.id === target.id)).toMatchObject({
      hidden: false,
      status: "firing",
    });
  } finally {
    await write(
      page.request,
      `/problems/${target.id}/visibility`,
      { hidden: false, expected_started_at: target.started_at },
      "PUT",
    );
    await context.close();
  }
});

test("Alertmanager silences are separated from attention without reporting recovery", async ({
  page,
}) => {
  await login(page);
  const problems = await (await page.request.get("/api/v1/problems")).json();
  const sample = problems.find((p: any) => p.status === "firing");
  expect(sample).toBeTruthy();
  const silenced = {
    ...sample,
    id: "e2e-silenced-alert",
    title: "E2E заглушенная проблема",
    hidden: false,
    labels: {
      ...sample.labels,
      portal_silenced: "true",
      portal_alert_state: "suppressed",
    },
  };
  await page.route("**/api/v1/workspace-problems", (route) =>
    route.fulfill({ json: [{ ...silenced, marketing: false }] }),
  );
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Моё рабочее пространство",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.locator(".workspace-problem-row").filter({ hasText: silenced.title }),
  ).toHaveCount(0);
  await page.goto("/#problems");
  await expect(page.locator(".workspace-problem-row")).toHaveCount(0);
  await page.getByRole("button", { name: /^Скрытые и приглушённые/ }).click();
  await page
    .locator(".workspace-problem-row")
    .filter({ hasText: silenced.title })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByText("Приглушена источником", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText("Восстановлено", { exact: true }),
  ).toHaveCount(0);
});

test("private board is absent from login page and is not requested", async ({
  page,
  browser,
}) => {
  await login(page);
  const original = await (await page.request.get("/api/v1/settings")).json();
  await expect(
    await write(
      page.request,
      "/settings",
      { ...original, board_enabled: true, board_anonymous: false },
      "PUT",
    ),
  ).toBeOK();
  const context = await browser.newContext({
    baseURL: process.env.PORTAL_E2E_URL || "http://localhost:8099",
  });
  try {
    const guest = await context.newPage();
    const boardRequests: string[] = [];
    guest.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/v1/board")
        boardRequests.push(request.url());
    });
    await guest.goto("/");
    await expect(
      guest.getByRole("button", {
        name: "Войти как IT-специалист",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      guest.getByText("Информационный board", { exact: true }),
    ).toHaveCount(0);
    await expect(
      guest.getByText("Войдите для просмотра board", { exact: true }),
    ).toHaveCount(0);
    expect(boardRequests).toHaveLength(0);
    await expect(
      await write(
        page.request,
        "/settings",
        {
          ...(await (await page.request.get("/api/v1/settings")).json()),
          board_anonymous: true,
        },
        "PUT",
      ),
    ).toBeOK();
    await guest.reload();
    await expect(guest.locator(".board-shell")).toBeVisible();
    expect(boardRequests.length).toBeGreaterThan(0);
  } finally {
    const latest = await (await page.request.get("/api/v1/settings")).json();
    await write(
      page.request,
      "/settings",
      { ...original, revision: latest.revision },
      "PUT",
    );
    await context.close();
  }
});

test("home section order is saved through UI and rendered after reload", async ({
  page,
}) => {
  await login(page);
  const original = await (await page.request.get("/api/v1/preferences")).json();
  try {
    await page
      .getByRole("button", { name: "Настроить главную", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    const row = dialog.locator('[data-section-order="directions"]');
    while (!(await row.getByRole("button", { name: /^Выше:/ }).isDisabled())) {
      await row.getByRole("button", { name: /^Выше:/ }).click();
    }
    await dialog
      .getByRole("button", { name: "Сохранить", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("[data-home-section]").first()).toHaveAttribute(
      "data-home-section",
      "directions",
    );
    await page.reload();
    await expect(page.locator("[data-home-section]").first()).toHaveAttribute(
      "data-home-section",
      "directions",
    );
    const saved = await (await page.request.get("/api/v1/preferences")).json();
    expect(saved.section_order[0]).toBe("directions");
    expect(saved.section_order).toContain("grafana");
    expect(saved.section_order).toContain("wayline");
  } finally {
    const current = await (
      await page.request.get("/api/v1/preferences")
    ).json();
    await expect(
      await write(
        page.request,
        "/preferences",
        { ...original, revision: current.revision },
        "PUT",
      ),
    ).toBeOK();
  }
});

test("attention badge opens problems and can navigate to the full page", async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole("button", {
      name: "Открыть проблемы, требующие внимания",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Требуют внимания", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Все проблемы", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/#problems/);
});
