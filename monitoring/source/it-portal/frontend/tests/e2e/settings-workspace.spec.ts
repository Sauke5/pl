import { expect, test, type Page } from "@playwright/test";
import { settingsWorkspaceFixture } from "../fixtures/settingsWorkspace";

// UI contract acceptance with an isolated API fixture. Go tests cover database
// transactions, backend permissions and actual provider response validation.
function navigation(page: Page) {
  return page.getByRole("navigation", { name: "Разделы настроек" });
}

async function openGroup(page: Page, group: string) {
  await navigation(page)
    .getByRole("button", { name: group, exact: true })
    .click();
}

async function openIntegration(page: Page) {
  await openGroup(page, "Интеграции");
  await page.getByRole("button", { name: /Основной Prometheus/ }).click();
}

test("overview and search open the relevant setting without changing it", async ({
  page,
}) => {
  const state = await settingsWorkspaceFixture(page);
  await page.goto("/#settings");
  await expect(
    page.getByRole("heading", { name: "Обзор", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Источник временно недоступен")).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Поиск по настройкам" })
    .fill("часовой пояс");
  await page.getByRole("button", { name: /Часовой пояс/ }).click();
  await expect(page.getByLabel("Часовой пояс", { exact: true })).toBeVisible();
  await expect(page.locator('[data-settings-field="timezone"]')).toBeFocused();
  expect(
    state.requests.filter((request) => request.method === "PUT"),
  ).toHaveLength(0);
});

test("integration opens read-only; optional failed draft probe does not block saving", async ({
  page,
}) => {
  const state = await settingsWorkspaceFixture(page);
  await page.goto("/#settings");
  await openIntegration(page);
  await expect(
    page.getByRole("heading", { name: "Основной Prometheus", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Название", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await page
    .getByLabel("Название", { exact: true })
    .fill("Обновлённый Prometheus");
  await page
    .getByRole("button", { name: "Проверить подключение", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Проверка подключения", exact: true })
      .getByRole("status"),
  ).toContainText(state.probeMessage);
  expect(
    state.requests.filter(
      (request) => request.path === "/settings-workspace/probe",
    ),
  ).toHaveLength(1);
  expect(
    state.requests.filter((request) => request.method === "PUT"),
  ).toHaveLength(0);
  await page
    .getByLabel("Название", { exact: true })
    .fill("Проверка после изменения");
  await expect(
    page.getByText(/Результат проверки.*неактуален|Параметры измен/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Проверка после изменения",
      exact: true,
    }),
  ).toBeVisible();
  expect(state.integrations[0].name).toBe("Проверка после изменения");
  expect(
    state.requests.filter((request) => request.path.endsWith("/refresh")),
  ).toHaveLength(0);
});

test("dirty navigation can stay, discard, or save the current group", async ({
  page,
}) => {
  const state = await settingsWorkspaceFixture(page);
  await page.goto("/#settings");
  await openGroup(page, "Общие параметры");
  await page.getByLabel(/Порог устаревания/).fill("240");
  await openGroup(page, "Справочники");
  const prompt = page.getByRole("dialog");
  await expect(prompt).toContainText(/несохранён|Несохранён/);
  await prompt.getByRole("button", { name: /Остаться/ }).click();
  await expect(page.getByLabel(/Порог устаревания/)).toHaveValue("240");
  await openGroup(page, "Справочники");
  await prompt.getByRole("button", { name: /Отбросить/ }).click();
  await expect(
    page.getByRole("heading", { name: "Справочники", exact: true }),
  ).toBeVisible();
  expect(state.settings.stale_after_seconds).toBe(180);
  await openGroup(page, "Общие параметры");
  await expect(page.getByLabel(/Порог устаревания/)).toHaveValue("180");
  await page.getByLabel(/Порог устаревания/).fill("300");
  await openGroup(page, "Справочники");
  await prompt.getByRole("button", { name: /Сохранить/ }).click();
  await expect(
    page.getByRole("heading", { name: "Справочники", exact: true }),
  ).toBeVisible();
  expect(state.settings.stale_after_seconds).toBe(300);
});

test("failed saves preserve the draft and cancel restores the saved values", async ({
  page,
}) => {
  const state = await settingsWorkspaceFixture(page);
  await page.goto("/#settings");
  await openGroup(page, "Общие параметры");
  await page.getByLabel(/Порог устаревания/).fill("240");
  for (const status of [400, 500]) {
    state.failNext(
      "/settings-workspace/general",
      status,
      `Не удалось сохранить параметры (${status})`,
    );
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      `Не удалось сохранить параметры (${status})`,
    );
    await expect(page.getByLabel(/Порог устаревания/)).toHaveValue("240");
    expect(state.settings.stale_after_seconds).toBe(180);
  }
  await page
    .getByRole("button", { name: "Отменить изменения", exact: true })
    .click();
  await expect(page.getByLabel(/Порог устаревания/)).toHaveValue("180");
});

test("revision conflict keeps local edits and shows the current values for comparison", async ({
  page,
}) => {
  const state = await settingsWorkspaceFixture(page);
  await page.goto("/#settings");
  await openGroup(page, "Общие параметры");
  await page.getByLabel(/Порог устаревания/).fill("240");
  state.changeGeneral({ stale_after_seconds: 360 });
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(
    page.getByText(
      /Запись изменилась|Настройки изменены другим администратором/,
    ),
  ).toBeVisible();
  await expect(page.getByLabel(/Порог устаревания/)).toHaveValue("240");
  await expect(page.getByText("360", { exact: true })).toBeVisible();
  expect(state.settings.stale_after_seconds).toBe(360);
  const comparison = page.getByRole("region", { name: "Конфликт изменений" });
  await comparison.getByRole("radio", { name: "240", exact: true }).check();
  await comparison
    .getByRole("button", {
      name: "Применить выбранное к черновику",
      exact: true,
    })
    .click();
  expect(state.settings.stale_after_seconds).toBe(360);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText("Сохранено", { exact: true })).toBeVisible();
  expect(state.settings.stale_after_seconds).toBe(240);
});

test("history shows actor and before/after values without a rollback action", async ({
  page,
}) => {
  const state = await settingsWorkspaceFixture(page);
  state.history.push({
    id: "history-legacy",
    kind: "settings",
    object_id: "global",
    object_name: "Общие параметры",
    action: "updated",
    actor: "legacy-admin",
    actor_name: "Предыдущий администратор",
    created_at: "2026-10-25T08:30:00Z",
    revision: 3,
    detailed: false,
    changes: [],
  });
  await page.goto("/#settings");
  await openGroup(page, "Общие параметры");
  await page.getByRole("button", { name: "История", exact: true }).click();
  await expect(
    page.getByText("Алексей Администратор", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("120", { exact: true })).toBeVisible();
  await expect(page.getByText("180", { exact: true })).toBeVisible();
  await expect(
    page.getByText("В этой записи сохранены автор, время и факт изменения.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /Откатить|Восстановить версию|Вернуть версию/,
    }),
  ).toHaveCount(0);
});

test("publication access expansion is confirmed and general save preserves publication", async ({
  page,
}) => {
  const state = await settingsWorkspaceFixture(page);
  await page.goto("/#settings");
  await openGroup(page, "Общие параметры");
  const publication = {
    board_enabled: state.settings.board_enabled,
    board_anonymous: state.settings.board_anonymous,
    board_title: state.settings.board_title,
    board_resource_ids: [...state.settings.board_resource_ids],
  };
  await page.getByLabel(/Порог устаревания/).fill("240");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText("Сохранено", { exact: true })).toBeVisible();
  expect(state.settings).toMatchObject(publication);
  const payload = state.requests.find(
    (request) =>
      request.method === "PUT" &&
      request.path === "/settings-workspace/general",
  )!.body!;
  expect(payload).not.toHaveProperty("board_enabled");
  expect(payload).not.toHaveProperty("board_anonymous");
  await openGroup(page, "Публикация");
  await page.getByRole("checkbox", { name: /анонимный доступ/ }).check();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  const confirmation = page.getByRole("dialog");
  await expect(confirmation).toBeVisible();
  expect(state.settings.board_anonymous).toBe(false);
  await confirmation
    .getByRole("button", { name: /Подтвердить|Сохранить|Разрешить/ })
    .click();
  await expect(confirmation).toHaveCount(0);
  expect(state.settings.board_anonymous).toBe(true);
  expect(state.settings.stale_after_seconds).toBe(240);
});

test("invalid integration field is identified without posting the draft", async ({
  page,
}) => {
  const state = await settingsWorkspaceFixture(page);
  await page.goto("/#settings");
  await openIntegration(page);
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await page.getByLabel(/Параллелизм/).fill("5");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByLabel(/Параллелизм/)).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(
    state.requests.filter((request) => request.method === "PUT"),
  ).toHaveLength(0);
});

test("new integration selects the returned ID even when another source has the same name and URL", async ({
  page,
}) => {
  const state = await settingsWorkspaceFixture(page);
  await page.goto("/#settings");
  await openGroup(page, "Интеграции");
  await page
    .getByRole("button", { name: "Добавить подключение", exact: true })
    .click();
  await page
    .getByLabel("Название", { exact: true })
    .fill("Основной Prometheus");
  await page
    .getByLabel("Базовый URL", { exact: true })
    .fill("https://metrics.example.test");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page).toHaveURL(/integration=integration-new/);
  await expect(
    page
      .getByRole("region", { name: "Подключение", exact: true })
      .getByRole("heading", { name: "Основной Prometheus", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Название", { exact: true })).toHaveCount(0);
  expect(state.integrations).toHaveLength(3);
  expect(
    state.integrations.find((item) => item.id === "integration-new")?.revision,
  ).toBe(1);
  expect(
    state.integrations.find((item) => item.id === "prometheus-main")?.revision,
  ).toBe(3);
});

test("search opens and highlights a connection parameter without entering edit mode", async ({
  page,
}) => {
  const state = await settingsWorkspaceFixture(page);
  await page.goto("/#settings");
  await page
    .getByRole("searchbox", { name: "Поиск по настройкам" })
    .fill("Таймаут Основной Prometheus");
  await page
    .getByRole("button", { name: /Таймаут.*Основной Prometheus/ })
    .click();
  await expect(page).toHaveURL(/integration=prometheus-main/);
  const field = page.locator('[data-settings-field="timeout_seconds"]');
  await expect(field).toBeVisible();
  await expect(field).toBeFocused();
  await expect(field).toContainText("10 с");
  await expect(page.getByLabel("Название", { exact: true })).toHaveCount(0);
  expect(
    state.requests.filter((request) => request.method === "PUT"),
  ).toHaveLength(0);
});

test("main shell navigation can stay, discard, or save the dirty settings draft", async ({
  page,
}) => {
  const state = await settingsWorkspaceFixture(page);
  await page.goto("/#settings");
  await openGroup(page, "Общие параметры");
  await page.getByLabel(/Порог устаревания/).fill("240");
  const home = page
    .getByRole("navigation", { name: "Основная навигация" })
    .getByRole("link", { name: "Главная", exact: true });
  await home.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Остаться", exact: true })
    .click();
  await expect(page).toHaveURL(/#settings/);
  await expect(page.getByLabel(/Порог устаревания/)).toHaveValue("240");
  await home.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Отбросить", exact: true })
    .click();
  await expect(page).toHaveURL(/#home$/);
  await expect(page.locator("[data-settings-workspace]")).toHaveCount(0);
  expect(state.settings.stale_after_seconds).toBe(180);
  expect(
    state.requests.filter((request) => request.method === "PUT"),
  ).toHaveLength(0);
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await openGroup(page, "Общие параметры");
  await page.getByLabel(/Порог устаревания/).fill("300");
  await home.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await expect(page).toHaveURL(/#home$/);
  expect(state.settings.stale_after_seconds).toBe(300);
  expect(
    state.requests.filter(
      (request) =>
        request.method === "PUT" &&
        request.path === "/settings-workspace/general",
    ),
  ).toHaveLength(1);
});

for (const viewport of [{ width: 1920, height: 1080 }]) {
  for (const theme of ["dark", "light"]) {
    test(`desktop ${viewport.width} ${theme}: list scroll and selection survive editing`, async ({
      page,
      browserName,
    }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(
        (value) => localStorage.setItem("pl-ui-theme", value),
        theme,
      );
      await settingsWorkspaceFixture(page, { manyIntegrations: true });
      await page.goto("/#settings");
      await expect(
        page.getByRole("heading", { name: "Обзор", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Публикация", exact: true }),
      ).toBeInViewport();
      await expect(
        page.getByRole("heading", { name: "Общие параметры", exact: true }),
      ).toBeInViewport();
      const evidence = process.env.SETTINGS_UI_EVIDENCE;
      if (evidence)
        await page.screenshot({
          path: `${evidence}/${browserName}-${viewport.width}-${theme}-overview.png`,
        });
      await openGroup(page, "Интеграции");
      const source = page.getByRole("button", {
        name: /Источник 30 · длинное название площадки/,
      });
      await source.click();
      await expect(source).toHaveAttribute("aria-pressed", "true");
      if (evidence)
        await page.screenshot({
          path: `${evidence}/${browserName}-${viewport.width}-${theme}-integration.png`,
        });
      const list = page.getByRole("region", {
        name: "Подключения",
        exact: true,
      });
      const scroll = await list.evaluate((element) => element.scrollTop);
      expect(scroll).toBeGreaterThan(0);
      await page.getByRole("button", { name: "Изменить", exact: true }).click();
      await expect(page.getByLabel("Название", { exact: true })).toHaveValue(
        "Источник 30 · длинное название площадки",
      );
      await page
        .getByLabel("Название", { exact: true })
        .fill("Название в черновике");
      await expect
        .poll(() => list.evaluate((element) => element.scrollTop))
        .toBe(scroll);
      await page
        .getByRole("button", { name: "Отменить изменения", exact: true })
        .click();
      await expect(source).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByLabel("Название", { exact: true })).toHaveValue(
        "Источник 30 · длинное название площадки",
      );
      await expect
        .poll(() => list.evaluate((element) => element.scrollTop))
        .toBe(scroll);
      const geometry = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });
  }
}
