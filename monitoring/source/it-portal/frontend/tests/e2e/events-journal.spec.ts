import { test, expect, type Page } from "@playwright/test";

// UI contract fixtures only: backend transition ingestion and ACL are verified separately.
const now = new Date("2026-10-23T09:00:00Z");
function item(index: number, unread = false) {
  return {
    id: `event-${index}`,
    kind: "target.down",
    event_type: "problem",
    title: `Ошибка сбора метрик ${index}`,
    source: "prometheus",
    source_name: "Prometheus",
    resource_id: "test-resource",
    resource_name: "Проверочный сервер",
    severity: "warning",
    occurred_at: new Date(+now - index * 60000).toISOString(),
    received_at: now.toISOString(),
    created_at: now.toISOString(),
    time_basis: "observed",
    unread,
    actor: index === 1 ? "system" : "ad:unresolved-test-actor",
    actor_name:
      index === 0 ? "Мария Петрова" : index <= 2 ? "" : "Елена Смирнова",
    source_stale: false,
    details: {
      description: "Ошибка сбора не доказывает недоступность сервера.",
    },
  };
}
async function mockJournal(
  page: Page,
  options: {
    fail?: boolean;
    paginated?: boolean;
    auditResponse?: Promise<void>;
  } = {},
) {
  const state = {
    pending: 0,
    accepted: false,
    requests: [] as URL[],
    acks: [] as string[],
    initialized: false,
    failed: options.fail,
  };
  const items = Array.from({ length: 30 }, (_, index) =>
    item(index, index === 0),
  );
  const auditItems = items.map((event, index) => ({
    ...event,
    id: `audit-${event.id}`,
    title: `Изменение ресурса ${index}`,
  }));
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api/v1", "");
    if (path === "/event-journal/view") {
      const body = route.request().postDataJSON();
      if (body.initialize) state.initialized = true;
      if (body.ids) state.acks.push(...body.ids);
      return route.fulfill({ json: { initialized: true } });
    }
    if (path === "/event-journal") {
      state.requests.push(url);
      const audit = url.searchParams.get("channel") === "audit";
      const journalItems = audit ? auditItems : items;
      if (audit) await options.auditResponse;
      if (!state.initialized)
        return route.fulfill({
          status: 409,
          json: { message: "Initialize first" },
        });
      if (state.failed) {
        state.failed = false;
        return route.fulfill({
          status: 503,
          json: { message: "Источник временно недоступен" },
        });
      }
      if (options.paginated) {
        const offset = Number(url.searchParams.get("cursor") || 0);
        return route.fulfill({
          json: {
            items: journalItems.slice(offset, offset + 10),
            snapshot: "old",
            next_cursor:
              offset + 10 < journalItems.length ? String(offset + 10) : "",
            total: journalItems.length,
            new_count: 0,
          },
        });
      }
      if (url.searchParams.get("snapshot"))
        return route.fulfill({
          json: {
            items: journalItems,
            snapshot: "old",
            next_cursor: "",
            total: journalItems.length,
            new_count: state.pending,
          },
        });
      if (state.pending) {
        state.accepted = true;
        state.pending = 0;
      }
      const added = item(-1, true);
      if (audit) added.id = `audit-${added.id}`;
      const all = state.accepted ? [added, ...journalItems] : journalItems;
      return route.fulfill({
        json: {
          items: all,
          snapshot: state.accepted ? "new" : "old",
          next_cursor: "",
          total: all.length,
          new_count: 0,
        },
      });
    }
    if (path.startsWith("/event-journal/")) {
      const id = path.split("/").at(-1)!;
      const event =
        [...items, ...auditItems].find((event) => event.id === id) ||
        item(-1, true);
      return route.fulfill({
        json: {
          event,
          related: [item(4)],
          observation: {
            first_seen: now.toISOString(),
            last_confirmed_at: now.toISOString(),
            confirmations: 12,
          },
        },
      });
    }
    const data: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "test-admin", name: "Администратор", admin: true },
        csrf_token: "test",
        timezone: "Europe/Moscow",
      },
      "/time": { server_time: now.toISOString() },
      "/preferences": {
        favorites: [],
        hidden_sections: [],
        section_order: [],
        home_widgets: [],
      },
      "/help-state": { disabled: true, seen: [] },
      "/chart-settings": { revision: 1, charts: [] },
      "/resources": [
        {
          id: "test-resource",
          name: "Проверочный сервер",
          type: "Linux",
          lifecycle: "active",
          operations: [],
          directions: [],
          tags: [],
          endpoints: [],
          check: {},
        },
      ],
    };
    return route.fulfill({ json: data[path] ?? [] });
  });
  return state;
}

test("collection transitions are opt-in and the selected filter reaches the API", async ({
  page,
}) => {
  const state = await mockJournal(page);
  await page.goto("/#events");
  await expect
    .poll(() => state.requests.at(-1)?.searchParams.get("exclude_collection"))
    .toBe("true");
  const toggle = page.getByRole("checkbox", {
    name: /Показывать переключения сбора метрик/,
  });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect
    .poll(() => state.requests.at(-1)?.searchParams.has("exclude_collection"))
    .toBe(false);
  await toggle.uncheck();
  await expect
    .poll(() => state.requests.at(-1)?.searchParams.get("exclude_collection"))
    .toBe("true");
  await page.getByRole("button", { name: "Аудит", exact: true }).click();
  await expect
    .poll(() => state.requests.at(-1)?.searchParams.get("channel"))
    .toBe("audit");
  expect(state.requests.at(-1)?.searchParams.has("exclude_collection")).toBe(
    false,
  );
});

test("audit describes personal settings and never invents related events", async ({
  page,
}) => {
  await mockJournal(page);
  const event = {
    ...item(0),
    id: "audit-settings",
    source: "platform",
    source_name: "Платформа",
    time_basis: "source",
    event_type: "change",
    severity: "info",
    kind: "preferences.saved",
    title: "Изменена запись",
    resource_id: "private-user-id",
    resource_name: "",
    object_kind: "preferences",
    object_name: "Личные настройки",
    action: "saved",
    actor_name: "Кирилл Царев",
    details: { kind: "preferences", revision: 4 },
    unread: false,
  };
  const specific = {
    ...event,
    id: "audit-layout",
    title: "Изменён порядок блоков главной",
  };
  await page.route("**/api/v1/event-journal?**", (route) =>
    route.fulfill({
      json: {
        items: [event, specific],
        snapshot: "snapshot",
        next_cursor: "",
        total: 2,
        new_count: 0,
      },
    }),
  );
  await page.route("**/api/v1/event-journal/audit-settings?**", (route) =>
    route.fulfill({
      json: { event, related: [item(4)] },
    }),
  );
  await page.goto("/#events");
  await page.getByRole("button", { name: "Аудит", exact: true }).click();
  await expect(
    page.getByText("Действия пользователей Платформы"),
  ).toBeVisible();
  await expect(page.getByLabel("Источник", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Тип события").locator("option")).toHaveText([
    "Все типы",
    "Действия и изменения",
    "Операции",
  ]);
  const row = page.locator('[data-event-id="audit-settings"]');
  await expect(row).toContainText("Обновлены личные настройки");
  await expect(row).toContainText("Личные настройки");
  await expect(row).toContainText("Кирилл Царев");
  await expect(page.locator('[data-event-id="audit-layout"]')).toContainText(
    "Изменён порядок блоков главной",
  );
  await expect(row).not.toContainText("private-user-id");
  await row.click();
  const detail = page.getByLabel("Детали события");
  await expect(
    detail.getByRole("heading", { name: "Обновлены личные настройки" }),
  ).toBeVisible();
  await expect(detail.getByText("Связанные события")).toHaveCount(0);
  await expect(detail.getByText("private-user-id")).not.toBeVisible();
  await expect(
    detail.getByRole("button", { name: "Открыть объект" }),
  ).toHaveCount(0);
  await page.screenshot({ path: "artifacts/audit-personal-settings.png" });
  await detail.locator("summary").click();
  await expect(detail.getByText(/private-user-id/)).toBeVisible();
});

test("operation shows source, initiator and result before technical details", async ({
  page,
}) => {
  await mockJournal(page);
  const operation = {
    id: "opaque-job-id",
    kind: "refresh",
    resource_id: "",
    integration_id: "opaque-source-id",
    integration_name: "Основной Prometheus",
    parameters: {},
    status: "succeeded",
    actor: "opaque-user-id",
    actor_name: "Кирилл Царев",
    created_at: now.toISOString(),
    result: { refreshed: true },
    error: "",
  };
  await page.route("**/api/v1/operations?*", (route) =>
    route.fulfill({ json: [operation] }),
  );
  await page.route("**/api/v1/jobs/opaque-job-id", (route) =>
    route.fulfill({ json: operation }),
  );
  await page.goto("/#events");
  await page.getByRole("button", { name: "Операции", exact: true }).click();
  const row = page.locator(".workspace-operation-row");
  await expect(row).toContainText("Обновление источника · Основной Prometheus");
  await expect(row).toContainText("Кирилл Царев");
  await row.click();
  const result = page.getByLabel("Результат операции");
  await expect(result).toContainText("Основной Prometheus");
  await expect(result).toContainText("Кирилл Царев");
  await expect(result).toContainText("Завершено");
  await expect(result).toContainText("Данные источника обновлены");
  await expect(result.getByText("opaque-user-id")).not.toBeVisible();
  await page.screenshot({ path: "artifacts/operation-refresh-result.png" });
  await result.locator("summary").click();
  await expect(result.getByText("opaque-user-id")).toBeVisible();
});

test("operation outcomes describe enrichment and keep failures honest", async ({
  page,
}) => {
  await mockJournal(page);
  const common = {
    resource_id: "",
    integration_id: "",
    actor: "system",
    actor_name: "",
    created_at: now.toISOString(),
    error: "",
  };
  const enrich = {
    ...common,
    id: "enrich-job",
    kind: "enrich",
    status: "succeeded",
    parameters: { target: "https://example.test" },
    result: {
      suggestions: { name: "Сервис" },
      observations: { http_status: 403 },
      requires_confirmation: true,
    },
  };
  const failed = {
    ...common,
    id: "failed-job",
    kind: "refresh",
    status: "failed",
    integration_id: "missing-source",
    parameters: {},
    result: {},
    error: "Источник недоступен",
  };
  await page.route("**/api/v1/operations?*", (route) =>
    route.fulfill({ json: [enrich, failed] }),
  );
  await page.route("**/api/v1/jobs/*", (route) =>
    route.fulfill({
      json: route.request().url().endsWith("enrich-job") ? enrich : failed,
    }),
  );
  await page.goto("/#events");
  await page.getByRole("button", { name: "Операции", exact: true }).click();
  const rows = page.locator(".workspace-operation-row");
  await rows.first().click();
  const result = page.getByLabel("Результат операции");
  await expect(result).toContainText("HTTP 403");
  await expect(result).toContainText("Предложенное название: Сервис");
  await expect(result).toContainText("Предложения требуют подтверждения");
  await expect(result).toContainText("Система");
  await rows.nth(1).click();
  await expect(result).toContainText("Ошибка");
  await expect(result).toContainText("Источник недоступен");
  await expect(result).not.toContainText("Данные источника обновлены");
});

for (const width of [1920, 3440])
  for (const theme of ["dark", "light"]) {
    test(`events static 60/40 workspace ${width} ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width,
        height: width === 1920 ? 1080 : 1440,
      });
      await page.addInitScript(
        (theme) => localStorage.setItem("pl-ui-theme", theme),
        theme,
      );
      await mockJournal(page);
      await page.goto("/#events");
      const rows = page.locator(".events-entry");
      await expect(rows).toHaveCount(30);
      // Mocked EventSource closes; settle its status banner before recording geometry.
      await expect(
        page.getByText(/^Связь с обновлениями потеряна/),
      ).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollHeight))
        .toBeLessThanOrEqual(width === 1920 ? 1081 : 1441);
      const before = await page.locator(".events-split").boundingBox();
      await rows.first().click();
      await expect(page.locator(".events-detail-heading h2")).toHaveText(
        "Ошибка сбора метрик 0",
      );
      await expect(page.locator(".events-inspector")).not.toContainText(
        "Получено Платформой",
      );
      await expect(page.locator(".events-split")).toHaveJSProperty(
        "clientWidth",
        Math.round(before!.width),
      );
      const geometry = await page.evaluate(() => {
        const list = document
          .querySelector(".events-list")!
          .getBoundingClientRect();
        const detail = document
          .querySelector(".events-inspector")!
          .getBoundingClientRect();
        const row = document
          .querySelector(".events-entry")!
          .getBoundingClientRect();
        return {
          ratio: list.width / detail.width,
          pageHeight: document.documentElement.scrollHeight,
          viewport: innerHeight,
          overflowX: document.documentElement.scrollWidth > innerWidth,
          rowHeight: row.height,
        };
      });
      expect(geometry.ratio).toBeCloseTo(1.5, 1);
      expect(geometry.pageHeight).toBeLessThanOrEqual(geometry.viewport + 1);
      expect(geometry.overflowX).toBe(false);
      expect(geometry.rowHeight).toBeLessThanOrEqual(90);
      await page.screenshot({ path: `artifacts/events-${width}-${theme}.png` });
      await page.keyboard.press("Escape");
      await expect(page.locator(".events-inspector-empty")).toBeVisible();
      expect(await page.locator(".events-split").boundingBox()).toEqual(before);
    });
  }

test("snapshot polling preserves list until accepted, selection and scroll anchor survive; server filters", async ({
  page,
}) => {
  await page.clock.install({ time: now });
  const state = await mockJournal(page);
  await page.goto("/#events");
  const rows = page.locator(".events-entry");
  await expect(rows).toHaveCount(30);
  await rows.nth(7).click();
  await page
    .locator(".events-list-scroll")
    .evaluate((el) => (el.scrollTop = 400));
  const before = await page.locator('[data-event-id="event-7"]').boundingBox();
  state.pending = 1;
  await page.clock.runFor(15000);
  const receive = page.getByRole("button", { name: "Новых событий: 1" });
  await expect(receive).toBeVisible();
  await expect(rows).toHaveCount(30);
  await receive.click();
  await expect(rows).toHaveCount(31);
  await expect(page.locator('[data-event-id="event-7"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(
      async () =>
        (await page.locator('[data-event-id="event-7"]').boundingBox())!.y,
    )
    .toBeCloseTo(before!.y, 0);
  await page
    .getByLabel("Источник", { exact: true })
    .selectOption("alertmanager");
  await expect
    .poll(() => state.requests.at(-1)?.searchParams.get("source"))
    .toBe("alertmanager");
  await page
    .getByRole("button", { name: "Проблемы и восстановления", exact: true })
    .click();
  await expect
    .poll(() => state.requests.at(-1)?.searchParams.get("monitoring_only"))
    .toBe("true");
  await page.getByRole("button", { name: "Аудит", exact: true }).click();
  await expect
    .poll(() => state.requests.at(-1)?.searchParams.get("channel"))
    .toBe("audit");
});

test("new rows acknowledge automatically after continuous visibility and fade, offscreen rows do not", async ({
  page,
}) => {
  await page.clock.install({ time: now });
  const state = await mockJournal(page);
  await page.goto("/#events");
  const first = page.locator('[data-event-id="event-0"]');
  await expect(first).toHaveClass(/is-new/);
  await expect(first).toBeInViewport({ ratio: 0.9 });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  await page.clock.runFor(1500);
  await page
    .locator(".events-list-scroll")
    .evaluate((el) => (el.scrollTop = 900));
  await expect(first).not.toBeInViewport();
  await page.clock.runFor(2500);
  expect(state.acks).not.toContain("event-0");
  await page
    .locator(".events-list-scroll")
    .evaluate((el) => (el.scrollTop = 0));
  await expect(first).toBeInViewport({ ratio: 0.9 });
  await page.clock.runFor(2900);
  expect(state.acks).not.toContain("event-0");
  await page.clock.runFor(200);
  await expect.poll(() => state.acks).toContain("event-0");
  await expect(first).toHaveClass(/is-seen/);
  expect(
    await first.evaluate(
      (el) => getComputedStyle(el, "::before").transitionDuration,
    ),
  ).toBe("0.9s");
});

test("initial API error has retry and no false empty state", async ({
  page,
}) => {
  await mockJournal(page, { fail: true });
  await page.goto("/#events");
  await expect(page.getByRole("alert")).toContainText(
    "Источник временно недоступен",
  );
  await expect(
    page.getByText("Нет событий по выбранным фильтрам", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /Повторить/ }).click();
  await expect(page.locator(".events-entry")).toHaveCount(30);
});

test("all history and custom range use server bounds; invalid range preserves inputs", async ({
  page,
}) => {
  await page.clock.install({ time: now });
  const state = await mockJournal(page);
  await page.goto("/#events");
  await expect(page.locator(".events-entry")).toHaveCount(30);
  await page.getByLabel("Период", { exact: true }).selectOption("all");
  await expect
    .poll(() => state.requests.at(-1)?.searchParams.has("from"))
    .toBe(false);
  await page.getByLabel("Период", { exact: true }).selectOption("custom");
  await expect
    .poll(() => state.requests.at(-1)?.searchParams.has("to"))
    .toBe(true);
  await page.getByLabel("Начало периода").fill("2026-10-23T14:00");
  await page.getByLabel("Конец периода").fill("2026-10-23T13:00");
  const count = state.requests.length;
  await page.getByRole("button", { name: "Применить период" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Конец должен быть позже начала",
  );
  expect(state.requests.length).toBe(count);
  await expect(page.getByLabel("Начало периода")).toHaveValue(
    "2026-10-23T14:00",
  );
  await page.getByLabel("Конец периода").fill("2026-10-23T15:00");
  await page.getByRole("button", { name: "Применить период" }).click();
  await expect
    .poll(() => state.requests.at(-1)?.searchParams.get("from"))
    .toBe("2026-10-23T11:00:00.000Z");
  await expect
    .poll(() => state.requests.at(-1)?.searchParams.get("to"))
    .toBe("2026-10-23T12:00:00.000Z");
  await page.locator(".events-entry").first().click();
  await expect(page.locator(".events-inspector time")).toContainText("2026");
  await expect(page.locator(".events-inspector time")).toContainText(
    "12:00:00",
  );
});

test("pagination reuses frozen snapshot and cursor", async ({ page }) => {
  const state = await mockJournal(page, { paginated: true });
  await page.goto("/#events");
  await expect(page.locator(".events-entry")).toHaveCount(10);
  await page.getByRole("button", { name: "Показать ещё" }).click();
  await expect(page.locator(".events-entry")).toHaveCount(20);
  expect(state.requests.at(-1)?.searchParams.get("snapshot")).toBe("old");
  expect(state.requests.at(-1)?.searchParams.get("cursor")).toBe("10");
  await page.getByRole("button", { name: "Показать ещё" }).click();
  await expect(page.locator(".events-entry")).toHaveCount(30);
  await expect(page.getByRole("button", { name: "Показать ещё" })).toHaveCount(
    0,
  );
});

test("reduced motion disables highlight transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockJournal(page);
  await page.goto("/#events");
  const row = page.locator(".events-entry").first();
  await expect(row).toBeVisible();
  // The shared shell uses a 0.01ms reduced-motion fallback with !important.
  expect(
    parseFloat(
      await row.evaluate(
        (el) => getComputedStyle(el, "::before").transitionDuration,
      ),
    ),
  ).toBeLessThanOrEqual(0.001);
});

for (const width of [1920]) {
  for (const theme of ["dark", "light"]) {
    test(`audit authors visible without opening details ${width} ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width,
        height: width === 1920 ? 1080 : 1440,
      });
      await page.addInitScript(
        (value) => localStorage.setItem("pl-ui-theme", value),
        theme,
      );
      let releaseAudit!: () => void;
      const auditResponse = new Promise<void>((resolve) => {
        releaseAudit = resolve;
      });
      await mockJournal(page, { auditResponse });
      await page.goto("/#events");
      const rows = page.locator(".events-entry");
      await expect(rows).toHaveCount(30);
      await expect(page.locator(".events-row-author")).toHaveCount(0);
      // A mode change reloads the journal. Old event rows can already render
      // author labels before that request starts; they are not the audit result.
      try {
        await page.getByRole("button", { name: "Аудит", exact: true }).click();
        await expect(
          page.getByText("Загрузка событий…", { exact: true }),
        ).toBeVisible();
        await expect(rows).toHaveCount(0);
      } finally {
        releaseAudit();
      }
      await expect(rows.first()).toHaveAttribute(
        "data-event-id",
        "audit-event-0",
      );
      await expect(rows).toHaveCount(30);
      await expect(rows.first().locator("strong")).toContainText(
        "Изменение ресурса 0",
      );
      await expect(rows.first().locator(".events-row-author")).toHaveText(
        "Автор: Мария Петрова",
      );
      await expect(rows.nth(1).locator(".events-row-author")).toHaveText(
        "Автор: Система",
      );
      await expect(rows.nth(2).locator(".events-row-author")).toHaveText(
        "Автор: Имя не указано",
      );
      await expect(rows.nth(2)).not.toContainText("ad:unresolved-test-actor");
      await expect(page.locator(".events-inspector-empty")).toBeVisible();
      const geometry = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        page: document.documentElement.scrollHeight,
        viewport: innerHeight,
        row: document.querySelector(".events-entry")!.getBoundingClientRect()
          .height,
      }));
      expect(geometry.overflow).toBe(false);
      expect(geometry.page).toBeLessThanOrEqual(geometry.viewport + 1);
      expect(geometry.row).toBeLessThanOrEqual(90);
      await page.screenshot({
        path: `artifacts/audit-authors-${width}-${theme}.png`,
      });
      await page
        .getByRole("group", { name: "Режим журнала" })
        .getByRole("button", { name: "События", exact: true })
        .click();
      await expect(rows.first()).toHaveAttribute("data-event-id", "event-0");
      await expect(page.locator(".events-row-author")).toHaveCount(0);
    });
  }
}

test("module operations show details and close a recovered refresh after a live update", async ({
  page,
}) => {
  const state = await mockJournal(page);
  await page.addInitScript(() => {
    window.EventSource = class extends EventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        window.addEventListener("test:operation-change", () =>
          this.dispatchEvent(new Event("change")),
        );
      }
    };
  });
  const operation = {
    id: "module-job",
    kind: "module",
    resource_id: "",
    integration_id: "",
    actor: "system:modules",
    actor_name: "Система · modules",
    created_at: now.toISOString(),
    status: "succeeded",
    error: "",
    parameters: {
      action: "refresh",
      instance_id: "metrics",
      module_id: "prometheus",
      module_name: "Метрики стенда",
    },
    result: {
      instance: {
        name: "Метрики стенда",
        observed_state: "running",
        version: "3.11.0",
      },
    },
  };
  const failure = {
    ...operation,
    id: "module-job-failed",
    created_at: new Date(+now - 60000).toISOString(),
    status: "failed",
    error: "Автоматическая проверка не завершилась",
    result: {},
  };
  let recovered = false;
  const requests: URL[] = [];
  await page.route("**/api/v1/operations?*", (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const filtered = url.searchParams.get("exclude_service_refresh") === "true";
    return route.fulfill({
      json: recovered ? (filtered ? [] : [operation, failure]) : [failure],
    });
  });
  await page.route("**/api/v1/jobs/module-job*", (route) =>
    route.fulfill({
      json: route.request().url().endsWith(failure.id) ? failure : operation,
    }),
  );
  await page.goto("/#events");
  await expect.poll(() => state.requests.length).toBeGreaterThan(0);
  expect(
    state.requests.at(-1)?.searchParams.get("exclude_service_refresh"),
  ).toBe("true");
  await page
    .getByLabel("Показывать успешные служебные обновления")
    .first()
    .check();
  await expect
    .poll(() =>
      state.requests.at(-1)?.searchParams.has("exclude_service_refresh"),
    )
    .toBe(false);
  await page.getByRole("button", { name: "Операции", exact: true }).click();
  await expect
    .poll(() => requests.at(-1)?.searchParams.get("exclude_service_refresh"))
    .toBe("true");
  const rows = page.locator(".workspace-operation-row");
  const result = page.getByLabel("Результат операции");
  await rows.click();
  await expect(result).toContainText(failure.error);

  recovered = true;
  await page.evaluate(() =>
    window.dispatchEvent(new Event("test:operation-change")),
  );
  await expect(rows).toHaveCount(0);
  await expect(page.getByText("Операций пока нет", { exact: true })).toBeVisible();
  await expect(result).toContainText("Выбери запись слева");
  await expect(result).not.toContainText(failure.error);

  await page
    .getByRole("checkbox", { name: /Показывать историю фоновых проверок/ })
    .check();
  await expect(rows).toHaveCount(2);
  await expect(rows.getByText("Ошибка", { exact: true })).toBeVisible();
  await expect(result).toContainText("Выбери запись слева");
  const row = rows.filter({ has: page.getByText("Завершено", { exact: true }) });
  await expect(row).toContainText(
    "Обновление состояния модуля · Метрики стенда",
  );
  await expect(row).toContainText("Система · modules");
  await expect(row).not.toContainText("Цель не указана");
  await row.click();
  await expect(result).toContainText("Метрики стенда");
  await expect(result).toContainText("Версия: 3.11.0");
  await expect(result).toContainText("Состояние: Работает.");
  await expect(result).not.toContainText("Состояние: Выполняется");
  await expect(result).toContainText("Операция с модулем завершена");
  await page.screenshot({ path: "artifacts/module-operation-context.png" });
});

test("delivery operations show target versions original actors rollback and unconfirmed outcomes", async ({
  page,
}) => {
  await mockJournal(page);
  const base = {
    kind: "delivery",
    resource_id: "",
    integration_id: "",
    actor: "local:original-admin",
    actor_name: "Анна Смирнова",
    created_at: now.toISOString(),
    error: "",
  };
  const jobs = [
    {
      ...base,
      id: "delivery-core",
      status: "succeeded",
      parameters: { action: "upgrade", target: "Платформа", version: "0.6.3" },
      result: {
        phase: "complete",
        target_version: "0.6.3",
        summary: "PL 0.6.3 установлена.",
      },
    },
    {
      ...base,
      id: "delivery-rollback",
      status: "failed",
      parameters: {
        action: "module-upgrade",
        target: "Doska",
        module_id: "doska",
        version: "2.46.3",
      },
      result: {
        phase: "rolled_back",
        target_version: "2.46.3",
        current_version: "0.6.2",
        recovery_mode: "rollback",
        restored_snapshot: true,
        summary: "Обновление отменено. Предыдущая версия Doska восстановлена.",
      },
    },
    {
      ...base,
      id: "delivery-unconfirmed",
      status: "unknown",
      actor_name: "",
      parameters: {
        action: "module-upgrade",
        target: "Forms",
        module_id: "forms",
        version: "0.1.1",
      },
      result: {
        phase: "unconfirmed",
        target_version: "0.1.1",
        current_version: "0.6.2",
        recovery_mode: "rollback",
        restored_snapshot: false,
      },
    },
    {
      ...base,
      id: "delivery-running",
      status: "running",
      parameters: {
        action: "module-upgrade",
        target: "NetMap",
        module_id: "netmap",
        version: "1.1.0",
      },
      result: { phase: "verifying", target_version: "1.1.0" },
    },
  ];
  await page.route("**/api/v1/operations?*", (route) =>
    route.fulfill({ json: jobs }),
  );
  await page.route("**/api/v1/jobs/delivery-*", (route) =>
    route.fulfill({
      json: jobs.find((job) => route.request().url().endsWith(job.id)),
    }),
  );
  await page.goto("/#events");
  await page.getByRole("button", { name: "Операции", exact: true }).click();
  const rows = page.locator(".workspace-operation-row");
  await expect(rows).toHaveCount(4);
  const result = page.getByLabel("Результат операции");
  await rows
    .filter({ hasText: "Обновление PL · Платформа · до 0.6.3" })
    .click();
  await expect(result).toContainText("Анна Смирнова");
  await expect(result).toContainText("PL 0.6.3 установлена.");
  await expect(
    result.getByText("Обновление завершено", { exact: true }),
  ).toBeVisible();
  await rows
    .filter({ hasText: "Обновление модуля · Doska · до 2.46.3" })
    .click();
  await expect(
    result.getByText("Предыдущая версия восстановлена", { exact: true }),
  ).toHaveCount(2);
  await expect(result).toContainText("Предыдущая версия Doska восстановлена.");
  await expect(result.getByText("2.46.3", { exact: true })).toBeVisible();
  await expect(result.getByText("0.6.2", { exact: true })).toHaveCount(0);
  await rows
    .filter({ hasText: "Обновление модуля · Forms · до 0.1.1" })
    .click();
  await expect(
    result.getByText("Не подтверждено", { exact: true }),
  ).toBeVisible();
  await expect(result).toContainText("local:original-admin");
  await expect(result).toContainText("Сервер пока не подтвердил результат");
  await expect(result).toContainText("Ожидаем подтверждения сервера");
  await expect(result).not.toContainText("Предыдущее состояние восстановлено");
  await expect(result).not.toContainText("Обновление не завершено");
  await rows
    .filter({ hasText: "Обновление модуля · NetMap · до 1.1.0" })
    .click();
  await expect(result).toContainText("Проверяем новую версию");
});

test("module event inspector names the instance and exposes observed outcome", async ({
  page,
}) => {
  await mockJournal(page);
  const event = {
    ...item(0),
    kind: "job.succeeded",
    title: "Обновление состояния модуля · Метрики стенда — завершено",
    event_type: "operation",
    source: "platform",
    source_name: "Платформа",
    resource_id: "",
    resource_name: "",
    object_kind: "job",
    object_name: "Метрики стенда",
    job_kind: "module",
    actor: "system:modules",
    actor_name: "Система · modules",
    details: {
      module_action: "refresh",
      result_summary: "Состояние: работает · Версия: 3.11.0",
    },
  };
  await page.route("**/api/v1/event-journal?*", (route) =>
    route.fulfill({
      json: {
        items: [event],
        total: 1,
        new_count: 0,
        snapshot: "module",
        next_cursor: "",
      },
    }),
  );
  await page.route("**/api/v1/event-journal/event-0?*", (route) =>
    route.fulfill({ json: { event, related: [] } }),
  );
  await page.goto("/#events");
  await page.locator(".events-entry").click();
  const inspector = page.locator(".events-inspector");
  await expect(inspector).toContainText("Метрики стенда");
  await expect(inspector).toContainText("Состояние: работает · Версия: 3.11.0");
  await expect(inspector).not.toContainText("Без привязки к объекту");
});
