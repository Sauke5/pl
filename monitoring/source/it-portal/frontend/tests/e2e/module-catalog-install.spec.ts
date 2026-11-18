import { expect, test, type Page } from "@playwright/test";

const offers = [
  { id: "forms", name: "Forms", version: "1.0.0" },
  { id: "doska", name: "Doska", version: "2.0.0" },
  { id: "wayline", name: "Wayline", version: "1.1.0" },
  { id: "bookstack", name: "Wiki", version: "26.09.2" },
];

async function fixture(
  page: Page,
  options: {
    missingCatalog?: boolean;
    loseDoskaResponse?: boolean;
    bundled?: boolean;
  } = {},
) {
  let catalogReady = !options.missingCatalog;
  let checks = 0;
  let loseDoskaResponse = options.loseDoskaResponse;
  const writes: Record<string, string>[] = [];
  const accepted = new Map<
    string,
    { instance: Record<string, unknown>; job: Record<string, unknown> }
  >();
  const external = {
    id: "a50d7a77-472b-433f-bd12-985c43b578c0",
    module_id: "bookstack",
    name: "Рабочая Wiki",
    mode: "external",
    observed_state: "running",
    desired_state: "enabled",
    revision: 1,
  };

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const delivery = () => ({
      current_version: "0.8.0",
      latest_version: catalogReady ? "0.8.0" : "",
      update_available: false,
      error: checks === 1 ? "Ошибка проверки подписанного каталога" : "",
      core_api: 1,
      modules: [],
    });
    if (path === "/delivery/check" && request.method() === "POST") {
      catalogReady = ++checks >= 2;
      return route.fulfill({ json: delivery() });
    }
    if (path === "/delivery" && options.bundled) {
      return route.fulfill({
        status: 503,
        json: { error: "delivery_unavailable" },
      });
    }
    if (path === "/modules" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, string>;
      writes.push(body);
      const prior = accepted.get(body.idempotency_key);
      if (prior) return route.fulfill({ status: 202, json: prior });
      const index = accepted.size + 1;
      const id = `a50d7a77-472b-433f-bd12-985c43b578c${index}`;
      const job = {
        id: `job-${body.module_id}`,
        status: "queued",
        parameters: { action: "install" },
      };
      const operation = {
        instance: {
          id,
          name: body.name,
          module_id: body.module_id,
          mode: body.mode,
          observed_state: "pending",
          desired_state: "enabled",
          revision: 1,
          last_job_id: job.id,
        },
        job,
      };
      accepted.set(body.idempotency_key, operation);
      if (body.module_id === "doska" && loseDoskaResponse) {
        loseDoskaResponse = false;
        return route.abort("failed");
      }
      return route.fulfill({ status: 202, json: operation });
    }
    if (path.startsWith("/jobs/job-")) {
      const operation = [...accepted.values()].find(
        ({ job }) => path === `/jobs/${job.id}`,
      );
      return route.fulfill({ json: operation?.job || {} });
    }
    const responses: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "catalog-admin", name: "Admin", admin: true },
        csrf_token: "catalog-csrf",
        features: {},
      },
      "/help-state": { disabled: true, seen: [] },
      "/preferences": {
        favorites: [],
        hidden_sections: [],
        section_order: [],
        home_widgets: [],
      },
      "/delivery": delivery(),
      "/modules": {
        items: [
          external,
          ...[...accepted.values()].map(({ instance }) => instance),
        ],
      },
      "/modules/catalog": {
        local_available: true,
        items: [
          ...offers.map((module) => ({
            ...module,
            description: module.name,
            modes: [
              ...(catalogReady ? ["local"] : []),
              ...(module.id === "bookstack" ? ["external"] : []),
            ],
            version: catalogReady ? module.version : "",
          })),
          {
            id: "mailcow",
            name: "Почта",
            description: "Почтовые ящики и очередь сообщений",
            modes: ["external"],
            version: "",
          },
        ],
      },
    };
    return route.fulfill({ json: responses[path] ?? [] });
  });
  await page.goto("/#module-catalog");
  await expect(
    page.getByRole("heading", { name: "Каталог модулей" }),
  ).toBeVisible();
  return { writes, accepted };
}

async function openSelection(page: Page) {
  await page
    .getByRole("button", { name: "Установить несколько", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Установить несколько модулей" });
}

test("catalog finds modules by product, title and purpose and combines placement with search", async ({
  page,
}) => {
  const f = await fixture(page);
  const search = page.getByRole("searchbox", {
    name: "Поиск по каталогу модулей",
  });
  const placement = page.getByRole("combobox", { name: "Размещение" });
  const cards = page.getByRole("article").getByRole("heading", { level: 3 });
  await expect(cards).toHaveText([
    "Forms",
    "Doska",
    "Wayline",
    "Почта",
    "Wiki",
  ]);

  await search.fill(" ОЧЕРЕДЬ ");
  await expect(cards).toHaveText(["Почта"]);
  await search.fill("mailcow");
  await expect(cards).toHaveText(["Почта"]);
  await placement.selectOption({ label: "На хосте PL" });
  await expect(cards).toHaveCount(0);
  await expect(
    page.getByText("Модули не найдены", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Сбросить фильтры" }).click();
  await expect(search).toBeEmpty();
  await expect(search).toBeFocused();
  await expect(placement).toHaveValue("all");

  await placement.selectOption({ label: "Внешний сервис" });
  await expect(cards).toHaveText(["Почта", "Wiki"]);
  await search.fill("Wiki");
  await expect(cards).toHaveText(["Wiki"]);
  await placement.selectOption({ label: "На хосте PL" });
  await search.fill("BookStack");
  await expect(cards).toHaveText(["Wiki"]);
  const dialog = await openSelection(page);
  await expect(dialog.getByRole("checkbox")).toHaveCount(3);
  await expect(dialog.getByRole("checkbox", { name: /Forms/ })).toBeEnabled();
  expect(f.writes).toHaveLength(0);
});

test("catalog keeps the source error and the empty source distinct from an empty search", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByRole("searchbox", { name: "Поиск по каталогу модулей" })
    .fill("Mailcow");
  let unavailable = true;
  await page.route("**/api/v1/modules/catalog", (route) =>
    unavailable
      ? route.fulfill({
          status: 503,
          json: {
            error: "modules_unavailable",
            message: "Каталог модулей не настроен",
          },
        })
      : route.fulfill({ json: { local_available: true, items: [] } }),
  );
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  const error = page
    .getByRole("alert")
    .filter({ hasText: "Каталог модулей не настроен" });
  await expect(error).toBeVisible();
  const filters = page.getByRole("search", {
    name: "Фильтры каталога модулей",
  });
  await expect(filters).toHaveCount(0);
  unavailable = false;
  await error.getByRole("button", { name: "Повторить" }).click();
  await expect(
    page.getByText("В каталоге пока нет доступных модулей"),
  ).toBeVisible();
  await expect(filters).toHaveCount(0);
  await expect(
    page.getByText("Модули не найдены", { exact: true }),
  ).toHaveCount(0);
});

test("catalog explains missing packages and makes installation available after a successful check", async ({
  page,
}) => {
  await fixture(page, { missingCatalog: true });
  const source = page.getByRole("region", { name: "Каталог установки" });
  await expect(source).toContainText("Каталог установки ещё не загружен");
  await expect(
    source.getByRole("link", { name: "Настроить прокси для GitHub" }),
  ).toHaveAttribute("href", "#settings?section=delivery");
  await expect(
    page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Почта" }) })
      .getByRole("button", { name: "Подключить существующий" }),
  ).toBeEnabled();
  const placement = page.getByRole("combobox", { name: "Размещение" });
  await placement.selectOption({ label: "На хосте PL" });
  await expect(
    page.getByText("Модули не найдены", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Установить несколько" }),
  ).toHaveCount(0);
  await source.getByRole("button", { name: "Проверить каталог" }).click();
  await expect(source).toContainText("Не удалось проверить каталог установки");
  await source.getByRole("button", { name: "Проверить каталог" }).click();
  await expect(source).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Установить несколько" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("article").getByRole("heading", { level: 3 }),
  ).toHaveText(["Forms", "Doska", "Wayline", "Wiki"]);
});

test("one launch queues only the selected new modules and their jobs survive a page reload", async ({
  page,
}) => {
  const f = await fixture(page);
  const dialog = await openSelection(page);
  await expect(dialog.getByRole("checkbox", { name: /Wiki/ })).toHaveCount(0);
  const launch = dialog.getByRole("button", { name: "Запустить установку" });
  await expect(launch).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /Forms/ }).check();
  await dialog.getByRole("checkbox", { name: /Wayline/ }).check();
  await launch.click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Уведомления о действиях" }),
  ).toContainText("Созданы задания на установку Forms, Wayline");
  expect(f.writes.map(({ module_id }) => module_id)).toEqual([
    "forms",
    "wayline",
  ]);
  expect(
    new Set(f.writes.map(({ idempotency_key }) => idempotency_key)).size,
  ).toBe(2);
  expect(f.writes.every(({ mode }) => mode === "local")).toBe(true);
  await page.goto("/#modules");
  await page.reload();
  await expect(
    page.locator(".module-instance").filter({
      has: page.getByRole("heading", { name: "Forms", exact: true }),
    }),
  ).toContainText("Ожидает выполнения");
  await expect(
    page.locator(".module-instance").filter({
      has: page.getByRole("heading", { name: "Wayline", exact: true }),
    }),
  ).toContainText("Ожидает выполнения");
});

test("bundled packages stay installable without the signed delivery service", async ({
  page,
}) => {
  const delivery = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/delivery" &&
      response.status() === 503,
  );
  await fixture(page, { bundled: true });
  await delivery;
  const dialog = await openSelection(page);
  await expect(dialog.getByRole("checkbox", { name: /Forms/ })).toBeEnabled();
  await expect(page.locator(".module-catalog-source")).toHaveCount(0);
});

test("retry reuses the uncertain request key and preserves work already queued", async ({
  page,
}) => {
  const f = await fixture(page, { loseDoskaResponse: true });
  const dialog = await openSelection(page);
  for (const name of ["Forms", "Doska", "Wayline"]) {
    await dialog.getByRole("checkbox", { name: new RegExp(name) }).check();
  }
  const launch = dialog.getByRole("button", { name: "Запустить установку" });
  await launch.click();
  await expect(dialog.getByText("Задание создано")).toBeVisible();
  await expect(
    dialog.getByText("Связь с PL прервалась.", { exact: false }),
  ).toBeVisible();
  await expect(launch).toBeEnabled();
  await expect(dialog.getByRole("checkbox", { name: /Forms/ })).toBeDisabled();
  expect(f.writes.map(({ module_id }) => module_id)).toEqual([
    "forms",
    "doska",
  ]);
  await launch.click();
  await expect(dialog).toHaveCount(0);
  expect(f.writes.map(({ module_id }) => module_id)).toEqual([
    "forms",
    "doska",
    "doska",
    "wayline",
  ]);
  expect(f.writes[2]).toEqual(f.writes[1]);
  expect(f.accepted.size).toBe(3);
});
