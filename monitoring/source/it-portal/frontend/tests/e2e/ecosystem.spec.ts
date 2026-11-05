import { test, expect } from "@playwright/test";

test("shared theme survives reload and synchronizes portal tabs before login", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const other = await context.newPage();
  await other.goto("/");
  await page.getByRole("button", { name: "Выбрать тему", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "Светлая", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(other.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(
    other.getByRole("button", { name: "Выбрать тему", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("pl-ui-theme"))).toBe(
    "light",
  );
  await other
    .getByRole("button", { name: "Выбрать тему", exact: true })
    .click();
  await other
    .getByRole("menuitemradio", { name: "Тёмная", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await other.close();
});
