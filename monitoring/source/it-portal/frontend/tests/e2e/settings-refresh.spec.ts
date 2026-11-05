import { expect, test } from "@playwright/test";
import { settingsWorkspaceFixture } from "../fixtures/settingsWorkspace";

test("retrying a lost refresh status does not start a second collection", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await settingsWorkspaceFixture(page);
  await page.route("**/api/v1/stream", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "retry: 60000\n\n",
    }),
  );
  let collections = 0;
  let statusReads = 0;
  await page.route(
    "**/api/v1/integrations/prometheus-main/refresh",
    (route) => {
      collections++;
      return route.fulfill({
        status: 202,
        json: { id: "settings-refresh-job", status: "queued" },
      });
    },
  );
  await page.route("**/api/v1/jobs/settings-refresh-job", (route) => {
    statusReads++;
    if (statusReads === 1)
      return route.fulfill({
        status: 503,
        json: { message: "Не удалось уточнить состояние задания" },
      });
    return route.fulfill({
      json: { id: "settings-refresh-job", status: "succeeded" },
    });
  });
  await page.goto(
    "/#settings?section=integrations&integration=prometheus-main",
  );
  await page
    .getByRole("button", { name: "Получить данные", exact: true })
    .click();
  await expect
    .poll(() => collections, {
      message: "Один запрос получения данных после нажатия",
    })
    .toBe(1);
  await expect
    .poll(() => statusReads, { message: "Прочитан статус запущенного задания" })
    .toBe(1);
  expect(pageErrors).toEqual([]);
  const failure = page
    .getByRole("alert")
    .filter({ hasText: "Не удалось уточнить состояние задания" });
  await expect(failure).toBeVisible();
  expect(collections).toBe(1);
  await failure.getByRole("button").click();
  await expect(
    page.getByText("Данные обновлены", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Получить данные", exact: true }),
  ).toBeEnabled();
  expect(collections).toBe(1);
  expect(statusReads).toBe(2);
});
