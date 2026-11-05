import { expect, test, type Page } from "@playwright/test";

async function fixture(
  page: Page,
  admin: boolean,
  initialTiles: unknown[] = [],
  resources: unknown[] = [],
) {
  const board = [
    {
      id: "service-one",
      name: "Сервис один",
      description: "Первый сервис",
      icon: "app",
      url: "/one",
      status: "unknown",
    },
    {
      id: "service-two",
      name: "Сервис два",
      description: "Второй сервис",
      icon: "app",
      url: "/two",
      status: "unknown",
    },
  ];
  let revision = initialTiles.length ? 1 : 0;
  let tiles: unknown[] = initialTiles;
  let hidden: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/session"))
      return route.fulfill({
        json: {
          authenticated: true,
          user: { id: "layout-test", name: "Тестовый пользователь", admin },
          csrf_token: "test",
          timezone: "Europe/Moscow",
        },
      });
    if (path.endsWith("/dashboard-layout")) {
      if (request.method() === "PUT") {
        const body = request.postDataJSON();
        if (body.revision !== revision)
          return route.fulfill({ status: 409, json: { message: "Конфликт" } });
        revision += 1;
        tiles = body.tiles;
        hidden = body.hidden;
      }
      return route.fulfill({ json: { revision, tiles, hidden } });
    }
    if (path.endsWith("/workspace-preferences"))
      return route.fulfill({
        json: { revision: 0, system_ids: [], groups: [] },
      });
    if (path.endsWith("/preferences"))
      return route.fulfill({
        json: {
          revision: 0,
          favorites: [],
          hidden_sections: [],
          section_order: [],
          wayline_cards: [],
        },
      });
    if (path.endsWith("/chart-settings"))
      return route.fulfill({ json: { revision: 0, charts: [] } });
    if (path.endsWith("/help-state"))
      return route.fulfill({ json: { disabled: true, seen: [] } });
    if (path.endsWith("/board"))
      return route.fulfill({ json: { title: "Сервисы", items: board } });
    if (path.endsWith("/resources")) return route.fulfill({ json: resources });
    return route.fulfill({ json: [] });
  });
  return {
    remove: (id: string) => {
      const index = board.findIndex((item) => item.id === id);
      if (index >= 0) board.splice(index, 1);
    },
  };
}

test("employee layout saves, cancels, pins and excludes withdrawn cards", async ({
  page,
}) => {
  const state = await fixture(page, false);
  await page.goto("/");
  await expect(page.locator("[data-layout-tile]")).toHaveCount(2);
  await page.getByRole("button", { name: "Настроить главную" }).click();
  const first = page.locator('[data-layout-tile="service-one"]');
  const initialWidth = await first.evaluate(
    (node) => node.getBoundingClientRect().width,
  );
  const neighbor = page.locator('[data-layout-tile="service-two"]');
  const neighborHeight = await neighbor.evaluate(
    (node) => node.getBoundingClientRect().height,
  );
  await page
    .getByRole("button", { name: "Изменить размер: Сервис один" })
    .focus();
  await page.keyboard.press("ArrowDown");
  await expect(first).toHaveClass(/has-fixed-height/);
  await expect
    .poll(() =>
      neighbor.evaluate((node) => node.getBoundingClientRect().height),
    )
    .toBe(neighborHeight);
  await page.keyboard.press("ArrowUp");
  await page
    .getByRole("button", { name: "Изменить размер: Сервис один" })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => first.evaluate((node) => node.getBoundingClientRect().width))
    .toBeGreaterThan(initialWidth);
  await page
    .getByRole("button", { name: "Закрепить положение: Сервис один" })
    .click();
  await expect(
    page.getByRole("button", { name: "Переместить: Сервис один" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Отменить" }).click();
  await expect
    .poll(() => first.evaluate((node) => node.getBoundingClientRect().width))
    .toBe(initialWidth);
  await page.getByRole("button", { name: "Настроить главную" }).click();
  const drag = await page
    .getByRole("button", { name: "Переместить: Сервис два" })
    .boundingBox();
  const target = await page
    .locator('[data-layout-tile="service-one"]')
    .boundingBox();
  if (!drag || !target) throw new Error("drag controls missing");
  await page.mouse.move(drag.x + drag.width / 2, drag.y + drag.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    { steps: 12 },
  );
  await expect(page.locator('[data-layout-tile="service-two"]')).toHaveCSS(
    "outline-style",
    "dashed",
  );
  await expect(page.locator("[data-drag-outline]")).toHaveCSS(
    "border-top-style",
    "dashed",
  );
  await expect(page.locator("[data-layout-tile]").first()).toHaveAttribute(
    "data-layout-tile",
    "service-two",
  );
  await page.mouse.up();
  const handle = page.getByRole("button", {
    name: "Изменить размер: Сервис один",
  });
  await page.waitForTimeout(450);
  const box = await handle.boundingBox();
  if (!box) throw new Error("resize handle missing");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 650,
    box.y + box.height / 2 + 230,
    { steps: 8 },
  );
  await page.mouse.up();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await page.reload();
  await expect
    .poll(() => first.evaluate((node) => node.getBoundingClientRect().width))
    .toBeGreaterThan(initialWidth);
  state.remove("service-one");
  await page.reload();
  await expect(page.locator('[data-layout-tile="service-one"]')).toHaveCount(0);
  await expect(page.locator('[data-layout-tile="service-two"]')).toHaveCount(1);
});

test("admin layout preserves keyboard and pointer order after save", async ({
  page,
}) => {
  await fixture(page, true);
  await page.goto("/");
  await page.getByRole("button", { name: "Настроить главную" }).click();
  await page.getByRole("button", { name: "Переместить: Закрепления" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("[data-layout-tile]").first()).toHaveAttribute(
    "data-layout-tile",
    "directions",
  );
  await expect(
    page.locator('[data-layout-tile="directions"] input[type="checkbox"]'),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Сохранить" }).click();
  await page.reload();
  await expect(page.locator("[data-layout-tile]").first()).toHaveAttribute(
    "data-layout-tile",
    "directions",
  );
});

test("admin cards move by pointer and keep their order after save", async ({
  page,
}) => {
  await fixture(page, true);
  await page.goto("/");
  await page.getByRole("button", { name: "Настроить главную" }).click();
  // The mock closes EventSource. Wait for its banner before measuring drag coordinates.
  await expect(page.getByText(/^Связь с обновлениями потеряна/)).toBeVisible();
  const source = page.getByRole("button", { name: "Переместить: Закрепления" });
  const target = page.locator('[data-layout-tile="directions"]');
  await page.evaluate(() => document.fonts.ready);
  await target.click({ trial: true });
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("admin drag controls missing");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // Move directly to the drop position: intermediate grid reflow changes hit targets.
  await page.mouse.move(to.x + (to.width * 3) / 4, to.y + (to.height * 3) / 4);
  await expect(page.locator("[data-drag-outline]")).toBeVisible();
  await expect(page.locator("[data-layout-tile]").first()).toHaveAttribute(
    "data-layout-tile",
    "directions",
  );
  await page.mouse.up();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await page.reload();
  await expect(page.locator("[data-layout-tile]").first()).toHaveAttribute(
    "data-layout-tile",
    "directions",
  );
});

test("removed employee widget can be restored before save", async ({
  page,
}) => {
  await fixture(page, false);
  await page.goto("/");
  await page.getByRole("button", { name: "Настроить главную" }).click();
  await page.getByRole("button", { name: "Скрыть: Сервис один" }).click();
  await expect(page.locator('[data-layout-tile="service-one"]')).toHaveCount(0);
  await page.getByRole("button", { name: "+ Сервис один" }).click();
  await expect(page.locator('[data-layout-tile="service-one"]')).toHaveCount(1);
});

test("manual height matches across cards with different content", async ({
  page,
}) => {
  await fixture(page, true, [
    { id: "events", width: 4, height: 6, pinned: false },
    { id: "directions", width: 4, height: 6, pinned: false },
  ]);
  await page.goto("/");
  const problems = page.locator('[data-layout-tile="events"]');
  const directions = page.locator('[data-layout-tile="directions"]');
  await expect(problems).toHaveClass(/has-fixed-height/);
  await expect
    .poll(async () =>
      Math.abs(
        (await problems.evaluate(
          (node) => node.getBoundingClientRect().height,
        )) -
          (await directions.evaluate(
            (node) => node.getBoundingClientRect().height,
          )),
      ),
    )
    .toBeLessThan(1);
});

test("short cards fill space below neighboring tall cards", async ({
  page,
}) => {
  await fixture(page, true, [
    { id: "events", width: 4, height: 2, pinned: false },
    { id: "directions", width: 4, height: 8, pinned: false },
    { id: "integrations", width: 4, height: 2, pinned: false },
    { id: "grafana", width: 4, height: 2, pinned: false },
  ]);
  await page.goto("/");
  const problems = page.locator('[data-layout-tile="events"]');
  const directions = page.locator('[data-layout-tile="directions"]');
  const events = page.locator('[data-layout-tile="grafana"]');
  await expect
    .poll(async () => {
      const short = await problems.boundingBox();
      const tall = await directions.boundingBox();
      const filled = await events.boundingBox();
      return (
        !!short &&
        !!tall &&
        !!filled &&
        filled.y >= short.y + short.height &&
        filled.y < tall.y + tall.height
      );
    })
    .toBe(true);
});

test("application block stays compact with six directions", async ({
  page,
}) => {
  const resources = [
    "AD / Windows",
    "Мониторинг",
    "Контейнеры",
    "Управление",
    "Сети",
    "Виртуализация",
  ].map((direction, index) => ({
    id: `app-${index}`,
    name: direction,
    type: "Приложение",
    directions: [direction],
  }));
  await fixture(page, true, [], resources);
  await page.goto("/");
  const applications = page.locator('[data-layout-tile="directions"]');
  await expect(applications.locator(".direction-cards button")).toHaveCount(6);
  await expect(applications.locator(".direction-cards")).toHaveCSS(
    "grid-template-columns",
    /px .*px/,
  );
  await expect
    .poll(() =>
      applications.evaluate((node) => node.getBoundingClientRect().height),
    )
    .toBeLessThan(400);
});

test("small application panel keeps its background while scrolling", async ({
  page,
}) => {
  await fixture(
    page,
    true,
    [{ id: "directions", width: 4, height: 2, pinned: false }],
    Array.from({ length: 6 }, (_, index) => ({
      id: `app-${index}`,
      name: `Сервис ${index}`,
      type: "Приложение",
      directions: [`Категория ${index}`],
    })),
  );
  await page.goto("/");
  const tile = page.locator('[data-layout-tile="directions"]');
  const panel = tile.locator(".panel");
  await expect
    .poll(() => panel.evaluate((node) => node.scrollHeight - node.clientHeight))
    .toBeGreaterThan(0);
  await panel.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect
    .poll(() => panel.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  await expect(tile.locator(".dashboard-tile-content")).toHaveJSProperty(
    "scrollTop",
    0,
  );
  await expect(panel).toHaveCSS("overflow-y", "auto");
});

test("legacy height joins the grid and resizes by one row", async ({
  page,
}) => {
  await fixture(page, true, [
    { id: "directions", width: 4, height: 2, pinned: false },
  ]);
  await page.goto("/");
  const tile = page.locator('[data-layout-tile="directions"]');
  await expect
    .poll(() => tile.evaluate((node) => node.getBoundingClientRect().height))
    .toBe(248);
  await page.getByRole("button", { name: "Настроить главную" }).click();
  await page
    .getByRole("button", { name: "Изменить размер: Приложения" })
    .focus();
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(() => tile.evaluate((node) => node.getBoundingClientRect().height))
    .toBe(264);
  await page.getByRole("button", { name: "Сохранить" }).click();
  await page.reload();
  await expect
    .poll(() => tile.evaluate((node) => node.getBoundingClientRect().height))
    .toBe(264);
});
