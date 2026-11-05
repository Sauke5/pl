import { expect, test, type Page } from "@playwright/test";

const ids = Array.from(
  { length: 6 },
  (_, index) => `123e4567-e89b-42d3-a456-42661417400${index}`,
);

async function fixture(page: Page, operationRunning = false) {
  const timestamp = new Date().toISOString();
  const common = {
    revision: 1,
    mode: "local",
    desired_state: "enabled",
    observed_state: "running",
    version: "1.0.0",
    last_attempt: timestamp,
    last_success: timestamp,
  };
  const items = [
    {
      ...common,
      id: ids[0],
      module_id: "prometheus",
      name: "Метрики офиса",
      endpoint: "http://pl-prometheus:9090",
      targets_total: 4,
      targets_up: 3,
      integration_id: "integration-metrics",
      resource_id: "resource-metrics",
    },
    {
      ...common,
      id: ids[1],
      module_id: "xray",
      name: "Прокси офиса",
      last_job_id: "configuration-job",
    },
    {
      ...common,
      id: ids[2],
      module_id: "wayline",
      name: "Филиал",
      mode: "external",
      observed_state: "unavailable",
      endpoint: "https://branch.example.org",
      error: "Нет ответа Wayline",
    },
    {
      ...common,
      id: ids[3],
      module_id: "grafana",
      name: "Дашборды",
      desired_state: "disabled",
      observed_state: "disabled",
    },
    {
      ...common,
      id: ids[4],
      module_id: "mailcow",
      name: "Корпоративная почта",
      mode: "external",
      endpoint: "https://mail.example.org",
    },
    { ...common, id: ids[5], module_id: "bookstack", name: "База знаний" },
  ];
  const actions: Record<string, unknown>[] = [];
  const logins: unknown[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (request.method() === "POST" && path.endsWith("/actions")) {
      actions.push(request.postDataJSON());
      return route.fulfill({
        status: 503,
        json: { error: "fixture_stop", message: "Операция не выполнена" },
      });
    }
    if (request.method() === "POST" && path.endsWith("/initial-login")) {
      logins.push(request.postDataJSON());
      return route.fulfill({
        json: {
          instance_id: ids[5],
          module_id: "bookstack",
          service: "bookstack",
          username: "admin@pl.invalid",
          password: "fixture-only",
          path: "/wiki/login",
        },
      });
    }
    const responses: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "admin", name: "Admin", admin: true },
        csrf_token: "fixture-csrf",
        features: {},
      },
      "/help-state": { disabled: true, seen: [] },
      "/preferences": {
        favorites: [],
        hidden_sections: [],
        section_order: [],
        home_widgets: [],
      },
      "/chart-settings": { revision: 1, charts: [] },
      "/modules": { items },
      "/modules/catalog": { local_available: true, items: [] },
      "/jobs/configuration-job": {
        id: "configuration-job",
        status: operationRunning ? "running" : "failed",
        parameters: { action: "configure" },
        created_at: timestamp,
        started_at: timestamp,
        finished_at: operationRunning ? undefined : timestamp,
        error: operationRunning ? undefined : "Черновик не прошёл проверку",
      },
    };
    return route.fulfill({ json: responses[path] ?? [] });
  });
  await page.goto("/#modules");
  await expect(page.locator(".module-instance")).toHaveCount(items.length);
  return { actions, logins };
}

test("installed modules show real totals, problem ordering and independent filters", async ({
  page,
}) => {
  await fixture(page);
  await expect(
    page.getByRole("heading", { level: 1, name: "Подключённые модули" }),
  ).toBeVisible();
  const summary = page.getByLabel("Сводка модулей");
  await expect(page.locator(".module-heading-count")).toHaveText("6");
  await expect(
    summary.locator('[data-module-summary="running"]'),
  ).toContainText("3Работают");
  await expect(
    summary.locator('[data-module-summary="attention"]'),
  ).toContainText("1Требуют внимания");
  await expect(
    summary.locator('[data-module-summary="registered"]'),
  ).toContainText("1Подключение добавлено");
  await expect(page.locator(".module-instance").first()).toHaveAttribute(
    "id",
    `module-${ids[2]}`,
  );
  await page
    .getByLabel("Поиск модулей", { exact: true })
    .fill("branch.example.org");
  await expect(page.locator(".module-instance")).toHaveCount(1);
  await expect(page.locator(".module-instance")).toContainText("Филиал");
  await page.getByLabel("Поиск модулей", { exact: true }).fill("");
  await page.getByLabel("Размещение модуля").selectOption("external");
  await expect(page.locator(".module-instance")).toHaveCount(2);
  await page.getByLabel("Состояние модуля").selectOption("problems");
  await expect(page.locator(".module-instance")).toHaveCount(1);
  await page.getByLabel("Размещение модуля").selectOption("local");
  await expect(
    page.getByText("Модули не найдены", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Сбросить фильтры" }).click();
  await page.getByLabel("Сортировка модулей").selectOption("name");
  await expect(page.locator(".module-instance").first()).toContainText(
    "База знаний",
  );
  await page.getByLabel("Состояние модуля").selectOption("disabled");
  await expect(page.locator(".module-instance")).toHaveCount(1);
  await expect(page.locator(".module-instance")).toContainText("Дашборды");
  await page.getByLabel("Состояние модуля").selectOption("registered");
  await expect(page.locator(".module-instance")).toHaveCount(1);
  await expect(page.locator(".module-instance")).toContainText(
    "Корпоративная почта",
  );
  await page.getByLabel("Состояние модуля").selectOption("running");
  await expect(page.locator(".module-instance")).toHaveCount(3);
  await expect(page.locator(`#module-${ids[4]}`)).toHaveCount(0);
});

test("operation failure preserves running state and details expose real links and data", async ({
  page,
}) => {
  await fixture(page);
  const xray = page.locator(`#module-${ids[1]}`);
  await expect(xray.locator(".module-card-state")).toContainText("Работает");
  await expect(xray.locator(".module-card-operation")).toContainText(
    "Черновик не прошёл проверку",
  );
  await expect(
    page.locator(`#module-${ids[4]} .module-card-state .status-info`),
  ).toHaveText("Подключение добавлено");
  await expect(
    xray.getByRole("link", { name: "Управлять прокси" }),
  ).toHaveAttribute("href", `#proxy?instance=${ids[1]}`);
  const prometheus = page.locator(`#module-${ids[0]}`);
  await expect(
    prometheus.getByRole("link", { name: "Мониторинг", exact: true }),
  ).toHaveAttribute("href", `#monitoring?instance=${ids[0]}`);
  await expect(
    prometheus.getByRole("link", { name: "Мониторинг", exact: true }),
  ).not.toHaveAttribute("target", "_blank");
  await prometheus
    .getByRole("button", { name: "Подробнее", exact: true })
    .click();
  const details = page.getByRole("dialog", {
    name: "Метрики офиса",
    exact: true,
  });
  await expect(details).toContainText("http://pl-prometheus:9090");
  await expect(details).toContainText("3 / 4");
  await expect(
    details.getByRole("link", { name: "Интеграция", exact: true }),
  ).toHaveAttribute("href", "#settings?integration=integration-metrics");
  await expect(
    details.getByRole("link", { name: "Ресурс в каталоге" }),
  ).toHaveAttribute("href", "#catalog?resource=resource-metrics");
  await details.getByRole("button", { name: "Закрыть панель" }).click();
  await expect(details).toHaveCount(0);
});

test("action menu supports keyboard and preserves exact-name removal confirmation", async ({
  page,
}) => {
  const { actions } = await fixture(page);
  const card = page.locator(`#module-${ids[0]}`);
  const trigger = card.getByRole("button", {
    name: "Действия: Метрики офиса",
    exact: true,
  });
  await trigger.click();
  await expect(
    card.getByRole("menuitem", { name: "Проверить", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(card.getByRole("menu")).toHaveCount(0);
  await trigger.click();
  await card.getByRole("menuitem", { name: "Удалить", exact: true }).click();
  const confirm = page.getByRole("dialog", {
    name: "Удалить «Метрики офиса»?",
    exact: true,
  });
  const remove = confirm.getByRole("button", {
    name: "Удалить полностью",
    exact: true,
  });
  await expect(remove).toBeDisabled();
  await confirm.getByLabel("Введите название: Метрики офиса").fill("wrong");
  await expect(remove).toBeDisabled();
  await confirm
    .getByLabel("Введите название: Метрики офиса")
    .fill("Метрики офиса");
  await remove.click();
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]).toMatchObject({
    action: "remove",
    confirm_name: "Метрики офиса",
  });
});

for (const item of [
  { name: "Проверить", action: "refresh" },
  { name: "Отключить", action: "disable" },
]) {
  test(`action menu keeps ${item.action} available through a pointer click`, async ({
    page,
  }) => {
    const { actions } = await fixture(page);
    const card = page.locator(`#module-${ids[0]}`);
    await card.getByRole("button", { name: "Действия: Метрики офиса" }).click();
    const menu = card.getByRole("menu");
    const target = menu.getByRole("menuitem", { name: item.name, exact: true });
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    try {
      await expect(menu).toBeVisible();
      expect(actions).toEqual([]);
    } finally {
      await page.mouse.up();
    }
    await expect.poll(() => actions.length).toBe(1);
    expect(actions[0]).toMatchObject({ action: item.action });
    await expect(menu).toHaveCount(0);
  });
}

test("action menu survives card focus moving before pointer release", async ({
  page,
}) => {
  const { actions } = await fixture(page);
  const card = page.locator(`#module-${ids[0]}`);
  await card.getByRole("button", { name: "Действия: Метрики офиса" }).click();
  const menu = card.getByRole("menu");
  const target = menu.getByRole("menuitem", { name: "Отключить", exact: true });
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  try {
    // A pointer click may move focus to the card instead of its button.
    await card.focus();
    await expect(card).toBeFocused();
    await expect(menu).toBeVisible();
    expect(actions).toEqual([]);
  } finally {
    await page.mouse.up();
  }
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]).toMatchObject({ action: "disable" });
});

test("action menu closes with Tab and an outside pointer click", async ({
  page,
}) => {
  const { actions } = await fixture(page);
  const card = page.locator(`#module-${ids[0]}`);
  const trigger = card.getByRole("button", {
    name: "Действия: Метрики офиса",
    exact: true,
  });
  await trigger.click();
  await page.keyboard.press("Tab");
  await expect(card.getByRole("menu")).toHaveCount(0);
  await expect(
    card.getByRole("link", { name: "Мониторинг", exact: true }),
  ).toBeFocused();
  await trigger.click();
  await page
    .getByRole("heading", { level: 1, name: "Подключённые модули" })
    .click();
  await expect(card.getByRole("menu")).toHaveCount(0);
  expect(actions).toEqual([]);
});

test("active operation disables lifecycle menu without changing service status", async ({
  page,
}) => {
  await fixture(page, true);
  const card = page.locator(`#module-${ids[1]}`);
  await expect(card.locator(".module-card-state")).toContainText("Работает");
  await expect(card.locator(".module-card-operation")).toBeVisible();
  await card.getByRole("button", { name: "Действия: Прокси офиса" }).click();
  for (const name of ["Проверить", "Отключить", "Удалить"])
    await expect(
      card.getByRole("menuitem", { name, exact: true }),
    ).toBeDisabled();
});

test("details first-login remains explicit and closes without storing credentials", async ({
  page,
}) => {
  const { logins } = await fixture(page);
  await page
    .locator(`#module-${ids[5]}`)
    .getByRole("button", { name: "Подробнее", exact: true })
    .click();
  const details = page.getByRole("dialog", {
    name: "База знаний",
    exact: true,
  });
  await expect(
    details.getByRole("button", { name: "Первоначальный вход", exact: true }),
  ).toBeVisible();
  expect(logins).toEqual([]);
  await details
    .getByRole("button", { name: "Первоначальный вход", exact: true })
    .click();
  const login = page.getByRole("dialog", { name: "Первый вход", exact: true });
  await expect(login).toBeVisible();
  expect(logins).toEqual([{ service: "bookstack" }]);
  await login.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(login).toHaveCount(0);
  await details.getByRole("button", { name: "Закрыть панель" }).click();
  expect(
    await page.evaluate(() =>
      JSON.stringify([
        Object.entries(localStorage),
        Object.entries(sessionStorage),
      ]),
    ),
  ).not.toContain("fixture-only");
});

test("module cards reflow from three columns to two and one", async ({
  page,
}, testInfo) => {
  await fixture(page);
  for (const [width, columns] of [
    [1600, 3],
    [1100, 2],
    [700, 1],
  ] as const) {
    await page.setViewportSize({ width, height: 950 });
    const grid = page.locator(".module-instances");
    await expect
      .poll(() =>
        grid.evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(" ").length,
        ),
      )
      .toBe(columns);
    await grid.screenshot({
      path: testInfo.outputPath(`modules-${columns}-columns.png`),
    });
  }
});

test("native navigation uses real routes and never manufactures an Auditor URL", async ({
  page,
}) => {
  await fixture(page);
  const timestamp = new Date().toISOString();
  const common = {
    revision: 1,
    mode: "local",
    desired_state: "enabled",
    observed_state: "running",
    version: "1.0.0",
    last_attempt: timestamp,
    last_success: timestamp,
  };
  const items = [
    { ...common, id: ids[0], module_id: "netmap", name: "Карта офиса" },
    { ...common, id: ids[1], module_id: "sftpgo", name: "Обмен файлами" },
    {
      ...common,
      id: ids[2],
      module_id: "fileauditor",
      name: "Аудит сервера",
      mode: "external",
      endpoint: "https://auditor.example.org/",
      integration_id: "auditor-integration",
    },
    { ...common, id: ids[3], module_id: "grafana", name: "Дашборды" },
  ];
  await page.route("**/api/v1/modules", (route) =>
    route.fulfill({ json: { items } }),
  );
  await page.reload();
  for (const [id, label, href] of [
    [ids[0], "Открыть карту", "/netmap/"],
    [ids[1], "Открыть файлы", "/sftpgo/"],
    [ids[3], "Открыть Grafana", "/grafana/"],
  ] as const) {
    const link = page
      .locator(`#module-${id}`)
      .getByRole("link", { name: label, exact: true });
    await expect(link).toHaveAttribute("href", href);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  await page
    .locator(`#module-${ids[0]}`)
    .getByRole("button", { name: "Подробнее", exact: true })
    .click();
  const mapDetails = page.getByRole("dialog", {
    name: "Карта офиса",
    exact: true,
  });
  await expect(
    mapDetails.getByRole("link", { name: "Настроить сети", exact: true }),
  ).toHaveAttribute("href", `#modules?instance=${ids[0]}&view=netmap`);
  await mapDetails.getByRole("button", { name: "Закрыть панель" }).click();
  await page
    .locator(`#module-${ids[1]}`)
    .getByRole("button", { name: "Подробнее", exact: true })
    .click();
  const fileDetails = page.getByRole("dialog", {
    name: "Обмен файлами",
    exact: true,
  });
  await expect(
    fileDetails.getByRole("link", { name: "Управлять SFTPGo", exact: true }),
  ).toHaveAttribute("href", `#files?instance=${ids[1]}`);
  await fileDetails.getByRole("button", { name: "Закрыть панель" }).click();

  for (const [endpoint, href] of [
    ["https://auditor.example.org/", ""],
    ["https://auditor.example.org//foreign.example/", ""],
    ["https://auditor.example.org/audit", "/audit/"],
    ["https://auditor.example.org/audit-arch/", "/audit-arch/"],
  ] as const) {
    Object.assign(items[2], { endpoint });
    await page.reload();
    const card = page.locator(`#module-${ids[2]}`);
    if (href)
      await expect(
        card.getByRole("link", { name: "Открыть File Auditor", exact: true }),
      ).toHaveAttribute("href", href);
    else
      await expect(
        card.getByRole("link", { name: "Открыть File Auditor", exact: true }),
      ).toHaveCount(0);
    await card.getByRole("button", { name: "Подробнее", exact: true }).click();
    const details = page.getByRole("dialog", {
      name: "Аудит сервера",
      exact: true,
    });
    await expect(details).toContainText(endpoint);
    if (href)
      await expect(
        details.getByRole("link", {
          name: "Открыть File Auditor",
          exact: true,
        }),
      ).toHaveAttribute("href", href);
    else
      await expect(
        details.getByRole("link", {
          name: "Открыть File Auditor",
          exact: true,
        }),
      ).toHaveCount(0);
    await details.getByRole("button", { name: "Закрыть панель" }).click();
  }
  Object.assign(items[2], {
    endpoint: "https://auditor.example.org/audit",
    integration_id: "",
  });
  await page.reload();
  await expect(page.locator(`#module-${ids[2]}`)).toBeVisible();
  await expect(
    page
      .locator(`#module-${ids[2]}`)
      .getByRole("link", { name: "Открыть File Auditor", exact: true }),
  ).toHaveCount(0);
});
