import { test, expect, type Page } from "@playwright/test";
import type { SFTPState, SFTPVersion } from "../../src/sftpData";

test.use({ reducedMotion: "reduce" });
const filename = "ufa-2026-10-21.zip";
const versionId = "36c064f4-a2e3-4ce3-9c65-7e4b461a4acc";
type Mode = "success" | "failed" | "uncertain" | "malformed" | "refresh-failed";
async function setup(
  page: Page,
  {
    mode = "success",
    admin = true,
    hold = false,
    download = true,
    initialState = "",
  }: {
    mode?: Mode;
    admin?: boolean;
    hold?: boolean;
    download?: boolean;
    initialState?: SFTPVersion["deletion_state"];
  } = {},
) {
  let deletes = 0;
  let gets = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let version: SFTPVersion = {
    id: versionId,
    collection_id: "folder",
    filename,
    size_bytes: 104857600,
    sha256: "a".repeat(64),
    received_at: "2026-10-21T10:00:00Z",
    received_by: "ufa-sender",
    received_by_name: "Уфа",
    is_new: true,
    source: "sftpgo",
    can_download: admin && download,
    can_delete: true,
    deletion_state: initialState,
  };
  const state = (): SFTPState => ({
    mode: "connected",
    sftp_connected: true,
    demo_upload_enabled: false,
    can_manage: admin,
    retention_months: 2,
    collections: [
      {
        id: "folder",
        revision: 1,
        branch: "Уфа",
        label: "База филиала",
        folder: "ufa",
        quota_bytes: 10737418240,
        created_at: "2026-10-20T10:00:00Z",
        reader_ids: [],
      },
    ],
    accounts: [],
    versions: [version],
    audit: [],
    versions_total: 1,
    provider: {
      configured: true,
      status: "healthy",
      last_attempt_at: "2026-10-21T10:00:00Z",
      last_success_at: "2026-10-21T10:00:00Z",
      error: "",
    },
  });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (
      path === `/api/v1/sftp-server/versions/${versionId}` &&
      route.request().method() === "DELETE"
    ) {
      deletes++;
      expect(route.request().headers()["x-csrf-token"]).toBe("delete-fixture");
      expect(route.request().postData()).toBeNull();
      if (hold) await gate;
      if (mode === "failed") {
        version = { ...version, deletion_state: "failed" };
        await route.fulfill({
          status: 502,
          json: {
            error: "delete_failed",
            message: "SFTPGo отклонил удаление файла",
          },
        });
        return;
      }
      if (mode === "uncertain") {
        version = {
          ...version,
          deletion_state: "uncertain",
          can_download: false,
        };
        await route.fulfill({
          status: 503,
          json: {
            error: "delete_uncertain",
            message: "Результат удаления неизвестен",
          },
        });
        return;
      }
      if (mode === "malformed") {
        await route.fulfill({ json: { status: "pending" } });
        return;
      }
      version = {
        ...version,
        deletion_state: "deleted",
        can_delete: false,
        can_download: false,
        is_new: false,
        deleted_at: "2026-10-21T10:30:00Z",
        deleted_by: "admin",
      };
      await route.fulfill({
        json: {
          status: "deleted",
          deleted_at: version.deleted_at,
          deleted_by: version.deleted_by,
        },
      });
      return;
    }
    if (path === "/api/v1/sftp-server") {
      gets++;
      if (mode === "refresh-failed" && version.deletion_state === "deleted") {
        await route.fulfill({
          status: 503,
          json: { message: "Список временно недоступен" },
        });
        return;
      }
      await route.fulfill({ json: state() });
      return;
    }
    if (path.endsWith("/seen")) {
      version = { ...version, is_new: false };
      await route.fulfill({ status: 204 });
      return;
    }
    if (path === "/api/v1/sftp-server/access") {
      await route.fulfill({ status: 204 });
      return;
    }
    if (path === "/api/v1/session") {
      await route.fulfill({
        json: {
          authenticated: true,
          features: { sftp: true },
          user: {
            id: admin ? "admin" : "employee",
            name: admin ? "Администратор" : "Сотрудник",
            admin,
          },
          csrf_token: "delete-fixture",
          demo: false,
          board_enabled: true,
          timezone: "Europe/Moscow",
        },
      });
      return;
    }
    if (path === "/api/v1/help-state") {
      await route.fulfill({ json: { disabled: true, seen: [] } });
      return;
    }
    await route.fulfill({ json: {} });
  });
  return { deletes: () => deletes, gets: () => gets, release };
}
async function openDetail(page: Page) {
  await page.goto("/sftp-server");
  await page.getByRole("button", { name: new RegExp(filename) }).click();
  await expect(page.getByRole("dialog", { name: filename })).toBeVisible();
}
async function askDelete(page: Page) {
  await page
    .getByRole("button", { name: "Удалить с SFTP", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: `Удалить «${filename}» с SFTP?` }),
  ).toBeVisible();
}

for (const [width, height] of [[1920, 1080]] as const) {
  for (const theme of ["dark", "light"] as const) {
    test(`deletion confirms once and keeps tombstone history ${width} ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(
        (theme) => localStorage.setItem("pl-ui-theme", theme),
        theme,
      );
      const control = await setup(page, { hold: true });
      await openDetail(page);
      await askDelete(page);
      await expect(
        page.getByText("Копии в DFS не изменятся.", { exact: false }),
      ).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await page.screenshot({
        path: testInfo.outputPath("confirmation.png"),
        animations: "disabled",
      });
      await page.getByRole("button", { name: "Подтвердить удаление" }).click();
      await expect(
        page.getByRole("button", { name: "Удаляем…" }),
      ).toBeDisabled();
      await page.keyboard.press("Enter");
      expect(control.deletes()).toBe(1);
      control.release();
      await expect(page.getByRole("dialog").getByRole("status")).toContainText(
        "Удалён с SFTP",
      );
      await expect(
        page.getByRole("link", { name: "Скачать архив" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Удалить с SFTP", exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("button", { name: "Закрыть", exact: true })
        .last()
        .click();
      await expect(page.getByRole("table")).toHaveCount(0);
      await page.getByRole("checkbox", { name: "Показать удалённые" }).check();
      const row = page.getByRole("row").filter({ hasText: filename });
      await expect(row).toContainText("Удалён с SFTP");
      await expect(page.locator(".sftp-summary")).toContainText(
        "Получено версий1",
      );
      await expect(page.locator(".sftp-summary")).toContainText(
        "Объём в списке0 Б",
      );
      await expect(
        page.getByRole("button", { name: "Новые для вас: 0" }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath("deleted-history.png"),
        animations: "disabled",
      });
      expect(control.deletes()).toBe(1);
    });
  }
}
test("cancel confirmation keeps download and sends no DELETE", async ({
  page,
}) => {
  const control = await setup(page);
  await openDetail(page);
  await askDelete(page);
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: `Удалить «${filename}» с SFTP?` }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Скачать архив" })).toBeVisible();
  expect(control.deletes()).toBe(0);
});
test("employee cannot delete even with hostile can_delete metadata and no download grant", async ({
  page,
}) => {
  const control = await setup(page, { admin: false });
  await openDetail(page);
  await expect(
    page.getByRole("button", { name: "Удалить с SFTP", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Скачать архив" })).toHaveCount(
    0,
  );
  expect(control.deletes()).toBe(0);
});
for (const mode of ["failed", "uncertain", "malformed"] as const) {
  test(`${mode} response stays dialog-local, resyncs state and never retries deletion`, async ({
    page,
  }) => {
    const control = await setup(page, { mode });
    await openDetail(page);
    await askDelete(page);
    const before = control.gets();
    await page.getByRole("button", { name: "Подтвердить удаление" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
    await expect.poll(control.gets).toBeGreaterThan(before);
    await expect(
      page
        .getByRole("dialog")
        .getByRole("status")
        .filter({ hasText: "Удалён с SFTP" }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Обновить состояние", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(control.deletes()).toBe(1);
    await expect(
      page.getByRole("heading", { name: `Удалить «${filename}» с SFTP?` }),
    ).toHaveCount(0);
  });
}
test("confirmed deletion remains hidden and cannot download when subsequent metadata refresh fails", async ({
  page,
}) => {
  const control = await setup(page, { mode: "refresh-failed" });
  await openDetail(page);
  await askDelete(page);
  await page.getByRole("button", { name: "Подтвердить удаление" }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "Удалён с SFTP",
  );
  await expect(page.getByRole("link", { name: "Скачать архив" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Удаление подтверждено",
  );
  expect(control.deletes()).toBe(1);
});

test("administrator can explicitly reconcile pending deletion without a download grant", async ({
  page,
}) => {
  const control = await setup(page, {
    download: false,
    initialState: "pending",
  });
  await openDetail(page);
  await expect(page.getByRole("link", { name: "Скачать архив" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "Удаление выполняется",
  );
  await page
    .getByRole("button", { name: "Проверить удаление", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: `Проверить результат удаления «${filename}»?`,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Повторная команда удаления не отправляется.", {
      exact: false,
    }),
  ).toBeVisible();
  expect(control.deletes()).toBe(0);
  await page
    .getByRole("button", { name: "Проверить результат", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "Удалён с SFTP",
  );
  expect(control.deletes()).toBe(1);
});

test("uncertain deletion can only be explicitly checked and file presence never becomes success", async ({
  page,
}) => {
  const control = await setup(page, {
    mode: "uncertain",
    initialState: "uncertain",
  });
  await openDetail(page);
  await expect(
    page.getByRole("button", { name: "Удалить с SFTP", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Проверить удаление", exact: true })
    .click();
  await expect(
    page.getByText("Повторная команда удаления не отправляется.", {
      exact: false,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Проверить результат", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "Удаление не подтверждено",
  );
  await expect(
    page
      .getByRole("dialog")
      .getByRole("status")
      .filter({ hasText: "Удалён с SFTP" }),
  ).toHaveCount(0);
  expect(control.deletes()).toBe(1);
});
