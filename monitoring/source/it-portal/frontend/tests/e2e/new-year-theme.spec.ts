import { expect, test, type Page } from "@playwright/test";
import { settingsWorkspaceFixture } from "../fixtures/settingsWorkspace";

test.use({ reducedMotion: "no-preference", forcedColors: "none" });

async function openSettings(page: Page) {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["localhost", "127.0.0.1"].includes(url.hostname) &&
      !url.pathname.startsWith("/auth/")
      ? route.continue()
      : route.abort();
  });
  await settingsWorkspaceFixture(page);
  await page.goto("/#settings");
}

function chooseTheme(page: Page, name: string) {
  return page
    .getByRole("menu", { name: "Тема оформления" })
    .getByRole("menuitemradio", { name, exact: true });
}

test("New Year snow stays behind settings and follows browser preferences", async ({
  page,
  context,
}, info) => {
  await openSettings(page);
  const other = await context.newPage();
  await openSettings(other);

  const root = page.locator("html");
  const shell = page.locator(".pl-ui-shell");
  const trigger = page.getByRole("button", { name: "Выбрать тему" });
  const snowfall = () =>
    shell.evaluate((element) => {
      const style = getComputedStyle(element, "::after");
      return { display: style.display, transform: style.transform };
    });
  const hasTree = () =>
    shell.locator(".pl-ui-app-body").evaluate((element) => {
      const style = getComputedStyle(element, "::before");
      return style.content !== "none" && style.backgroundImage.includes("url(");
    });

  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(trigger).toBeVisible();
  const legacy = await snowfall();
  await trigger.click();
  await chooseTheme(page, "Новогодняя").click();
  await expect(root).toHaveAttribute("data-pl-ui-color-scheme", "dark");
  await expect(other.locator("html")).toHaveAttribute("data-theme", "new-year");
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "new-year");

  const field = page.getByRole("searchbox", { name: "Поиск по настройкам" });
  await expect(field).toBeVisible();
  await expect.poll(hasTree).toBe(true);
  const first = await snowfall();
  expect(first.display).toBe("block");
  await expect
    .poll(async () => (await snowfall()).transform)
    .not.toBe(first.transform);

  for (const [width, height] of [
    [1920, 1080],
    [1920, 1200],
    [3440, 1440],
  ]) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await page.screenshot({
      path: info.outputPath(`new-year-${width}x${height}.png`),
    });
  }
  await field.click();
  await expect(field).toBeFocused();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(async () => (await snowfall()).display).toBe("none");
  await expect.poll(hasTree).toBe(true);
  await expect(root).toHaveAttribute("data-theme", "new-year");
  await page.emulateMedia({
    reducedMotion: "no-preference",
    forcedColors: "active",
  });
  await expect.poll(async () => (await snowfall()).display).toBe("none");
  await expect.poll(hasTree).toBe(false);

  await page.emulateMedia({ forcedColors: "none" });
  await trigger.click();
  await chooseTheme(page, "Тёмная").click();
  await expect(other.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(snowfall).toEqual(legacy);
});
