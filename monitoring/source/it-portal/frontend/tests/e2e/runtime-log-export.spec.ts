import { expect, test, type Page } from "@playwright/test";
import { settingsWorkspaceFixture } from "../fixtures/settingsWorkspace";

const exportPath = "/api/v1/runtime/log-export";
const archiveName = "pl-diagnostics-20261107T120000Z.zip";
const emptyZip = Buffer.from(
  "504b0506000000000000000000000000000000000000",
  "hex",
);

async function openLogExport(page: Page) {
  await settingsWorkspaceFixture(page);
  await page.route("**/api/v1/runtime", (route) =>
    route.fulfill({ json: { log_export_hours: [1, 6, 24, 72, 168] } }),
  );
  await page.goto("/#settings");
  await page
    .getByRole("button", { name: "Состояние сервера", exact: true })
    .click();
  const trigger = page.getByRole("button", {
    name: "Экспорт логов",
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Экспорт логов" });
  await expect(dialog).toBeVisible();
  return { dialog, trigger };
}

test("exports the selected period after a recoverable error", async ({
  page,
}) => {
  const { dialog, trigger } = await openLogExport(page);
  const periods: number[] = [];
  await page.route(`**${exportPath}`, async (route) => {
    const request = route.request();
    expect(request.method()).toBe("POST");
    expect(request.headers()["x-csrf-token"]).toBe("settings-test");
    periods.push(request.postDataJSON().hours);
    if (periods.length === 1) {
      return route.fulfill({
        status: 503,
        json: {
          error: "log_export_busy",
          message: "Сбор логов уже выполняется.",
        },
      });
    }
    await route.fulfill({
      contentType: "application/zip",
      headers: {
        "Content-Disposition": `attachment; filename="${archiveName}"`,
        "X-PL-Log-Export-Partial": "true",
      },
      body: emptyZip,
    });
  });

  const period = dialog.getByRole("combobox", { name: "Период" });
  const downloadButton = dialog.getByRole("button", { name: "Скачать ZIP" });
  await expect(period).toHaveValue("24");
  await period.selectOption("72");
  await downloadButton.click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Сбор логов уже выполняется.",
  );
  await expect(period).toHaveValue("72");

  const downloadReady = page.waitForEvent("download");
  await downloadButton.click();
  const download = await downloadReady;
  expect(download.suggestedFilename()).toBe(archiveName);
  expect(await download.failure()).toBeNull();
  expect(periods).toEqual([72, 72]);
  await expect(dialog.getByRole("status")).toContainText(
    "Часть источников недоступна или выгружена не полностью.",
  );
  await expect(dialog.getByRole("status")).toContainText("manifest.json");
  await dialog.getByRole("button", { name: "Готово" }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("closing the dialog cancels a pending export", async ({ page }) => {
  const { dialog, trigger } = await openLogExport(page);
  const { promise: release, resolve } = Promise.withResolvers<void>();
  await page.route(`**${exportPath}`, async (route) => {
    await release;
    await route.abort().catch(() => {});
  });
  const failed = page.waitForEvent(
    "requestfailed",
    (request) => new URL(request.url()).pathname === exportPath,
  );
  let downloads = 0;
  page.on("download", () => {
    downloads++;
  });
  const downloadButton = dialog.getByRole("button", { name: "Скачать ZIP" });
  try {
    await downloadButton.click();
    await expect(downloadButton).toBeDisabled();
    await expect(dialog.getByRole("status")).toHaveText("Собираем архив…");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    expect((await failed).failure()?.errorText).toContain("ERR_ABORTED");
    expect(downloads).toBe(0);
  } finally {
    resolve();
  }
});
