import { test, expect } from "@playwright/test";

const origin = "http://localhost:18098";
test.skip(process.env.PORTAL_E2E_URL !== origin, "Explicit isolated release runtime required");

test("real release session reaches Edge, corporate proxy and Wayline", async ({ page }, testInfo) => {
  const login = await page.request.post(`${origin}/auth/demo`, {
    headers: { Origin: origin }, data: { role: "admin" },
  });
  expect(login.status()).toBe(200);
  const session = await (await page.request.get(`${origin}/api/v1/session`)).json();
  const help = await page.request.patch(`${origin}/api/v1/help-state`, {
    headers: { Origin: origin, "X-CSRF-Token": session.csrf_token },
    data: { disabled: true },
  });
  expect(help.status()).toBe(200);
  await page.goto("/#edge");
  await expect(page.getByText("Edge не подключён", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Корпоративный прокси", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/proxy-4.14`);
  await expect(page.getByRole("alert").first()).toContainText("пока не подключён");
  await page.goto("/wayline/");
  await expect(page.getByRole("navigation", { name: "Основные разделы" }).getByRole("link", { name: "Обзор сети", exact: true })).toBeVisible();
  await expect(page.getByText("Демо · IT", { exact: true })).toBeVisible();
  await expect(page.getByText("Нет целей для проверки", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("wayline.png"), fullPage: true });
  await page.getByRole("link", { name: "Платформа", exact: true }).first().click();
  await expect(page).toHaveURL(`${origin}/`);
});
