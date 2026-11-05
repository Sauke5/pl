import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const names = [
  "Grafana",
  "Wayline",
  "Файловый аудитор",
  "Карта филиалов и Цитадели",
  "Управление мониторингом",
  "Управление сайтами",
  "Отчёты инфраструктуры",
  "Proxy Edge",
  "Выгрузки баз · SFTP",
  "Doska",
  "Опросы и тесты для сотрудников всех филиалов",
];
const descriptions = [
  "Панели мониторинга и исследования инфраструктуры",
  "MTR, traceroute и история сетевых проверок",
  "Аудит документов файловых серверов HOT и ARCH",
  "Топология филиалов, стойки Цитадели и связи оборудования",
  "Администрирование существующего мониторинга",
  "Цели проверок сайтов, проверка содержания и доступности",
  "Опубликованные ежедневные и еженедельные отчёты",
  "Управление прокси Edge: подключения и маршрутизация",
  "Централизованный приём архивов баз филиалов через SFTP",
  "Проекты и задачи IT: доски, участники и связанные ресурсы",
  "СсылкаБезПробеловДляПроверкиПереносаОченьДлинныхОписаний_0123456789_abcdefghijklmnopqrstuvwxyz",
];
const icons = [
  "network",
  "wayline",
  "auditor",
  "topology",
  "monitoringAdmin",
  "websitesAdmin",
  "reports",
  "proxyEdge",
  "sftp",
  "doska",
  "forms",
];
const resources = names.map((name, index) => ({
  id: `favorite-${index}`,
  revision: 1,
  name,
  description: descriptions[index],
  icon: icons[index],
  url: `https://favorite-${index}.example.invalid/service`,
  hostname: "",
  ip: "",
  type: "Web-сервис",
  lifecycle: "active",
  directions: [],
  tags: [],
  aliases: [],
  endpoints: [],
  links: [],
  relations: [],
  operations: [],
  check: {},
  source: "fixture",
}));
const host = {
  ...resources[0],
  id: "favorite-host",
  name: "СерверБезВебАдресаСОченьДлиннымИменем_0123456789",
  description: "Данные ресурса открываются в карточке",
  type: "Сервер",
  hostname: "host.example.invalid",
  url: "",
  icon: "server",
};
const bmcHost = {
  ...host,
  id: "bmc-host",
  name: "Сервер с адресом BMC",
  url: "https://bmc.example.invalid",
};
const newHost = { ...bmcHost, id: "new-host", name: "Новый сервер с BMC" };
const unsafeApp = {
  ...resources[0],
  id: "unsafe-app",
  name: "Некорректная ссылка",
  url: "javascript:void(0)",
};
const bmcApp = {
  ...bmcHost,
  id: "bmc-app",
  name: "iDRAC · веб-приложение",
  type: "Management",
};
const legacyIDs = [host.id, bmcHost.id, unsafeApp.id];
const allResources = [...resources, host, bmcHost, newHost, unsafeApp, bmcApp];
const groupID = "favorite-group_7932ee00-7156-4b18-998a-11bd95db3694";

async function fixture(page: Page) {
  let revision = 1;
  let tiles = [
    { id: "favorites", width: 8, height: 0, heightRows: 0, pinned: false },
    { id: groupID, width: 4, height: 0, heightRows: 0, pinned: false },
  ];
  const writes: string[] = [];
  const payloads: { path: string; body: any }[] = [];
  let preferences = {
    revision: 1,
    favorites: [...resources.map((r) => r.id), ...legacyIDs],
    hidden_sections: [],
    section_order: [],
    wayline_cards: [],
  };
  let workspacePreferences = {
    revision: 1,
    system_ids: [],
    groups: [
      {
        id: groupID.slice("favorite-group_".length),
        name: "Моя группа",
        resource_ids: [resources[0].id, ...legacyIDs],
        collapsed: false,
      },
    ],
  };
  let job: any;
  let jobComplete = false;
  const now = new Date().toISOString();
  const problem = {
    id: "fixture-problem",
    title: "Сервис недоступен",
    description: "Подробное описание проблемы. ".repeat(100),
    integration_id: "fixture-alerts",
    external_id: "fixture-alert",
    resource_id: resources[0].id,
    resource_ids: [resources[0].id],
    severity: "warning",
    status: "firing",
    hidden: false,
    stale: false,
    marketing: false,
    started_at: now,
    last_seen: now,
    labels: { instance: resources[0].url },
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${path}`);
      payloads.push({ path, body: request.postDataJSON() });
    }
    if (path === "/dashboard-layout") {
      if (request.method() === "PUT") {
        tiles = request.postDataJSON().tiles;
        revision++;
      }
      return route.fulfill({
        json: {
          revision,
          tiles,
          hidden: [
            "directions",
            "events",
            "integrations",
            "wayline",
            "grafana",
            "systems",
          ],
        },
      });
    }
    if (path === "/preferences" && request.method() === "PUT") {
      preferences = {
        ...request.postDataJSON(),
        revision: preferences.revision + 1,
      };
      return route.fulfill({ json: preferences });
    }
    if (path === "/workspace-preferences" && request.method() === "PUT") {
      workspacePreferences = {
        ...request.postDataJSON(),
        revision: workspacePreferences.revision + 1,
      };
      return route.fulfill({ json: workspacePreferences });
    }
    if (path === "/jobs" && request.method() === "POST") {
      job = {
        id: "fixture-check",
        kind: "check",
        actor: "fixture",
        resource_id: "",
        parameters: request.postDataJSON().parameters,
        created_at: now,
        status: "queued",
        result: {},
      };
      return route.fulfill({ json: job });
    }
    if (path === "/jobs/fixture-check")
      return route.fulfill({
        json: {
          ...job,
          status: jobComplete ? "succeeded" : "queued",
          result: jobComplete
            ? {
                kind: "dns",
                target: "fixture.example.invalid",
                addresses: ["192.0.2.1"],
                observed_at: now,
              }
            : {},
        },
      });
    const data: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: {
          id: "favorites-test",
          name: "Проверка закреплений",
          admin: true,
        },
        csrf_token: "fixture",
        timezone: "Europe/Moscow",
      },
      "/time": { server_time: now },
      "/preferences": preferences,
      "/workspace-preferences": workspacePreferences,
      "/help-state": { disabled: true, seen: [] },
      "/resources": allResources,
      "/workspace-problems": [
        problem,
        ...Array.from({ length: 5 }, (_, i) => ({
          ...problem,
          id: `marketing-${i}`,
          title: `Публичный сайт ${i + 1} недоступен`,
          marketing: true,
          resource_id: "",
          resource_ids: [],
        })),
      ],
      "/problem-presentation": { revision: 1, targets: [], resource_ids: [] },
      "/integrations": [
        {
          id: "fixture-alerts",
          name: "Источник проблем",
          kind: "alertmanager",
          enabled: true,
          status: "connected",
          last_success: now,
          poll_seconds: 30,
        },
      ],
      "/events": Array.from({ length: 30 }, (_, i) => ({
        id: `fixture-event-${i}`,
        title: `Изменение состояния ${i}`,
        created_at: now,
        details: { problem_id: problem.id },
      })),
      "/problems/fixture-problem/links": {
        revision: 1,
        mode: "manual",
        resource_ids: [resources[0].id],
        reason: "",
        candidates: [],
      },
      "/candidates": [],
      "/systems": [],
      "/collections": [],
      "/dictionaries": { sites: [], environments: [] },
      "/wayline": { sources: [] },
    };
    if (path in data) return route.fulfill({ json: data[path] });
    if (path === "/stream") return route.abort();
    return route.fulfill({
      status: 503,
      json: { message: "Источник в изолированной проверке не подключён" },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Моё рабочее пространство",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/^Связь с обновлениями потеряна/)).toBeVisible();
  await expect(page.locator('[data-layout-tile="wayline"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  return {
    writes,
    payloads,
    completeJob: () => {
      jobComplete = true;
    },
  };
}

async function geometry(page: Page) {
  return page
    .locator('[data-layout-tile="favorites"] .workspace-favorites-grid')
    .evaluate((grid) => {
      const rect = (node: Element) => {
        const r = node.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        };
      };
      const intersects = (
        a: ReturnType<typeof rect>,
        b: ReturnType<typeof rect>,
      ) =>
        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
      const cards = [
        ...grid.querySelectorAll<HTMLElement>(".workspace-favorite"),
      ].map((card) => {
        const link = card.querySelector(
          "a, .resource-detail-link, .workspace-favorite-link",
        )!;
        const icon = card.querySelector(".resource-icon")!;
        const title = card.querySelector("strong")!;
        const description = card.querySelector("small")!;
        const action = card.querySelector(
          ":scope > button, .workspace-favorite-chevron",
        )!;
        const visibleSVGs = [...card.querySelectorAll("svg")].filter(
          (svg) => getComputedStyle(svg).display !== "none",
        );
        const bounds = rect(card);
        const outside = [icon, title, description, action, ...visibleSVGs].some(
          (node) => {
            const r = rect(node);
            return (
              r.left < bounds.left - 1 ||
              r.right > bounds.right + 1 ||
              r.top < bounds.top - 1 ||
              r.bottom > bounds.bottom + 1
            );
          },
        );
        return {
          ...bounds,
          outside,
          svgCount: visibleSVGs.length,
          actionOverText:
            intersects(rect(action), rect(title)) ||
            intersects(rect(action), rect(description)),
          textClipped: [title, description].some(
            (node) =>
              node.scrollWidth > node.clientWidth + 1 ||
              node.scrollHeight > node.clientHeight + 1,
          ),
        };
      });
      return {
        grid: rect(grid),
        cards,
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        rows: new Set(cards.map((card) => Math.round(card.top))).size,
      };
    });
}

for (const width of [1920])
  for (const theme of ["dark", "light"]) {
    test(`favorites adapt to their tile ${width} ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({
        width,
        height: width === 1920 ? 1080 : 1440,
      });
      await page.addInitScript(
        (theme) => localStorage.setItem("pl-ui-theme", theme),
        theme,
      );
      const state = await fixture(page);
      const tile = page.locator('[data-layout-tile="favorites"]');
      await expect(tile.locator(".workspace-favorite")).toHaveCount(11);
      await tile.screenshot({ path: info.outputPath("favorites-initial.png") });
      const initial = await geometry(page);
      await writeFile(
        info.outputPath("geometry-initial.json"),
        JSON.stringify(initial, null, 2),
      );
      await expect(
        tile.locator(".lucide-arrow-up-right, .lucide-chevron-right"),
      ).toHaveCount(0);
      expect(initial.cards.every((card) => card.svgCount === 2)).toBe(true);
      expect(
        initial.cards.every(
          (card) => !card.outside && !card.actionOverText && !card.textClipped,
        ),
      ).toBe(true);
      expect(initial.pageOverflow).toBe(false);
      await expect(
        tile.locator('[data-system-icon="network"]').first(),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Настроить главную", exact: true })
        .click();
      const handle = page.getByRole("button", {
        name: "Изменить размер: Закрепления",
        exact: true,
      });
      await handle.focus();
      for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
      await page
        .getByRole("button", { name: "Сохранить", exact: true })
        .click();
      await expect
        .poll(async () => (await geometry(page)).grid.width)
        .toBeGreaterThan(initial.grid.width);
      await expect
        .poll(() =>
          tile.evaluate(
            (node) =>
              new DOMMatrixReadOnly(getComputedStyle(node).transform)
                .isIdentity,
          ),
        )
        .toBe(true);
      const expanded = await geometry(page);
      await tile.screenshot({
        path: info.outputPath("favorites-expanded.png"),
      });
      await writeFile(
        info.outputPath("geometry-expanded.json"),
        JSON.stringify(expanded, null, 2),
      );
      expect(
        expanded.cards.every(
          (card) =>
            !card.outside &&
            !card.actionOverText &&
            !card.textClipped &&
            card.svgCount === 2,
        ),
      ).toBe(true);
      expect(expanded.pageOverflow).toBe(false);
      expect(expanded.rows).toBeLessThanOrEqual(initial.rows);
      expect(state.writes).toEqual(["PUT /dashboard-layout"]);
    });
  }

test("favorite links and details preserve their actions and keyboard access", async ({
  page,
}) => {
  const state = await fixture(page);
  const tile = page.locator('[data-layout-tile="favorites"]');
  await page.context().route("https://favorite-0.example.invalid/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Fixture service</h1>",
    }),
  );
  const link = tile.getByRole("link", {
    name: "Открыть: Grafana",
    exact: true,
  });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  await link.focus();
  await expect(link).toBeFocused();
  const popupPromise = page.waitForEvent("popup");
  await page.keyboard.press("Enter");
  const popup = await popupPromise;
  await expect(popup).toHaveURL(resources[0].url);
  await popup.close();
  await page.bringToFront();
  await tile
    .getByRole("button", { name: "Подробнее: Grafana", exact: true })
    .click();
  const detail = page.getByRole("dialog", { name: "Grafana", exact: true });
  await expect(detail).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  const group = page.locator(`[data-layout-tile="${groupID}"]`);
  await expect(group.locator(".workspace-favorite")).toHaveCount(1);
  await expect(group.getByText(host.name, { exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test("card selectors keep legacy IDs while offering only web applications", async ({
  page,
}) => {
  const state = await fixture(page);
  await page
    .getByRole("button", { name: "Настроить группу Моя группа", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Группа закреплений",
    exact: true,
  });
  for (const name of [host.name, bmcHost.name, newHost.name, unsafeApp.name])
    await expect(
      editor.getByRole("checkbox", { name, exact: false }),
    ).toHaveCount(0);
  await expect(
    editor.getByRole("checkbox", { name: bmcApp.name, exact: false }),
  ).toBeVisible();
  await editor
    .getByLabel("Название группы", { exact: true })
    .fill("Группа приложений");
  await editor
    .getByRole("button", { name: "Сохранить группу", exact: true })
    .click();
  expect(state.payloads.at(-1)?.body.groups[0].resource_ids).toEqual([
    resources[0].id,
    ...legacyIDs,
  ]);
  await page
    .getByRole("button", { name: "Выбрать и упорядочить", exact: true })
    .click();
  const personal = page.getByRole("dialog", {
    name: "Избранное и Wayline",
    exact: true,
  });
  for (const name of [host.name, bmcHost.name, unsafeApp.name])
    await expect(personal.getByText(name, { exact: true })).toHaveCount(0);
  await personal
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  expect(state.payloads.at(-1)?.body.favorites).toEqual([
    ...resources.map((r) => r.id),
    ...legacyIDs,
  ]);
  await page.goto("/#catalog?kind=infrastructure");
  await expect(
    page.getByRole("button", {
      name: `Закрепить ${newHost.name}`,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: `Открепить ${bmcHost.name}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Приложения/ }).click();
  await expect(
    page.getByRole("button", { name: `Закрепить ${bmcApp.name}`, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: `Закрепить ${unsafeApp.name}`,
      exact: true,
    }),
  ).toHaveCount(0);
});

async function opaque(locator: ReturnType<Page["locator"]>) {
  expect(
    await locator.evaluate((node) => {
      const color = getComputedStyle(node).backgroundColor;
      const parts = color.match(/[\d.]+/g)?.map(Number) || [];
      return (
        color.startsWith("rgb") && (parts.length === 3 || parts[3] >= 0.99)
      );
    }),
  ).toBe(true);
}

for (const theme of ["dark", "light"])
  test(`opaque panels close outside and retain nested form ${theme}`, async ({
    page,
  }, info) => {
    await page.addInitScript(
      (theme) => localStorage.setItem("pl-ui-theme", theme),
      theme,
    );
    const state = await fixture(page);
    await page
      .getByRole("button", { name: "Проблемы: 1", exact: true })
      .click();
    const popover = page.getByRole("dialog", {
      name: "Текущие неисправности",
      exact: true,
    });
    await popover.locator("summary").click();
    await opaque(popover);
    expect(
      await popover.evaluate((node) => node.parentElement === document.body),
    ).toBe(true);
    expect(
      await popover.evaluate((node) => {
        const p = node.getBoundingClientRect();
        const card = [...document.querySelectorAll(".workspace-favorite")]
          .map((c) => c.getBoundingClientRect())
          .find(
            (c) =>
              c.left < p.right &&
              c.right > p.left &&
              c.top < p.bottom &&
              c.bottom > p.top,
          );
        if (!card) return false;
        const x =
          (Math.max(p.left, card.left) + Math.min(p.right, card.right)) / 2;
        const y =
          (Math.max(p.top, card.top) + Math.min(p.bottom, card.bottom)) / 2;
        return (
          document
            .elementsFromPoint(x, y)[0]
            ?.closest(".workspace-problem-popover") === node
        );
      }),
    ).toBe(true);
    await popover.screenshot({ path: info.outputPath("problem-popover.png") });
    await popover.getByRole("button", { name: /Сервис недоступен/ }).click();
    const panel = page.getByRole("dialog", {
      name: "Сервис недоступен",
      exact: true,
      includeHidden: true,
    });
    await opaque(panel);
    await panel.evaluate((node) => (node.scrollTop = node.scrollHeight));
    await expect(
      panel.getByRole("button", { name: "Закрыть панель", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await panel.screenshot({
      path: info.outputPath("problem-drawer-scrolled.png"),
    });
    await panel
      .getByRole("button", { name: "Настроить связи", exact: true })
      .click();
    const nested = page.getByRole("dialog", {
      name: "Настроить связи",
      exact: true,
    });
    await expect(
      nested.getByRole("checkbox", { name: newHost.name, exact: false }),
    ).toBeVisible();
    await nested.getByLabel("Найти ресурс", { exact: true }).fill("Черновик");
    await expect(panel).toBeVisible();
    await expect(
      nested.getByLabel("Найти ресурс", { exact: true }),
    ).toHaveValue("Черновик");
    await nested.getByRole("button", { name: "Закрыть", exact: true }).click();
    await expect(panel).toBeVisible();
    await panel
      .getByRole("button", { name: "Показать подсказки", exact: true })
      .click();
    const coach = page.getByRole("dialog", {
      name: "Разберись с проблемой",
      exact: true,
    });
    const helpPrimary = coach.getByRole("button", {
      name: "Понятно",
      exact: true,
    });
    await expect(helpPrimary).toBeFocused();
    await helpPrimary.press("Escape");
    await expect(coach).toBeHidden();
    await expect(panel).toBeVisible();
    await page
      .getByRole("heading", { name: "Моё рабочее пространство", exact: true })
      .click();
    await expect(panel).toBeHidden();
    await page
      .getByRole("button", { name: "Проверить адрес", exact: true })
      .click();
    const check = page.getByRole("dialog", {
      name: "Проверка адреса",
      exact: true,
    });
    await check.getByRole("textbox").fill("fixture.example.invalid");
    await check
      .getByRole("button", { name: "Запустить проверку", exact: true })
      .click();
    await expect(check).toContainText("Состояние сохранено");
    await page
      .getByRole("heading", { name: "Моё рабочее пространство", exact: true })
      .click();
    await expect(check).toBeHidden();
    state.completeJob();
    const toast = page
      .getByRole("status")
      .filter({ hasText: "Проверка завершена" });
    await expect(toast).toBeVisible();
    await opaque(toast);
    expect(
      await toast.evaluate((node) => node.parentElement === document.body),
    ).toBe(true);
    await toast.screenshot({ path: info.outputPath("check-toast.png") });
  });
