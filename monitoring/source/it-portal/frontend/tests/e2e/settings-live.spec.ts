import { expect, test } from "@playwright/test";

// Explicitly opt in only with TestSettingsBrowserFixture running. This scenario
// uses browser requests, the real Go handlers and a disposable PostgreSQL schema;
// it installs no route mocks and starts no production provider/worker.
test.skip(
  process.env.PORTAL_SETTINGS_LIVE !== "true",
  "local Go/PostgreSQL fixture required",
);

test("settings persist through the real API and show their detailed history", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("PORTAL_E2E_URL is required");
  const origin = new URL(baseURL).origin;
  const login = await page.request.post("/auth/demo", {
    headers: { Origin: origin },
    data: { role: "admin" },
  });
  expect(login.status()).toBe(200);
  const session = await (await page.request.get("/api/v1/session")).json();
  const help = await page.request.patch("/api/v1/help-state", {
    headers: { Origin: origin, "X-CSRF-Token": session.csrf_token },
    data: { disabled: true },
  });
  expect(help.status()).toBe(200);
  const initialResponse = await page.request.get("/api/v1/settings");
  expect(initialResponse.status()).toBe(200);
  const initial = await initialResponse.json();
  const initialSources = await (
    await page.request.get("/api/v1/integrations")
  ).json();
  const initialSource = initialSources.find(
    (source: { id: string }) => source.id === "settings-browser-source",
  );
  expect(initialSource).toBeTruthy();

  await page.goto("/#settings");
  await expect(
    page.getByRole("heading", { name: "Обзор", exact: true }),
  ).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "Разделы настроек" });
  await navigation
    .getByRole("button", { name: "Интеграции", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Подключения", exact: true })
    .getByRole("button")
    .first()
    .click();
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  const newName = "Проверенный локальный Prometheus · " + Date.now();
  await page.getByLabel("Название", { exact: true }).fill(newName);
  const probeResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/settings-workspace/probe") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Проверить подключение", exact: true })
    .click();
  const checked = await probeResponse;
  expect(checked.status()).toBe(200);
  expect((await checked.json()).status).toBe("connected");
  await expect(
    page
      .getByRole("region", { name: "Проверка подключения", exact: true })
      .getByRole("status"),
  ).toContainText("Подключение успешно. Источник ответил на запрос API.");
  const integrationResponse = page.waitForResponse(
    (response) =>
      response
        .url()
        .endsWith("/settings-workspace/integrations/settings-browser-source") &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect((await integrationResponse).status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: newName, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "История", exact: true }).click();
  const integrationHistory = page.getByRole("region", {
    name: "История изменений",
    exact: true,
  });
  const latestIntegration = integrationHistory.getByRole("listitem").first();
  const nameChange = latestIntegration.getByRole("row").filter({
    has: page.getByRole("rowheader", { name: "Название", exact: true }),
  });
  await expect(nameChange).toContainText(initialSource.name);
  await expect(nameChange).toContainText(newName);
  await expect(
    latestIntegration.getByText("Демо · IT", { exact: true }),
  ).toBeVisible();

  await navigation
    .getByRole("button", { name: "Общие параметры", exact: true })
    .click();
  const newThreshold = initial.stale_after_seconds === 300 ? 360 : 300;
  await page.getByLabel(/Порог устаревания/).fill(String(newThreshold));
  const generalResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/settings-workspace/general") &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  const savedResponse = await generalResponse;
  expect(savedResponse.status()).toBe(200);
  const saved = await savedResponse.json();
  expect(saved.stale_after_seconds).toBe(newThreshold);
  expect(saved.board_enabled).toBe(initial.board_enabled);
  expect(saved.board_anonymous).toBe(initial.board_anonymous);
  expect(saved.board_title).toBe(initial.board_title);
  expect(saved.board_resource_ids).toEqual(initial.board_resource_ids);
  await page.getByRole("button", { name: "История", exact: true }).click();
  const generalHistory = page.getByRole("region", {
    name: "История изменений",
    exact: true,
  });
  const thresholdChange = generalHistory
    .getByRole("listitem")
    .first()
    .getByRole("row")
    .filter({
      has: page.getByRole("rowheader", {
        name: "Порог устаревания, с",
        exact: true,
      }),
    });
  await expect(thresholdChange).toContainText(
    String(initial.stale_after_seconds),
  );
  await expect(thresholdChange).toContainText(String(newThreshold));

  // Read-back after a browser reload proves the result is persisted rather than
  // supplied only from the React mutation cache.
  await page.reload();
  const persistedSettings = await page.request.get("/api/v1/settings");
  expect((await persistedSettings.json()).stale_after_seconds).toBe(
    newThreshold,
  );
  const persistedSources = await page.request.get("/api/v1/integrations");
  expect(
    (await persistedSources.json()).find(
      (source: { id: string }) => source.id === "settings-browser-source",
    ).name,
  ).toBe(newName);
});
