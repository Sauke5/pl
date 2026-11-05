import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

test.beforeEach(({}, info) => {
  test.skip(
    info.config.metadata.workspaceFixture !== true,
    "Requires playwright.workspace.config.ts and the opt-in Go fixture",
  );
});

const fixtureURL = "http://localhost:18182";
async function login(page: Page, user = "alice") {
  await page.route("**/api/v1/help-state", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { disabled: true, seen: [] } })
      : route.continue(),
  );
  await expect(
    await page.request.post(`${fixtureURL}/fixture/login?user=${user}`),
  ).toBeOK();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Моё рабочее пространство" }),
  ).toBeVisible();
}

test("system editor uses real PG persistence, source preview, personal star and groups", async ({
  page,
  browser,
}, info) => {
  await login(page);
  const name = `Ферма приёмки ${randomUUID().slice(0, 8)}`;
  await page.goto("/#catalog?kind=systems");
  await page
    .getByRole("button", { name: "Добавить систему", exact: true })
    .first()
    .click();
  const editor = page.getByRole("dialog", {
    name: "Добавить систему",
    exact: true,
  });
  await editor.getByLabel("Название", { exact: true }).fill(name);
  await editor.getByLabel("Необязательный шаблон").selectOption("rds");
  await editor
    .getByRole("button", { name: "Добавить показатели шаблона" })
    .click();
  await editor.getByRole("checkbox", { name: /^RDSH-проверка/ }).check();
  const binding = editor.locator(".workspace-binding").filter({
    has: page.locator(".workspace-binding-heading strong", {
      hasText: "Доступная память RDS",
    }),
  });
  await binding
    .getByLabel("Источник Prometheus")
    .selectOption("workspace-prom");
  await binding.getByRole("button", { name: "Добавить условие" }).click();
  await binding
    .getByLabel("Значение условия instance", { exact: true })
    .fill("RDSH-test:9182");
  await editor.getByRole("button", { name: "Проверить показатели" }).click();
  await expect(editor.locator(".workspace-editor-preview")).toContainText(
    "4 ГиБ",
  );
  await editor
    .getByRole("button", { name: "Показать подсказки", exact: true })
    .click();
  await expect(page.locator(".help-coach")).toHaveAttribute(
    "data-help-topic",
    "system-editor",
  );
  await page
    .locator(".help-coach")
    .screenshot({ path: info.outputPath("system-editor-help.png") });
  await page
    .locator(".help-coach")
    .getByRole("button", { name: "Понятно", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/v1/help-state")).json()).seen,
    )
    .toContain("system-editor");
  await editor.getByRole("button", { name: "Сохранить систему" }).click();
  await expect(editor).toBeHidden();
  const card = page
    .locator(".workspace-system-card")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
  await card
    .getByRole("button", { name: `Добавить на главную: ${name}`, exact: true })
    .click();
  await expect(
    card.getByRole("button", {
      name: `Убрать с главной: ${name}`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Главная", exact: true })
    .click();
  await expect(page.locator('[data-layout-tile="systems"]')).toContainText(
    name,
  );
  await expect(page.locator('[data-layout-tile="systems"]')).toContainText(
    "4 ГиБ",
  );
  await page
    .getByRole("button", { name: "Настроить главную", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Добавить группу", exact: true })
    .click();
  const group = page.getByRole("dialog", {
    name: "Добавить группу закреплений",
  });
  const groupName = `Рабочее ${randomUUID().slice(0, 6)}`;
  await group.getByLabel("Название группы").fill(groupName);
  await expect(
    group.getByRole("checkbox", { name: /^RDSH-проверка/ }),
  ).toHaveCount(0);
  await group.getByRole("checkbox", { name: /^RDS — панель/ }).check();
  await group.getByRole("button", { name: "Сохранить группу" }).click();
  await expect(group).toBeHidden();
  const groupTile = page
    .locator('[data-layout-tile^="favorite-group_"]')
    .filter({
      has: page.getByRole("heading", { name: groupName, exact: true }),
    });
  await expect(groupTile).toContainText("RDS — панель");
  await page.screenshot({ path: info.outputPath("home-layout-editor.png") });
  const initialGroupWidth = await groupTile.evaluate(
    (node) => node.getBoundingClientRect().width,
  );
  await page
    .getByRole("button", { name: `Изменить размер: ${groupName}`, exact: true })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      groupTile.evaluate((node) => node.getBoundingClientRect().width),
    )
    .toBeGreaterThan(initialGroupWidth);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await groupTile
    .getByRole("button", { name: `Свернуть группу ${groupName}` })
    .click();
  await expect(
    groupTile.getByText("Ресурсов: 1", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Добавить группу", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("home-with-system.png") });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: groupName, exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-layout-tile="systems"]')).toContainText(
    name,
  );
  const other = await browser.newContext();
  const bob = await other.newPage();
  await login(bob, "bob");
  await expect(
    bob.getByRole("heading", { name: groupName, exact: true }),
  ).toHaveCount(0);
  await expect(bob.locator('[data-layout-tile="systems"]')).toHaveCount(0);
  await bob.goto("/#catalog?kind=systems");
  await expect(bob.getByRole("heading", { name, exact: true })).toBeVisible();
  await other.close();
});

test("custom system saves without metrics and retains an incomplete source binding", async ({
  page,
}) => {
  await login(page);
  await page.goto("/#catalog?kind=systems");
  await page
    .getByRole("button", { name: "Добавить систему", exact: true })
    .first()
    .click();
  let editor = page.getByRole("dialog", {
    name: "Добавить систему",
    exact: true,
  });
  const name = `Своя система ${randomUUID().slice(0, 8)}`;
  await editor.getByLabel("Название", { exact: true }).fill(name);
  await expect(editor.getByLabel("Необязательный шаблон")).toHaveValue(
    "custom",
  );
  await editor.getByRole("button", { name: "Сохранить систему" }).click();
  await expect(editor).toBeHidden();
  let saved = (await (await page.request.get("/api/v1/systems")).json()).find(
    (system: { name: string }) => system.name === name,
  );
  expect(saved.profile).toBe("custom");
  expect(saved.metrics).toEqual([]);

  await page
    .getByRole("button", { name: "Добавить систему", exact: true })
    .first()
    .click();
  editor = page.getByRole("dialog", { name: "Добавить систему", exact: true });
  const incompleteName = `${name} — позже`;
  await editor.getByLabel("Название", { exact: true }).fill(incompleteName);
  await editor
    .getByRole("combobox", {
      name: "Источник для новых показателей",
      exact: true,
    })
    .selectOption("workspace-prom");
  await editor
    .getByRole("combobox", { name: "Добавить показатель", exact: true })
    .selectOption("linux.memory");
  await editor.getByRole("button", { name: "Добавить", exact: true }).click();
  await editor
    .getByRole("button", { name: "Проверить показатели", exact: true })
    .click();
  await expect(editor.locator(".workspace-editor-preview")).toContainText(
    "Показатель не подключён",
  );
  await editor.getByRole("button", { name: "Сохранить систему" }).click();
  await expect(editor).toBeHidden();
  saved = (await (await page.request.get("/api/v1/systems")).json()).find(
    (system: { name: string }) => system.name === incompleteName,
  );
  expect(saved.metrics).toHaveLength(1);
  expect(saved.metrics[0].integration_id).toBe("workspace-prom");
  expect(saved.metrics[0].labels).toEqual({});
});

test("background manual check preserves address and shows author in operations", async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole("button", { name: "Проверить адрес", exact: true })
    .click();
  const panel = page.getByRole("dialog", {
    name: "Проверка адреса",
    exact: true,
  });
  await panel.getByRole("textbox").fill("check.example.test:443");
  await panel.getByRole("button", { name: "TCP", exact: true }).click();
  await expect(panel.getByRole("textbox")).toHaveValue(
    "check.example.test:443",
  );
  await panel
    .getByRole("button", { name: "Запустить проверку", exact: true })
    .click();
  await expect(panel).toContainText("Состояние сохранено");
  const operations = await (
    await page.request.get("/api/v1/operations")
  ).json();
  const operation = operations.find(
    (item: { parameters: { target?: string } }) =>
      item.parameters.target === "check.example.test:443",
  );
  expect(operation.actor_name).toBe("Алексей");
  await panel
    .getByRole("button", { name: "Закрыть панель", exact: true })
    .click();
  await expect(
    await page.request.post(`${fixtureURL}/fixture/complete`, {
      data: { id: operation.id },
    }),
  ).toBeOK();
  await expect(
    page.getByRole("status").filter({ hasText: "Проверка завершена" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Открыть результат", exact: true })
    .click();
  await expect(panel).toContainText("Порт принимает соединения");
  await panel
    .getByRole("button", { name: "Закрыть панель", exact: true })
    .click();
  await page.goto("/#events");
  await page.getByRole("button", { name: "Операции", exact: true }).click();
  await expect(page.locator(".workspace-operation-list")).toContainText(
    "Алексей",
  );
  await page
    .locator(".workspace-operation-row")
    .filter({ hasText: "check.example.test:443" })
    .first()
    .click();
  await expect(page.locator(".workspace-operation-result")).toContainText(
    "Порт принимает соединения",
  );
  await page
    .getByRole("button", { name: "События", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "Операции", exact: true }).click();
  await expect(page.locator(".workspace-operation-result")).toContainText(
    "check.example.test:443",
  );
});

test("marketing websites are separate while identical internal WebsiteDown stays visible", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Проблемы: 1", exact: true }).click();
  const menu = page.getByRole("dialog", {
    name: "Текущие неисправности",
    exact: true,
  });
  await expect(
    menu.getByRole("button", { name: /Внутреннее приложение недоступно/ }),
  ).toBeVisible();
  await expect(
    menu.getByRole("button", { name: /Публичный сайт недоступен/ }),
  ).toBeHidden();
  await menu.locator("summary").click();
  await expect(
    menu.getByRole("button", { name: /Публичный сайт недоступен/ }),
  ).toBeVisible();
  await menu
    .getByRole("button", { name: /Внутреннее приложение недоступно/ })
    .click();
  const detail = page.getByRole("dialog", {
    name: "Внутреннее приложение недоступно",
    exact: true,
  });
  await expect(detail).toContainText("Ресурсы и диагностика");
  await expect(detail).toContainText("RDSH-проверка");
  await detail
    .getByRole("button", { name: "Закрыть панель", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Проблемы: 1", exact: true }),
  ).toBeFocused();
});

for (const width of [1920])
  for (const theme of ["dark", "light"]) {
    test(`workspace desktop ${width} ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({
        width,
        height: width === 1920 ? 1080 : 1440,
      });
      await page.addInitScript(
        (theme) => localStorage.setItem("pl-ui-theme", theme),
        theme,
      );
      await login(page);
      await expect(
        page
          .locator(".sidebar")
          .getByRole("button", { name: "Инструменты", exact: true }),
      ).toHaveCount(0);
      await expect(
        page
          .locator(".sidebar")
          .getByRole("button", { name: "Отчёты", exact: true }),
      ).toHaveCount(0);
      await expect(
        page
          .locator(".sidebar")
          .getByRole("button", { name: "Проблемы", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.locator(
          '[data-layout-tile="tools"], [data-layout-tile="reports"], [data-layout-tile="problems"]',
        ),
      ).toHaveCount(0);
      const geometry = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        sidebar: document.querySelector(".sidebar")!.getBoundingClientRect()
          .width,
        header: document.querySelector(".topbar")?.getBoundingClientRect()
          .height,
      }));
      expect(geometry.scroll).toBeLessThanOrEqual(width);
      expect(geometry.sidebar).toBe(width === 1920 ? 226 : 240);
      const addButton = page.getByRole("button", {
        name: "Добавить ресурс",
        exact: true,
      });
      const addGeometry = await addButton.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const icon = button.querySelector("svg")!.getBoundingClientRect();
        const label = button.querySelector("span")!.getBoundingClientRect();
        return {
          gap: label.left - icon.right,
          offset: Math.abs(
            (icon.left + label.right) / 2 - (bounds.left + bounds.right) / 2,
          ),
        };
      });
      expect(addGeometry.gap).toBeGreaterThanOrEqual(6);
      expect(addGeometry.gap).toBeLessThanOrEqual(12);
      expect(addGeometry.offset).toBeLessThanOrEqual(1);
      await addButton.screenshot({
        path: info.outputPath("add-resource-button.png"),
      });
      await page.screenshot({ path: info.outputPath("workspace-home.png") });
      await page
        .getByRole("button", { name: "Проверить адрес", exact: true })
        .click();
      const panel = page.getByRole("dialog", {
        name: "Проверка адреса",
        exact: true,
      });
      await expect(panel).toBeVisible();
      await page.screenshot({ path: info.outputPath("check-panel.png") });
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
    });
  }
