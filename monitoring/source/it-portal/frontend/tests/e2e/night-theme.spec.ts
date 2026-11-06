import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { settingsWorkspaceFixture } from "../fixtures/settingsWorkspace";

// UI acceptance only: local API fixtures, no login, provider probes, scans or saves.
const proxyStatus = JSON.parse(
  readFileSync(
    new URL(
      "../../../internal/server/testdata/proxy-control/status.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const selectors = [
  "body",
  ".sidebar",
  ".topbar",
  ".panel",
  ".favorite-card",
  ".resource-list",
  ".resource-row",
  ".settings-group",
  ".settings-inspector",
  "input",
  "select",
  ".button",
  ".dialog-content",
  ".pl-ui-theme-menu",
  ".auth-scene",
];
test.use({ reducedMotion: "reduce" });

async function fixture(page: Page, theme: string) {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.pathname.startsWith("/auth/")
    )
      return route.abort();
    return route.continue();
  });
  const state = await settingsWorkspaceFixture(page);
  await page.route("**/api/v1/session", (route) => {
    if (new URL(page.url()).pathname !== "/401") return route.fallback();
    return route.fulfill({
      json: { authenticated: false, ad_login_enabled: true },
    });
  });
  await page.route("**/api/v1/proxy-control/history**", (route) =>
    route.fulfill({ json: { history: [] } }),
  );
  await page.route("**/api/v1/proxy-control/status", (route) =>
    route.fulfill({ json: proxyStatus }),
  );
  await page.route("**/api/v1/event-journal**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/view")
        ? { initialized: true }
        : { items: [], next_cursor: "", initialized: true },
    }),
  );
  await page.addInitScript((value) => {
    if (!localStorage.getItem("pl-ui-theme"))
      localStorage.setItem("pl-ui-theme", value);
  }, theme);
  return state;
}
async function expectNight(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
  await expect(page.locator("html")).toHaveAttribute(
    "data-pl-ui-theme-kind",
    "custom",
  );
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(16, 17, 18)",
  );
}
async function noOverflow(page: Page) {
  const pathname = new URL(page.url()).pathname;
  if (
    ["/403", "/404"].includes(pathname) &&
    page.viewportSize()?.width === 1920
  ) {
    // Existing error-art geometry overflows by 27px at 1920 (2026-11-02).
    // Color-only scope: prove the adapter does not change or enlarge that baseline.
    const baseline = await page.evaluate(() => {
      const sheet = document.querySelector<HTMLStyleElement>(
        'style[data-vite-dev-id$="/night-theme.css"]',
      )?.sheet;
      if (!sheet) throw new Error("Night theme Vite stylesheet was not found");
      const enabled = document.documentElement.scrollWidth;
      sheet.disabled = true;
      const disabled = document.documentElement.scrollWidth;
      sheet.disabled = false;
      const offender = document
        .querySelector(".auth-art-line-two")
        ?.getBoundingClientRect();
      return {
        enabled,
        disabled,
        viewport: innerWidth,
        errorArtRight: offender?.right,
      };
    });
    expect(baseline.enabled).toBe(baseline.disabled);
    expect(baseline.enabled - baseline.viewport).toBeLessThanOrEqual(27);
    test.info().annotations.push({
      type: "known-baseline",
      description: `${pathname}: existing 27px error-art overflow; unchanged with adapter disabled`,
    });
    await test.info().attach(`${pathname.slice(1)}-overflow-baseline`, {
      body: JSON.stringify(baseline, null, 2),
      contentType: "application/json",
    });
    return;
  }
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
}

async function appearance(page: Page, compare = false) {
  return page.evaluate(
    ({ list, compare }) => {
      const snapshot = () => {
        const values: Record<string, unknown> = {};
        for (const selector of list)
          values[selector] = Array.from(
            document.querySelectorAll<HTMLElement>(selector),
          )
            .filter((element) => element.getClientRects().length)
            .slice(0, 3)
            .map((element) => {
              const css = getComputedStyle(element),
                rect = element.getBoundingClientRect();
              return {
                color: css.color,
                background: css.backgroundColor,
                image: css.backgroundImage,
                border: css.borderColor,
                shadow: css.boxShadow,
                filter: css.filter,
                geometry: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                  padding: css.padding,
                  margin: css.margin,
                  borderWidth: css.borderWidth,
                  radius: css.borderRadius,
                  font: css.font,
                  display: css.display,
                  gap: css.gap,
                },
              };
            });
        return values;
      };
      if (!compare) return snapshot();
      const style = document.querySelector<HTMLStyleElement>(
        'style[data-vite-dev-id$="/night-theme.css"]',
      );
      if (!style?.sheet)
        throw new Error("Night theme Vite stylesheet was not found");
      const enabled = snapshot();
      style.sheet.disabled = true;
      const disabled = snapshot();
      style.sheet.disabled = false;
      return { enabled, disabled, reenabled: snapshot() };
    },
    { list: selectors, compare },
  );
}
async function capture(page: Page, info: TestInfo, name: string) {
  await noOverflow(page);
  await info.attach(`${name}-computed`, {
    body: JSON.stringify(await appearance(page), null, 2),
    contentType: "application/json",
  });
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    animations: "disabled",
  });
}
async function generalSettings(page: Page) {
  await page.goto("/#settings");
  await page
    .getByRole("navigation", { name: "Разделы настроек" })
    .getByRole("button", { name: "Общие параметры", exact: true })
    .click();
  await expect(page.getByLabel("Часовой пояс", { exact: true })).toBeVisible();
}
async function dirtyDialog(page: Page) {
  await page.getByLabel(/Порог устаревания/).fill("240");
  await page
    .getByRole("navigation", { name: "Разделы настроек" })
    .getByRole("button", { name: "Справочники", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
for (const [width, height] of [
  [1920, 1080],
  [3440, 1440],
]) {
  test(`Night menu, persistence, settings and dialog ${width}`, async ({
    page,
  }, info) => {
    const state = await fixture(page, "dark");
    await page.setViewportSize({ width, height });
    await generalSettings(page);
    const trigger = page.getByRole("button", { name: "Выбрать тему" });
    const menu = page.getByRole("menu", { name: "Тема оформления" });
    await trigger.hover();
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitemradio", { name: "Хэллоуин" }).click();
    await expectNight(page);
    await expect(menu).toBeHidden();
    await page.reload();
    await expectNight(page);
    await generalSettings(page);
    await trigger.click();
    await page.mouse.move(600, 400);
    await expect(menu).toBeVisible();
    await expect(
      menu.getByRole("menuitemradio", { name: "Хэллоуин" }),
    ).toHaveAttribute("aria-checked", "true");
    await capture(page, info, `night-menu-${width}`);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await capture(page, info, `night-settings-${width}`);
    await dirtyDialog(page);
    await capture(page, info, `night-dialog-${width}`);
    const dialog = page.getByRole("dialog");
    expect(
      await dialog.evaluate((element) => getComputedStyle(element).boxShadow),
    ).not.toBe("none");
    await dialog.getByRole("button", { name: /Остаться/ }).click();
    expect(
      state.requests.filter((request) => request.method !== "GET"),
    ).toEqual([]);
    await page.goto("/403");
    await expect(
      page.getByRole("heading", { name: "Нет доступа" }),
    ).toBeVisible();
    await capture(page, info, `night-error-${width}`);
  });
  test(`Night own routes remain usable without overflow ${width}`, async ({
    page,
  }, info) => {
    await fixture(page, "night");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height });
    const routes = [
      ["/", ".home-intro"],
      ["/#catalog", ".resource-list"],
      ["/#events", ".events-workspace"],
      ["/#tools", ".workspace-drawer"],
      ["/proxy-4.14", ".proxy-modes"],
      ["/401", ".auth-scene"],
      ["/403", ".shell-error-scene"],
      ["/404", ".shell-error-scene"],
    ];
    for (const [url, ready] of routes)
      await test.step(url, async () => {
        await page.goto(url);
        await expect(page.locator(ready).first()).toBeVisible();
        await expectNight(page);
        await noOverflow(page);
      });
    expect(errors).toEqual([]);
    await info.attach("route-coverage", {
      body: JSON.stringify(routes),
      contentType: "application/json",
    });
  });
  for (const theme of ["dark", "light"])
    test(`${theme} palette and geometry ignore the Night adapter ${width}`, async ({
      page,
    }, info) => {
      await fixture(page, theme);
      await page.setViewportSize({ width, height });
      for (const route of ["/", "/#catalog", "/#settings"]) {
        await page.goto(route);
        await expect(page.locator(".topbar")).toBeVisible();
        if (route === "/#catalog")
          await expect(page.locator(".resource-list")).toBeVisible();
        if (route === "/#settings") {
          await generalSettings(page);
          await dirtyDialog(page);
        }
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.locator("html")).toHaveAttribute(
          "data-pl-ui-theme-kind",
          "legacy",
        );
        // One browser task prevents asynchronous dialog autofocus from changing
        // focus between samples; stylesheet changes still force fresh CSS/layout.
        const samples = await appearance(page, true);
        expect(
          samples.disabled,
          `${route}: disabling custom CSS must change nothing`,
        ).toEqual(samples.enabled);
        expect(
          samples.reenabled,
          `${route}: re-enabling custom CSS must change nothing`,
        ).toEqual(samples.enabled);
        await noOverflow(page);
        await info.attach(
          `${theme}-${route.replace(/[^a-z]/g, "") || "home"}-${width}`,
          {
            body: JSON.stringify(samples, null, 2),
            contentType: "application/json",
          },
        );
      }
    });
}
