import { test, expect } from "@playwright/test";
import {
  localProxyFixture,
  localInstance,
  localID,
  secondID,
  expectNoLegacyCalls,
} from "./local-proxy-fixture";

for (const theme of ["dark", "light"]) {
  test(`First proxy visit keeps inbound actions accessible with unseen home help (${theme})`, async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-11-04T12:00:00Z") });
    await page.addInitScript(
      (value) => localStorage.setItem("pl-ui-theme", value),
      theme,
    );
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const fixture = await localProxyFixture(page);
    await page.route("**/api/v1/help-state", (route) =>
      route.fulfill({ json: { disabled: false, seen: [] } }),
    );
    await page.goto(`/#proxy?instance=${localID}`);
    await expect(
      page.getByRole("heading", {
        name: "Xray",
        exact: true,
        includeHidden: true,
      }),
    ).toBeAttached();
    // Run the first-open coach timer before checking that it cannot cover Xray.
    await page.clock.runFor(1000);
    await expect(page.locator(".help-coach")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Добавить inbound", exact: true })
      .click();
    await expect(page.locator(".xray-inbound")).toHaveCount(1);
    expect(fixture.writes).toEqual([]);
    expectNoLegacyCalls(fixture.calls);

    await page.route("**/api/v1/dashboard-layout?*", (route) =>
      route.fulfill({ json: { revision: 0, tiles: [], hidden: [] } }),
    );
    await page.route("**/api/v1/workspace-preferences", (route) =>
      route.fulfill({ json: { revision: 0, system_ids: [], groups: [] } }),
    );
    await page.route("**/api/v1/time", (route) =>
      route.fulfill({ json: { server_time: "2026-11-04T12:00:00Z" } }),
    );
    await page.goto("/#home");
    await expect(
      page.getByRole("heading", {
        name: "Моё рабочее пространство",
        exact: true,
        includeHidden: true,
      }),
    ).toBeAttached();
    await page.clock.runFor(1000);
    await expect(page.locator(".help-coach")).toHaveAttribute(
      "data-help-topic",
      "home",
    );
    expect(pageErrors).toEqual([]);
  });
}

for (const theme of ["dark", "light"]) {
  test(`Local Xray proxy shows current configuration and traffic (${theme})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.addInitScript(
      (value) => localStorage.setItem("pl-ui-theme", value),
      theme,
    );
    const f = await localProxyFixture(page);
    await page.goto("/#proxy");
    await expect(
      page.getByRole("heading", { name: "Xray", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Прокси", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Работает", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Текущая схема Xray")).toContainText(
      "127.0.0.1:1080",
    );
    await expect(
      page.getByRole("heading", {
        name: "Трафик входящих подключений",
        exact: true,
      }),
    ).toBeVisible();
    const traffic = page.getByRole("row").filter({
      has: page.locator("code").filter({ hasText: /^office$/ }),
    });
    await expect(traffic).toHaveCount(1);
    await expect(traffic.getByRole("cell").nth(1)).toHaveText(/^2\s048 байт$/);
    await expect(traffic.getByRole("cell").nth(2)).toHaveText("Нет данных");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expectNoLegacyCalls(f.calls);
    await page.screenshot({
      path: info.outputPath(`local-proxy-${theme}.png`),
    });
  });
}
for (const [name, items] of [
  ["not installed", []],
  ["not yet installed", [{ ...localInstance(), observed_state: "pending" }]],
  ["external only", [localInstance(localID, "enabled", "external")]],
  ["removed", [localInstance(localID, "removed")]],
  [
    "being removed",
    [{ ...localInstance(localID, "removed"), observed_state: "removing" }],
  ],
] as const) {
  test(`Proxy navigation stays hidden when Xray is ${name}`, async ({
    page,
  }) => {
    const f = await localProxyFixture(page, [...items]);
    await page.goto("/#proxy");
    await expect(
      page.getByText("Локальный Xray не установлен", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Прокси", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Открыть каталог модулей" }),
    ).toHaveAttribute("href", "#module-catalog");
    expect(f.calls.filter((path) => /\/xray\//.test(path))).toEqual([]);
    expectNoLegacyCalls(f.calls);
  });
}
test("Disabled local Xray retains navigation and reports its actual state", async ({
  page,
}) => {
  const f = await localProxyFixture(page, [localInstance(localID, "disabled")]);
  await page.goto("/#proxy");
  await expect(
    page.getByRole("button", { name: "Прокси", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Отключён", { exact: true })).toBeVisible();
  expectNoLegacyCalls(f.calls);
});
test("Proxy selection uses the requested owned instance and preserves its URL", async ({
  page,
}) => {
  const f = await localProxyFixture(page, [
    localInstance(),
    localInstance(secondID),
  ]);
  await page.goto(`/#proxy?instance=${secondID}`);
  await expect(page.getByLabel("Текущая схема Xray")).toContainText(
    "127.0.0.1:2080",
  );
  expect(
    f.calls.some((path) => path === `/modules/${localID}/xray/status`),
  ).toBe(false);
  await page
    .getByRole("combobox", { name: /^Локальный Xray/ })
    .selectOption(localID);
  await expect(page).toHaveURL(new RegExp(`#proxy\\?instance=${localID}$`));
  await expect(page.getByLabel("Текущая схема Xray")).toContainText(
    "127.0.0.1:1080",
  );
  expectNoLegacyCalls(f.calls);
});
test("Unknown requested instance never falls back to a different Xray", async ({
  page,
}) => {
  const f = await localProxyFixture(page);
  await page.goto(`/#proxy?instance=${secondID}`);
  await expect(
    page.getByText("Этот экземпляр Xray больше не доступен", { exact: true }),
  ).toBeVisible();
  expect(f.calls.filter((path) => /\/xray\//.test(path))).toEqual([]);
  expectNoLegacyCalls(f.calls);
});
test("Proxy saves imported outbound and routing through the owned module API with CSRF", async ({
  page,
}) => {
  const f = await localProxyFixture(page);
  await page.goto("/#proxy");
  await page
    .getByRole("combobox", { name: /^Режим outbound/ })
    .selectOption("imported");
  await page
    .getByLabel("Ссылка подключения outbound", { exact: true })
    .fill("vless://fixture-user@relay.example:443?security=tls&type=tcp#lab");
  await page
    .getByRole("combobox", { name: /^Базовая маршрутизация/ })
    .selectOption("private_direct");
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(
    page.getByText("Черновик v1 · Без изменений", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Ссылка подключения outbound", { exact: true }),
  ).toHaveValue("");
  await page
    .getByRole("button", { name: "Проверить конфигурацию", exact: true })
    .click();
  await expect(
    page.getByText(/Конфигурация прошла xray run -test/),
  ).toBeVisible();
  expect(f.writes).toEqual([
    {
      path: `/modules/${localID}/xray/configuration`,
      body: expect.objectContaining({
        configuration: expect.objectContaining({
          routing: "private_direct",
          outbound: {
            mode: "imported",
            link: expect.stringContaining("vless://"),
          },
        }),
      }),
    },
    {
      path: `/modules/${localID}/xray/configuration/validate`,
      body: { configuration_ref: "44444444-4444-4444-8444-444444444444" },
    },
  ]);
  expectNoLegacyCalls(f.calls);
});
test("Removing local Xray removes its navigation on the next module read", async ({
  page,
}) => {
  const f = await localProxyFixture(page);
  await page.goto("/#proxy");
  await expect(
    page.getByRole("heading", { name: "Xray", exact: true }),
  ).toBeVisible();
  f.setItems([localInstance(localID, "removed")]);
  await page.reload();
  await expect(
    page.getByText("Локальный Xray не установлен", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Прокси", exact: true }),
  ).toHaveCount(0);
  expectNoLegacyCalls(f.calls);
});
