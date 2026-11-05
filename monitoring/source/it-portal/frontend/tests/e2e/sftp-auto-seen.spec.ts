import { test, expect, type Page } from "@playwright/test";
import type { SFTPState, SFTPVersion } from "../../src/sftpData";

const now = new Date("2026-10-23T09:00:00Z");
const firstId = "version-00";
const lastId = "version-39";
const rowFor = (page: Page, id = firstId) =>
  page.locator(`tr[data-version-id="${id}"]`);

async function setup(page: Page, { failFirst = false } = {}) {
  const acknowledgements: string[] = [];
  let failed = false;
  const versions: SFTPVersion[] = Array.from({ length: 40 }, (_, i) => ({
    id: `version-${String(i).padStart(2, "0")}`,
    collection_id: "ufa",
    filename: `ufa-${String(i).padStart(2, "0")}.zip`,
    size_bytes: 1048576,
    sha256: "a".repeat(64),
    received_at: new Date(now.getTime() - i * 60000).toISOString(),
    received_by: "ufa-sender",
    received_by_name: "Уфа",
    is_new: i === 0 || i === 39,
    source: "sftpgo",
    can_download: true,
    can_delete: true,
  }));
  const state = (): SFTPState => ({
    mode: "connected",
    sftp_connected: true,
    demo_upload_enabled: false,
    can_manage: true,
    retention_months: 2,
    collections: [
      {
        id: "ufa",
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
    versions,
    audit: [],
    versions_total: versions.length,
    provider: {
      configured: true,
      status: "healthy",
      last_attempt_at: now.toISOString(),
      last_success_at: now.toISOString(),
      error: "",
    },
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const seen = path.match(
      /^\/api\/v1\/sftp-server\/versions\/([^/]+)\/seen$/,
    );
    if (seen) {
      expect(request.method()).toBe("POST");
      expect(request.headers()["x-csrf-token"]).toBe("auto-seen-fixture");
      expect(request.postData()).toBeNull();
      acknowledgements.push(seen[1]);
      if (failFirst && !failed) {
        failed = true;
        await route.fulfill({
          status: 503,
          json: {
            error: "seen_unavailable",
            message: "Не удалось сохранить просмотр",
          },
        });
      } else {
        const version = versions.find((v) => v.id === seen[1]);
        expect(version).toBeDefined();
        version!.is_new = false;
        await route.fulfill({ status: 204 });
      }
      return;
    }
    if (path === "/api/v1/sftp-server") {
      await route.fulfill({ json: state() });
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
          user: { id: "admin", name: "Администратор", admin: true },
          csrf_token: "auto-seen-fixture",
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
  // Allow React Query's startup notifications to run before freezing timers.
  // Start hidden so startup time cannot consume any of the viewing interval.
  await page.clock.install({ time: now });
  await page.addInitScript(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
  });
  await page.goto("/sftp-server");
  await expect(rowFor(page)).toHaveClass(/sftp-new-row/);
  await page.clock.pauseAt(
    new Date((await page.evaluate(() => Date.now())) + 1000),
  );
  await setVisibility(page, "visible");
  await expect(rowFor(page)).toHaveClass(/sftp-seeing-row/);
  return { acknowledgements };
}

async function setVisibility(page: Page, state: "hidden" | "visible") {
  await page.evaluate((visibility) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => visibility === "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

test("visible version fades for four seconds then acknowledges once without a click", async ({
  page,
}) => {
  const control = await setup(page);
  const first = rowFor(page);
  const label = first.locator(".sftp-new-label");
  await expect(first).toHaveClass(/sftp-new-row/);
  await expect(label).toHaveText("Новая версия");
  const fade = await label.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      duration: style.transitionDuration,
      property: style.transitionProperty,
      timing: style.transitionTimingFunction,
    };
  });
  expect(fade).toEqual({
    duration: "4s",
    property: "opacity",
    timing: "linear",
  });
  await page.clock.runFor(3999);
  expect(control.acknowledgements).toEqual([]);
  await page.clock.runFor(1);
  await expect.poll(() => control.acknowledgements).toEqual([firstId]);
  await expect(first).toHaveClass(/sftp-seen-row/);
  await expect(label).toHaveCSS("opacity", "0");
  await page.clock.runFor(8000);
  expect(control.acknowledgements).toEqual([firstId]);
  await expect(rowFor(page, lastId)).toHaveClass(/sftp-new-row/);
});

test("scrolling out cancels the timer and returning requires four new seconds", async ({
  page,
}) => {
  const control = await setup(page);
  const first = rowFor(page);
  await page.clock.runFor(2000);
  await rowFor(page, lastId).evaluate((el) =>
    el.scrollIntoView({ block: "end" }),
  );
  await expect(first).not.toHaveClass(/sftp-seeing-row/);
  await expect(rowFor(page, lastId)).toHaveClass(/sftp-seeing-row/);
  await page.clock.runFor(2500);
  expect(control.acknowledgements).toEqual([]);
  await first.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await expect(first).toHaveClass(/sftp-seeing-row/);
  await expect(rowFor(page, lastId)).not.toHaveClass(/sftp-seeing-row/);
  await page.clock.runFor(3999);
  expect(control.acknowledgements).toEqual([]);
  await page.clock.runFor(1);
  await expect.poll(() => control.acknowledgements).toEqual([firstId]);
});

test("hidden document cancels progress and becoming visible starts a full interval", async ({
  page,
}) => {
  const control = await setup(page);
  await page.clock.runFor(2000);
  await setVisibility(page, "hidden");
  await expect(rowFor(page)).not.toHaveClass(/sftp-seeing-row/);
  await page.clock.runFor(10000);
  expect(control.acknowledgements).toEqual([]);
  await setVisibility(page, "visible");
  await expect(rowFor(page)).toHaveClass(/sftp-seeing-row/);
  await page.clock.runFor(3999);
  expect(control.acknowledgements).toEqual([]);
  await page.clock.runFor(1);
  await expect.poll(() => control.acknowledgements).toEqual([firstId]);
});

test("opening details does not immediately acknowledge the version", async ({
  page,
}) => {
  const control = await setup(page);
  await rowFor(page)
    .getByRole("button", { name: "Подробнее", exact: true })
    .click();
  await expect(page.getByRole("dialog", { name: "ufa-00.zip" })).toBeVisible();
  expect(control.acknowledgements).toEqual([]);
  await expect(rowFor(page)).toHaveClass(/sftp-new-row/);
});

test("failed acknowledgement keeps the version new and explicit retry can save it", async ({
  page,
}) => {
  const control = await setup(page, { failFirst: true });
  await page.clock.runFor(4000);
  await expect.poll(() => control.acknowledgements).toEqual([firstId]);
  await expect(page.getByRole("alert")).toContainText(
    "Не удалось сохранить просмотр",
  );
  await expect(rowFor(page)).toHaveClass(/sftp-new-row/);
  await expect(rowFor(page)).not.toHaveClass(/sftp-seen-row/);
  await expect(rowFor(page).locator(".sftp-new-label")).toHaveCSS(
    "opacity",
    "1",
  );
  await page.clock.runFor(10000);
  expect(control.acknowledgements).toEqual([firstId]);
  await page.getByRole("button", { name: /Повторить/ }).click();
  await expect(rowFor(page)).toHaveClass(/sftp-seeing-row/);
  await page.clock.runFor(4000);
  await expect.poll(() => control.acknowledgements).toEqual([firstId, firstId]);
  await expect(rowFor(page)).toHaveClass(/sftp-seen-row/);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
