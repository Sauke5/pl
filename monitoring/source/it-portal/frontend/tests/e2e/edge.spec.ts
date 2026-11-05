import { test, expect } from "@playwright/test";
import { localProxyFixture, expectNoLegacyCalls } from "./local-proxy-fixture";

for (const theme of ["dark", "light"]) {
  test(`Removed Edge route displays a missing page without contacting infrastructure (${theme})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.addInitScript(
      (value) => localStorage.setItem("pl-ui-theme", value),
      theme,
    );
    const f = await localProxyFixture(page);
    await page.goto("/#edge");
    await expect(
      page.getByRole("heading", { name: "Страница не найдена", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edge", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Обновить", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expectNoLegacyCalls(f.calls);
    await page.screenshot({
      path: info.outputPath(`removed-edge-${theme}.png`),
    });
  });
}
test("Legacy office proxy address cannot open the old company control panel", async ({
  page,
}) => {
  const f = await localProxyFixture(page);
  await page.goto("/proxy-4.14");
  await expect(
    page.getByRole("heading", { name: "Xray", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Текущая схема Xray")).toContainText(
    "127.0.0.1:1080",
  );
  await expect(
    page.getByRole("heading", { name: "Прокси офиса", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edge", exact: true }),
  ).toHaveCount(0);
  expectNoLegacyCalls(f.calls);
});
