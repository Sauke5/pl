import { expect, test, type Page } from "@playwright/test";
import {
  oxidizedID,
  relationsExchangeFixture,
  resourceOneID,
  resourceTwoID,
} from "../fixtures/relationsExchange";

// Adapter UI acceptance only. These fixtures make no calls to live sources.
async function openOxidized(page: Page) {
  await page.goto(`/#settings?section=integrations&integration=${oxidizedID}`);
  return page.getByRole("region", {
    name: "Конфигурации устройств",
    exact: true,
  });
}
function integrationList(page: Page) {
  return page.getByRole("region", { name: "Подключения", exact: true });
}

test("Oxidized metadata separates collection time from configuration change and exposes exact history links", async ({
  page,
}) => {
  const state = await relationsExchangeFixture(page);
  const history = await openOxidized(page);
  await expect(
    history.getByText("Часть истории недоступна", { exact: true }),
  ).toBeVisible();
  const collected = history.getByRole("row", { name: /Коммутатор один/ });
  await expect(collected.getByRole("cell").nth(0)).toContainText("26 окт.");
  await expect(collected.getByRole("cell").nth(1)).toContainText("25 окт.");
  await expect(collected.getByRole("cell").nth(1)).toContainText("abcde12345");
  await expect(
    collected.getByRole("link", { name: "История", exact: true }),
  ).toHaveAttribute("href", state.configuration.nodes[0].history_url);
  await expect(
    collected.getByRole("link", { name: "Изменение", exact: true }),
  ).toHaveAttribute("href", state.configuration.nodes[0].diff_url);
  const missing = history.getByRole("row", { name: /Коммутатор два/ });
  await expect(missing).toContainText("Ещё не собиралась");
  await expect(missing.getByRole("cell").nth(0)).toHaveText("Ещё не было");
  await expect(missing).toContainText("Нет данных");
  await expect(missing).toContainText("История узла временно недоступна");
  await expect(missing.getByRole("link")).toHaveCount(0);
});

test("stale configuration metadata retains known values rather than showing current success", async ({
  page,
}) => {
  const state = await relationsExchangeFixture(page);
  state.configuration.source_status = "stale";
  state.configuration.stale = true;
  const history = await openOxidized(page);
  await expect(
    history.getByText("Данные не обновлены", { exact: true }),
  ).toBeVisible();
  await expect(
    history.getByRole("row", { name: /Коммутатор один/ }),
  ).toContainText("abcde12345");
  await expect(
    history.getByText("Данные актуальны", { exact: true }),
  ).toHaveCount(0);
});

test("configuration metadata that has never arrived has an explicit empty state", async ({
  page,
}) => {
  const state = await relationsExchangeFixture(page);
  Object.assign(state.configuration, {
    source_status: "unavailable",
    stale: true,
    nodes: [],
    observed_at: null,
    last_success_at: null,
  });
  const history = await openOxidized(page);
  await expect(
    history.getByText("Данные ещё не получены", { exact: true }),
  ).toBeVisible();
  await expect(
    history.getByText("Данные актуальны", { exact: true }),
  ).toHaveCount(0);
  await expect(history.getByRole("table")).toHaveCount(0);
});

test("a resource card exposes only the configuration node explicitly bound to that resource", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await relationsExchangeFixture(page);
  await page.goto(`/#catalog?resourceId=${resourceOneID}`);
  const card = page.getByRole("dialog", {
    name: "Коммутатор один",
    exact: true,
  });
  const history = card.getByRole("region", {
    name: "Конфигурации устройства",
    exact: true,
  });
  await expect(
    history.getByRole("row", { name: /Коммутатор один/ }),
  ).toBeVisible();
  await expect(
    history.getByRole("row", { name: /Коммутатор два/ }),
  ).toHaveCount(0);
  await expect(
    history.getByRole("link", { name: "История", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("a new Oxidized integration and manual resource binding are saved explicitly despite an unavailable probe", async ({
  page,
}) => {
  const state = await relationsExchangeFixture(page);
  await page.goto("/#settings?section=integrations");
  await page
    .getByRole("button", { name: "Добавить подключение", exact: true })
    .click();
  await page
    .getByLabel("Название", { exact: true })
    .fill("Дополнительный Oxidized");
  await page
    .getByLabel("Тип источника", { exact: true })
    .selectOption("oxidized");
  await page
    .getByLabel("Адрес сервиса", { exact: true })
    .fill("https://secondary-oxidized.example.test");
  await page
    .getByLabel("Репозиторий Gitea", { exact: true })
    .fill("https://git.example.test/network/secondary");
  await page.getByLabel("Ветка Gitea", { exact: true }).fill("network-configs");
  await page
    .getByLabel("Устройство в Oxidized", { exact: true })
    .fill("lab/secondary-switch");
  await page
    .getByLabel("Ресурс каталога", { exact: true })
    .selectOption(resourceTwoID);
  await page
    .getByRole("button", { name: "Добавить соответствие", exact: true })
    .click();
  expect(
    state.base.requests.filter((entry) =>
      ["PUT", "POST"].includes(entry.method),
    ),
  ).toHaveLength(0);
  await page
    .getByRole("button", { name: "Проверить подключение", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Проверка подключения", exact: true }),
  ).toContainText(state.base.probeMessage);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page).toHaveURL(/integration=integration-new/);
  const saved = state.base.integrations.find(
    (item) => item.id === "integration-new",
  )!;
  expect(saved.kind).toBe("oxidized");
  expect(saved.config.gitea_branch).toBe("network-configs");
  expect(JSON.parse(saved.config.node_bindings)).toEqual({
    "lab/secondary-switch": resourceTwoID,
  });
});

test("switching from an edited Oxidized binding to another connection preserves selection until the draft is discarded", async ({
  page,
}) => {
  const state = await relationsExchangeFixture(page);
  await openOxidized(page);
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await page.getByLabel("Ветка Gitea", { exact: true }).fill("candidate");
  await page
    .getByLabel("Ресурс для lab/switch-one", { exact: true })
    .selectOption(resourceTwoID);
  const otherConnection = integrationList(page).getByRole("button", {
    name: /Основной Prometheus/,
  });
  await otherConnection.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Остаться", exact: true })
    .click();
  await expect(page.getByLabel("Ветка Gitea", { exact: true })).toHaveValue(
    "candidate",
  );
  await expect(
    integrationList(page).getByRole("button", {
      name: /История конфигураций сети/,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await otherConnection.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Отбросить", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Основной Prometheus", exact: true }),
  ).toBeVisible();
  expect(
    state.base.integrations.find((item) => item.id === oxidizedID)?.config
      .gitea_branch,
  ).toBe("main");
  expect(JSON.parse(state.oxidized.config.node_bindings)).toEqual({
    "lab/switch-one": resourceOneID,
  });
  expect(
    state.base.requests.filter((entry) => entry.method === "PUT"),
  ).toHaveLength(0);
});

for (const viewport of [{ width: 1920, height: 1080 }]) {
  for (const theme of ["dark", "light"]) {
    test(`connections desktop ${viewport.width} ${theme} preserves list context without document overflow`, async ({
      page,
      browserName,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize(viewport);
      await page.addInitScript(
        (value) => localStorage.setItem("pl-ui-theme", value),
        theme,
      );
      await relationsExchangeFixture(page, { manyIntegrations: true });
      await openOxidized(page);
      const list = integrationList(page);
      const selected = list.getByRole("button", {
        name: /История конфигураций сети/,
      });
      await selected.click();
      const scroll = await list.evaluate((element) => element.scrollTop);
      expect(scroll).toBeGreaterThan(0);
      await expect(
        page
          .getByRole("region", { name: "Конфигурации устройств", exact: true })
          .getByRole("row", { name: /Коммутатор один/ }),
      ).toBeVisible();
      const evidence = process.env.CONNECTIONS_UI_EVIDENCE;
      if (evidence)
        await page.screenshot({
          path: `${evidence}/${browserName}-${viewport.width}-${theme}-oxidized.png`,
        });
      await page.getByRole("button", { name: "Изменить", exact: true }).click();
      await page.getByLabel("Ветка Gitea", { exact: true }).fill("candidate");
      await expect
        .poll(() => list.evaluate((element) => element.scrollTop))
        .toBe(scroll);
      await page
        .getByRole("button", { name: "Отменить изменения", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Закрыть форму", exact: true })
        .click();
      await expect(selected).toHaveAttribute("aria-pressed", "true");
      await expect
        .poll(() => list.evaluate((element) => element.scrollTop))
        .toBe(scroll);
      const geometry = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
      expect(errors).toEqual([]);
    });
  }
}
