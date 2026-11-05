import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

test("generated example uses the shared shell and preserves logout errors", async ({
  page,
}) => {
  const parent = mkdtempSync(join(tmpdir(), "pl-ui-scaffold-"));
  const candidate = join(parent, "candidate");
  try {
    execFileSync("python3", [
      resolve("../deploy/scaffold-service.py"),
      "--name",
      "example-app",
      "--prefix",
      "/example-app/",
      "--upstream",
      "http://example-app:8080",
      "--output",
      candidate,
    ]);
    await page.route("**/example-app/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: readFileSync(join(candidate, "ui.example.html")),
      }),
    );
    await page.route("**/example-app/static/app.js", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: readFileSync(join(candidate, "ui.example.js")),
      }),
    );
    await page.route("**/api/v1/session", (route) =>
      route.fulfill({
        json: {
          authenticated: true,
          user: { name: "Тестовый пользователь" },
          csrf_token: "test-csrf",
        },
      }),
    );
    await page.route("**/auth/logout", (route) => {
      expect(route.request().headers()["x-csrf-token"]).toBe("test-csrf");
      return route.fulfill({ status: 503 });
    });
    await page.goto("/example-app/");
    await expect(
      page.getByRole("heading", { name: "example-app" }),
    ).toBeVisible();
    await expect(page.locator(".pl-ui-user-info")).toContainText(
      "Тестовый пользователь",
    );
    await expect(
      page.getByRole("button", { name: "Выбрать тему" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Свернуть меню" }).click();
    await expect(page.locator(".pl-ui-shell")).toHaveClass(/sidebar-collapsed/);
    await page.getByRole("button", { name: "Выйти" }).click();
    await expect(page.getByRole("alert")).toContainText("Не удалось выйти");
    await expect(page).toHaveURL(/\/example-app\/$/);
    await page.route("**/api/v1/session", (route) =>
      route.fulfill({ status: 503 }),
    );
    await page.reload();
    await expect(page.locator(".pl-ui-shell")).toHaveCount(0);
    await expect(page.locator("#app")).toContainText(
      "Не удалось проверить сессию",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
