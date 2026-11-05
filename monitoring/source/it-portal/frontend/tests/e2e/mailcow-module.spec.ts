import { expect, test, type Page } from "@playwright/test";

const instanceID = "a3333333-3333-4333-8333-333333333333";
const base = `/modules/${instanceID}/mailcow`;
const nativeURL = "https://mail.example.test/";
const ids = [
  "inventory",
  "mailboxes",
  "queue",
  "services",
  "storage",
  "rspamd",
] as const;
type GroupID = (typeof ids)[number];
type Group = {
  enabled: boolean;
  interval_seconds: number;
  status: string;
  last_attempt_at: string | null;
  last_attempt_status: string;
  last_success_at: string | null;
  error_code: string;
  stale: boolean;
  data: Record<string, unknown> | null;
};
type Write = {
  path: string;
  method: string;
  body: {
    revision: number;
    groups: Record<GroupID, { enabled: boolean; interval_seconds: number }>;
  };
};
function emptyGroup(): Group {
  return {
    enabled: false,
    interval_seconds: 60,
    status: "disabled",
    last_attempt_at: null,
    last_attempt_status: "",
    last_success_at: null,
    error_code: "",
    stale: false,
    data: null,
  };
}
async function fixture(
  page: Page,
  options: {
    admin?: boolean;
    groups?: Partial<Record<GroupID, Partial<Group>>>;
    saveError?: "conflict" | "server";
    readError?: boolean;
    modules?: Record<string, unknown>[];
  } = {},
) {
  const writes: Write[] = [];
  const reads: string[] = [];
  const snapshot = {
    instance_id: instanceID,
    integration_id: "mail-lab",
    name: "Почта лаборатории",
    url: nativeURL,
    revision: 7,
    enabled: true,
    groups: Object.fromEntries(
      ids.map((id) => [id, { ...emptyGroup(), ...options.groups?.[id] }]),
    ) as Record<GroupID, Group>,
  };
  const modules = options.modules ?? [
    {
      id: instanceID,
      module_id: "mailcow",
      integration_id: "mail-lab",
      name: snapshot.name,
      mode: "external",
      desired_state: "enabled",
      observed_state: "running",
      revision: 1,
      version: "2026-10",
      url: nativeURL,
    },
  ];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    expect(request.headers()["x-api-key"]).toBeUndefined();
    if (request.method() !== "GET") {
      expect(request.headers()["x-csrf-token"]).toBe("mailcow-fixture-csrf");
      const body = request.postDataJSON() as Write["body"];
      writes.push({ path, method: request.method(), body });
      if (path !== base + "/settings" || request.method() !== "PUT")
        return route.fulfill({
          status: 404,
          json: { error: "unexpected_mutation" },
        });
      if (options.saveError === "conflict") {
        snapshot.revision = 8;
        return route.fulfill({
          status: 409,
          json: { error: "revision_conflict" },
        });
      }
      if (options.saveError === "server")
        return route.fulfill({
          status: 502,
          json: {
            error: "settings_unavailable",
            message: "Не удалось сохранить настройки почты",
          },
        });
      expect(body.revision).toBe(snapshot.revision);
      for (const id of ids)
        Object.assign(snapshot.groups[id], body.groups[id], {
          status: body.groups[id].enabled ? "pending" : "disabled",
        });
      snapshot.revision++;
      return route.fulfill({ json: snapshot });
    }
    reads.push(path);
    if (path === base) {
      if (options.readError)
        return route.fulfill({
          status: 503,
          json: {
            error: "cache_unavailable",
            message: "Данные почты недоступны",
          },
        });
      return route.fulfill({ json: snapshot });
    }
    const responses: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "admin", name: "Admin", admin: options.admin !== false },
        csrf_token: "mailcow-fixture-csrf",
        features: {},
        local_users_enabled: true,
      },
      "/modules": { items: modules },
      "/modules/catalog": {
        items: [
          {
            id: "mailcow",
            name: "Почта",
            modes: ["external"],
            view: "mailcow",
          },
        ],
      },
      "/help-state": { disabled: true, seen: [] },
      "/preferences": {
        favorites: [],
        hidden_sections: [],
        section_order: [],
        home_widgets: [],
      },
      "/chart-settings": { revision: 1, charts: [] },
    };
    return route.fulfill({ json: responses[path] ?? [] });
  });
  return { writes, reads, snapshot, modules };
}
async function open(page: Page) {
  await page.goto(`/#modules?instance=${instanceID}&view=mailcow`);
  await expect(
    page.getByRole("heading", { name: "Почта", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Источник Mailcow", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Обзор", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
}
async function collection(page: Page) {
  await page.getByRole("button", { name: "Сбор данных", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Сбор данных", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  for (const summary of await page
    .locator(".mailcow-group-data > summary")
    .all())
    await summary.click();
}
async function openCollection(page: Page) {
  await open(page);
  await collection(page);
}
function group(page: Page, name: string) {
  return page
    .locator(".mailcow-groups > section")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
}
function metric(page: Page, groupName: string, label: string) {
  return group(page, groupName)
    .locator("dl > div")
    .filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) })
    .locator("dd");
}
function summaryCard(page: Page, name: string) {
  return page.locator(".mailcow-overview > section").filter({
    has: page.getByRole("heading", { name, exact: true }),
  });
}
function summaryMetric(page: Page, cardName: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return summaryCard(page, cardName)
    .locator("dl > div")
    .filter({
      has: page.locator("dt", { hasText: new RegExp(`^${escaped}$`) }),
    })
    .locator("dd");
}
function collected(data: Record<string, unknown>): Partial<Group> {
  const now = new Date().toISOString();
  return {
    enabled: true,
    status: "ok",
    last_attempt_at: now,
    last_attempt_status: "success",
    last_success_at: now,
    data,
  };
}

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
]) {
  for (const theme of ["dark", "light"]) {
    test(`mail summary fits ${viewport.width}x${viewport.height} in ${theme} theme and uses actual fields`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(
        (value) => localStorage.setItem("pl-ui-theme", value),
        theme,
      );
      await fixture(page, {
        groups: {
          queue: collected({
            messages_observed: 7,
            bytes_observed: 4096,
            oldest_observed_age_seconds: 42,
            by_queue: { deferred: 2, active: 5 },
            empty_ambiguous: false,
          }),
          mailboxes: collected({
            mailboxes: 3,
            active_mailboxes: 2,
            messages: 11,
            used_bytes: 8192,
            quota_over_90_percent: 1,
          }),
          inventory: collected({
            domains: 4,
            active_domains: 3,
            version: "2026-10",
          }),
          storage: collected({
            used_percent: 37.5,
            used_display: "6G",
            total_display: "16G",
          }),
          rspamd: collected({
            scanned: 117,
            actions: {
              reject: 5,
              "add header": 9,
              "rewrite subject": 3,
              "no action": 100,
            },
          }),
          services: collected({
            services: {
              "postfix-mailcow": {
                state: "running",
                started_at: 1793347200.123,
              },
              "dovecot-mailcow": {
                state: "running",
                started_at: 1793347200.456,
              },
              "rspamd-mailcow": {
                state: "running",
                started_at: 1793347200.789,
              },
              "clamd-mailcow": { state: "exited", started_at: 1793347200 },
            },
          }),
        },
      });
      await open(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator(".mailcow-overview > section")).toHaveCount(4);
      await expect(page.locator(".mailcow-overview")).toHaveCSS(
        "grid-template-columns",
        /^\S+ \S+$/,
      );
      for (const name of [
        "Очередь доставки",
        "Хранилище и квоты",
        "Антиспам · Rspamd",
        "Почтовые ящики",
      ]) {
        await expect(summaryCard(page, name)).toBeVisible();
      }
      await expect(
        summaryMetric(page, "Очередь доставки", "Писем в очереди"),
      ).toHaveText("7");
      await expect(
        summaryMetric(page, "Очередь доставки", "Из них отложено"),
      ).toHaveText("2");
      await expect(
        summaryMetric(page, "Очередь доставки", "Объём очереди"),
      ).toHaveText("4 КиБ");
      await expect(
        summaryMetric(page, "Очередь доставки", "Возраст старейшего, с"),
      ).toHaveText("42");
      await expect(
        summaryMetric(page, "Хранилище и квоты", "Заполнение диска vmail"),
      ).toHaveText("37,5%");
      const progress = summaryCard(page, "Хранилище и квоты").getByRole(
        "progressbar",
        { name: "Заполнение диска vmail" },
      );
      await expect(progress).toHaveAttribute("value", "37.5");
      await expect(progress).toHaveAttribute("max", "100");
      await expect(
        summaryCard(page, "Хранилище и квоты").getByText("6G из 16G", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        summaryMetric(page, "Хранилище и квоты", "Ящиков у лимита (≥ 90%)"),
      ).toHaveText("1");
      await expect(
        summaryMetric(page, "Антиспам · Rspamd", "Проверено"),
      ).toHaveText("117");
      await expect(
        summaryMetric(page, "Антиспам · Rspamd", "Отклонено"),
      ).toHaveText("5");
      await expect(
        summaryMetric(page, "Антиспам · Rspamd", "Добавлен заголовок"),
      ).toHaveText("9");
      await expect(
        summaryMetric(page, "Почтовые ящики", "Включённые ящики"),
      ).toHaveText("2");
      await expect(
        summaryMetric(page, "Почтовые ящики", "Всего ящиков"),
      ).toHaveText("3");
      await expect(
        summaryMetric(page, "Почтовые ящики", "Хранящиеся письма"),
      ).toHaveText("11");
      await expect(
        summaryMetric(page, "Почтовые ящики", "Занято ящиками"),
      ).toHaveText("8 КиБ");
      await expect(summaryMetric(page, "Почтовые ящики", "Домены")).toHaveText(
        "4",
      );
      await expect(
        summaryMetric(page, "Почтовые ящики", "Активные домены"),
      ).toHaveText("3");
      await expect(page.locator(".mailcow-source-bar")).toContainText(
        "mail.example.test",
      );
      await expect(page.locator(".mailcow-container-summary")).toHaveCount(0);
      await expect(page.locator(".mailcow-source-bar .status-ok")).toHaveCount(
        0,
      );
      await expect(
        page
          .locator(".mailcow-overview")
          .getByText(
            /карантин|Службы почты|здоров|исправн[ао]\s+почт|отправлено за/i,
          ),
      ).toHaveCount(0);
      await expect(page.locator(".mailcow-groups")).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Настройки сбора", exact: true }),
      ).toHaveCount(0);
      // Leave the real shell and its SSE failure notice in place. Assert the
      // ordinary initial viewport without scrolling, CSS transforms or clipping.
      await expect(
        page
          .locator(".notice.compact")
          .filter({ hasText: /Связь с обновлениями потеряна/ }),
      ).toBeVisible();
      const bounds = await page
        .locator(".mailcow-overview > section")
        .evaluateAll((cards) => ({
          cards: cards.map((card) => {
            const box = card.getBoundingClientRect();
            const style = getComputedStyle(card);
            return {
              x: box.x,
              y: box.y,
              right: box.right,
              bottom: box.bottom,
              width: box.width,
              height: box.height,
              transform: style.transform,
              overflow: style.overflow,
              clientHeight: card.clientHeight,
              scrollHeight: card.scrollHeight,
            };
          }),
          viewport: { width: innerWidth, height: innerHeight },
          scrollY,
          documentWidth: document.documentElement.scrollWidth,
        }));
      expect(bounds.scrollY).toBe(0);
      expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.viewport.width);
      for (const box of bounds.cards) {
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(bounds.viewport.width);
        expect(box.bottom).toBeLessThanOrEqual(bounds.viewport.height);
        expect(box.transform).toBe("none");
        expect(box.overflow).not.toMatch(/hidden|clip/);
        expect(box.scrollHeight).toBeLessThanOrEqual(box.clientHeight + 1);
      }
      expect(
        Math.abs(bounds.cards[0].y - bounds.cards[1].y),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(bounds.cards[2].y - bounds.cards[3].y),
      ).toBeLessThanOrEqual(1);
    });
  }
}

test("connected Mailcow opens from its own sidebar page and survives reload", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/#modules");
  await expect(
    page.getByRole("link", { name: "Управлять почтой", exact: true }),
  ).toHaveAttribute("href", `#mail?instance=${instanceID}`);
  const navigation = page
    .locator(".sidebar")
    .getByRole("button", { name: "Почта", exact: true });
  await navigation.click();
  await expect(page).toHaveURL(/#mail$/);
  await expect(navigation).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("region", { name: "Источник Mailcow", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(navigation).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("region", { name: "Источник Mailcow", exact: true }),
  ).toBeVisible();
});

test("old module deep link belongs to the Mail sidebar without breaking saved catalog links", async ({
  page,
}) => {
  await fixture(page);
  await open(page);
  await expect(
    page
      .locator(".sidebar")
      .getByRole("button", { name: "Почта", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page
      .locator(".sidebar")
      .getByRole("button", { name: "Установленные модули", exact: true }),
  ).not.toHaveAttribute("aria-current", "page");
});

test("Mail menu is absent before connection and a direct link offers the module catalog", async ({
  page,
}) => {
  const state = await fixture(page, { modules: [] });
  await page.goto("/#mail");
  await expect(
    page
      .locator(".sidebar")
      .getByRole("button", { name: "Почта", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Mailcow не подключён", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Открыть каталог модулей" }),
  ).toHaveAttribute("href", "#module-catalog");
  expect(state.reads).not.toContain(base);
});

test("disabled or unavailable connections retain their Mail page; removal hides it", async ({
  page,
}) => {
  const state = await fixture(page);
  state.modules[0].observed_state = "error";
  await page.goto("/#mail");
  const navigation = page
    .locator(".sidebar")
    .getByRole("button", { name: "Почта", exact: true });
  await expect(navigation).toBeVisible();
  state.modules[0].desired_state = "disabled";
  state.modules[0].observed_state = "disabled";
  await page.reload();
  await expect(navigation).toBeVisible();
  state.modules[0].desired_state = "removed";
  await page.reload();
  await expect(navigation).toHaveCount(0);
  await expect(
    page.getByText("Mailcow не подключён", { exact: true }),
  ).toBeVisible();
});

test("multiple Mailcow connections select and reload the requested source without falling back to another", async ({
  page,
}) => {
  const state = await fixture(page);
  const secondID = "b3333333-3333-4333-8333-333333333333";
  state.modules.push({
    ...state.modules[0],
    id: secondID,
    name: "Вторая почта",
  });
  let secondReads = 0;
  await page.route(`**/api/v1/modules/${secondID}/mailcow`, async (route) => {
    secondReads++;
    await route.fulfill({
      json: { ...state.snapshot, instance_id: secondID, name: "Вторая почта" },
    });
  });
  await page.goto("/#mail");
  await expect(
    page
      .locator(".empty")
      .getByText("Выберите почтовый сервер", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Подключение Mailcow", exact: true })
    .selectOption(secondID);
  await expect(page).toHaveURL(new RegExp(`#mail\\?instance=${secondID}$`));
  await expect(
    page.getByRole("region", { name: "Источник Mailcow", exact: true }),
  ).toBeVisible();
  expect(secondReads).toBeGreaterThan(0);
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Подключение Mailcow", exact: true }),
  ).toHaveValue(secondID);
  await page.goto("/#mail?instance=missing-connection");
  await expect(
    page.getByText("Это подключение Mailcow недоступно", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Источник Mailcow", exact: true }),
  ).toHaveCount(0);
});

test("non-admin cannot enter the Mail page through either route", async ({
  page,
}) => {
  const state = await fixture(page, { admin: false });
  for (const route of [
    "/#mail",
    `/#modules?instance=${instanceID}&view=mailcow`,
  ]) {
    await page.goto(route);
    await expect(
      page.getByRole("heading", { name: "Нет доступа", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Источник Mailcow", exact: true }),
    ).toHaveCount(0);
  }
  expect(state.reads).not.toContain(base);
  expect(state.writes).toHaveLength(0);
});

test("summary keeps stale values without current health and does not invent unsupported metrics or progress", async ({
  page,
}) => {
  await fixture(page, {
    groups: {
      queue: {
        ...collected({ messages_observed: 7, by_queue: { deferred: 2 } }),
        stale: true,
        status: "stale",
        error_code: "timeout",
      },
      rspamd: {
        enabled: true,
        status: "unsupported",
        error_code: "unsupported",
      },
      services: {
        ...collected({
          services: {
            "postfix-mailcow": { state: "running", started_at: 1793347200 },
          },
        }),
        status: "stale",
        stale: true,
      },
    },
  });
  await open(page);
  await expect(
    summaryMetric(page, "Очередь доставки", "Писем в очереди"),
  ).toHaveText("7");
  await expect(summaryCard(page, "Очередь доставки")).toContainText(
    "Данные устарели",
  );
  await expect(page.locator(".mailcow-container-summary")).toHaveCount(0);
  await expect(page.locator(".mailcow-source-bar")).not.toContainText(
    /из \d+ запущено|исправен|healthy/i,
  );
  await expect(
    summaryMetric(page, "Антиспам · Rspamd", "Проверено"),
  ).toHaveText("Нет данных");
  await expect(
    summaryMetric(page, "Антиспам · Rspamd", "Отклонено"),
  ).toHaveText("Нет данных");
  await expect(summaryCard(page, "Антиспам · Rspamd")).toContainText(
    "Не поддерживается",
  );
  await expect(
    summaryMetric(page, "Хранилище и квоты", "Заполнение диска vmail"),
  ).toHaveText("Нет данных");
  await expect(
    summaryCard(page, "Хранилище и квоты").getByRole("progressbar"),
  ).toHaveCount(0);
  await expect(
    summaryMetric(page, "Почтовые ящики", "Хранящиеся письма"),
  ).toHaveText("Нет данных");
  await expect(summaryCard(page, "Почтовые ящики")).toContainText("Выключено");
  await expect(
    page.locator(".mailcow-overview").getByText(/карантин|Службы почты/i),
  ).toHaveCount(0);
});

test("disabled and pending groups have no invented business zeros; refresh reads cache only", async ({
  page,
}) => {
  const state = await fixture(page, {
    groups: { mailboxes: { enabled: true, status: "pending" } },
  });
  await open(page);
  await expect(
    page.locator(".mailcow-overview dd").filter({ hasText: /^0(?:\s|$)/ }),
  ).toHaveCount(0);
  await expect(page.locator(".mailcow-overview progress")).toHaveCount(0);
  await collection(page);
  await expect(
    group(page, "Домены и версия").getByText("Выключено", { exact: true }),
  ).toBeVisible();
  await expect(
    group(page, "Почтовые ящики").getByText("Ожидает данных", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".mailcow-groups").getByText("Нет данных", { exact: true }),
  ).toHaveCount(6);
  await expect(
    page.locator(".mailcow-groups dd").filter({ hasText: /^0(?:\s|$)/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: "Домены и версия", exact: true }),
  ).not.toBeChecked();
  const readsBefore = state.reads.filter((path) => path === base).length;
  await page
    .getByRole("button", { name: "Обновить данные", exact: true })
    .click();
  await expect
    .poll(() => state.reads.filter((path) => path === base).length)
    .toBe(readsBefore + 1);
  expect(state.writes).toEqual([]);
  expect(
    state.reads.filter((path) => path.includes("mailcow") && path !== base),
  ).toEqual([]);
});

test("stale group keeps its own last successful values and error timestamp", async ({
  page,
}) => {
  await fixture(page, {
    groups: {
      mailboxes: {
        enabled: true,
        status: "stale",
        stale: true,
        error_code: "timeout",
        last_success_at: "2026-10-30T08:14:00Z",
        last_attempt_at: "2026-10-30T08:25:00Z",
        last_attempt_status: "error",
        data: {
          mailboxes: 3,
          active_mailboxes: 2,
          messages: 6,
          used_bytes: 2048,
        },
      },
    },
  });
  await openCollection(page);
  const panel = group(page, "Почтовые ящики");
  await expect(
    panel.getByText("Данные устарели", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("Истекло время ожидания Mailcow", { exact: true }),
  ).toBeVisible();
  await expect(metric(page, "Почтовые ящики", "Почтовые ящики")).toHaveText(
    "3",
  );
  await expect(metric(page, "Почтовые ящики", "Сообщения")).toHaveText("6");
  await expect(
    metric(page, "Почтовые ящики", "Последний успешный сбор"),
  ).toContainText("11:14");
  await expect(
    metric(page, "Почтовые ящики", "Последняя попытка"),
  ).toContainText("11:25");
  await expect(metric(page, "Почтовые ящики", "Ящики без лимита")).toHaveText(
    "Нет данных",
  );
});

test("successful zero queue and running containers retain their limits; storage stays display-only", async ({
  page,
}) => {
  await fixture(page, {
    groups: {
      queue: {
        enabled: true,
        status: "ok",
        data: {
          messages_observed: 0,
          bytes_observed: 0,
          oldest_observed_age_seconds: 0,
          empty_ambiguous: true,
          by_queue: {},
        },
      },
      services: {
        enabled: true,
        status: "ok",
        data: {
          services: {
            "postfix-mailcow": { state: "running", started_at: 1793347200.123 },
          },
        },
      },
      storage: {
        enabled: true,
        status: "ok",
        data: { used_percent: 69, used_display: "41G", total_display: "60G" },
      },
      rspamd: {
        enabled: true,
        status: "unsupported",
        error_code: "unsupported",
      },
    },
  });
  await open(page);
  await expect(
    summaryMetric(page, "Очередь доставки", "Из них отложено"),
  ).toHaveText("Нет данных");
  await collection(page);
  await expect(metric(page, "Очередь", "Сообщения в ответе")).toHaveText("0");
  await expect(
    group(page, "Очередь").getByText(
      /очередь пуста или внутренний список недоступен/,
    ),
  ).toBeVisible();
  await expect(
    group(page, "Службы").getByRole("cell", { name: "running", exact: true }),
  ).toBeVisible();
  await expect(
    group(page, "Службы").getByText(/не подтверждает готовность приложения/),
  ).toBeVisible();
  await expect(metric(page, "Хранилище", "Занято на диске")).toHaveText("41G");
  await expect(metric(page, "Хранилище", "Заполнено")).toHaveText("69%");
  await expect(
    group(page, "Rspamd").getByText("Не поддерживается", { exact: true }),
  ).toBeVisible();
});

test("settings send every group with current revision and CSRF; later save uses returned revision", async ({
  page,
}) => {
  const state = await fixture(page);
  await openCollection(page);
  await page
    .getByRole("checkbox", { name: "Почтовые ящики", exact: true })
    .check();
  await page
    .getByRole("spinbutton", {
      name: "Почтовые ящики: интервал, с",
      exact: true,
    })
    .fill("120");
  await page
    .getByRole("button", { name: "Сохранить настройки", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Настройки сбора сохранены" }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toEqual({
    path: base + "/settings",
    method: "PUT",
    body: {
      revision: 7,
      groups: Object.fromEntries(
        ids.map((id) => [
          id,
          {
            enabled: id === "mailboxes",
            interval_seconds: id === "mailboxes" ? 120 : 60,
          },
        ]),
      ),
    },
  });
  await page.getByRole("checkbox", { name: "Очередь", exact: true }).check();
  await page
    .getByRole("button", { name: "Сохранить настройки", exact: true })
    .click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1].body.revision).toBe(8);
});

test("revision conflict preserves draft until explicit reload", async ({
  page,
}) => {
  const state = await fixture(page, { saveError: "conflict" });
  await openCollection(page);
  const interval = page.getByRole("spinbutton", {
    name: "Очередь: интервал, с",
    exact: true,
  });
  await interval.fill("180");
  await page
    .getByRole("button", { name: "Сохранить настройки", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Запись уже изменена");
  await expect(interval).toHaveValue("180");
  await expect(
    page.getByRole("button", { name: "Сохранить настройки", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Обновить данные", exact: true })
    .click();
  await expect(interval).toHaveValue("180");
  await page
    .getByRole("button", {
      name: "Загрузить актуальные настройки",
      exact: true,
    })
    .click();
  await expect(interval).toHaveValue("60");
  await interval.fill("120");
  await page
    .getByRole("button", { name: "Сохранить настройки", exact: true })
    .click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1].body.revision).toBe(8);
});

test("failed save keeps draft and reports error without success", async ({
  page,
}) => {
  await fixture(page, { saveError: "server" });
  await openCollection(page);
  const interval = page.getByRole("spinbutton", {
    name: "Домены и версия: интервал, с",
    exact: true,
  });
  await interval.fill("300");
  await page
    .getByRole("button", { name: "Сохранить настройки", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Не удалось сохранить настройки почты",
  );
  await expect(interval).toHaveValue("300");
  await expect(
    page.getByRole("status").filter({ hasText: "Настройки сбора сохранены" }),
  ).toHaveCount(0);
});

test("native Mailcow link uses its own login with no API-key input or browser upstream requests", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const state = await fixture(page);
  await open(page);
  const link = page.getByRole("link", { name: "Открыть Mailcow", exact: true });
  await expect(link).toHaveAttribute("href", nativeURL);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await collection(page);
  await expect(link).toHaveAttribute("href", nativeURL);
  await expect(
    page.getByText(/Нативный интерфейс использует собственный вход Mailcow/),
  ).toBeVisible();
  await expect(
    page.locator('.mailcow-module input[type="password"]'),
  ).toHaveCount(0);
  expect(
    requests.some((url) => new URL(url).hostname === "mail.example.test"),
  ).toBe(false);
  expect(JSON.stringify(state.writes)).not.toContain("secret_ref");
  expect(JSON.stringify(state.writes)).not.toContain("api_key");
});

test("tabs preserve the settings draft, shared notices, native link and cache-only refresh", async ({
  page,
}) => {
  const state = await fixture(page);
  await openCollection(page);
  const interval = page.getByRole("spinbutton", {
    name: "Почтовые ящики: интервал, с",
    exact: true,
  });
  await interval.fill("120");
  await page
    .getByRole("checkbox", { name: "Почтовые ящики", exact: true })
    .check();
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await expect(page.locator(".mailcow-overview > section")).toHaveCount(4);
  await expect(page.locator(".mailcow-groups")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Сохранить настройки", exact: true }),
  ).toHaveCount(0);
  await collection(page);
  await expect(interval).toHaveValue("120");
  await expect(
    page.getByRole("checkbox", { name: "Почтовые ящики", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: "Сохранить настройки", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Настройки сбора сохранены" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Настройки сбора сохранены" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Открыть Mailcow", exact: true }),
  ).toHaveAttribute("href", nativeURL);
  const reads = state.reads.filter((path) => path === base).length;
  await page
    .getByRole("button", { name: "Обновить данные", exact: true })
    .click();
  await expect
    .poll(() => state.reads.filter((path) => path === base).length)
    .toBe(reads + 1);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Сохранённые данные обновлены" }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].path).toBe(base + "/settings");
});

test("cache read failure is an error with retry, never an empty successful card", async ({
  page,
}) => {
  await fixture(page, { readError: true });
  await page.goto(`/#modules?instance=${instanceID}&view=mailcow`);
  await expect(page.getByRole("alert")).toContainText(
    "Данные почты недоступны",
  );
  await expect(page.locator(".mailcow-groups")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Повторить/ })).toBeVisible();
});
