import { test, expect } from "@playwright/test";

for (const target of ["/directory/", "/audit/", "/audit-arch/", "/netmap/"]) {
  for (const mode of ["authenticated", "ad", "oidc"]) {
    test(`Service ${target} login return ${mode}`, async ({ page }) => {
      let authenticated = mode === "authenticated";
      await page.route("**/api/v1/**", (route) =>
        route.fulfill({
          json: new URL(route.request().url()).pathname.endsWith("/session")
            ? {
                authenticated,
                user: authenticated
                  ? { id: "viewer", name: "Тест", admin: false }
                  : undefined,
                csrf_token: "test",
                ad_login_enabled: true,
                oidc_login_enabled: true,
                board_anonymous_enabled: false,
              }
            : {},
        }),
      );
      await page.route("**" + target, (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: "<h1>Адресная книга</h1>",
        }),
      );
      await page.route("**/auth/ad", (route) => {
        authenticated = true;
        return route.fulfill({ json: {} });
      });
      await page.route("**/auth/login", (route) => {
        authenticated = true;
        return route.fulfill({ status: 302, headers: { Location: "/" } });
      });
      await page.goto("/?return_to=" + encodeURIComponent(target));
      if (mode !== "authenticated") {
        await expect(page.locator(".auth-login")).toBeVisible();
        await expect
          .poll(() =>
            page.evaluate(() => sessionStorage.getItem("pl-ui-login-return")),
          )
          .toBe(target);
        if (mode === "ad") {
          await page
            .locator(".domain-login input[autocomplete=username]")
            .fill("test");
          await page
            .locator(".domain-login input[type=password]")
            .fill("fixture-only");
          await page.locator(".domain-login button[type=submit]").click();
        } else await page.locator('a[href="/auth/login"]').click();
      }
      await expect.poll(() => new URL(page.url()).pathname).toBe(target);
      await expect(
        page.getByRole("heading", { name: "Адресная книга" }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => sessionStorage.getItem("pl-ui-login-return")),
      ).toBeNull();
      await page.goto("/");
      await expect(page.locator(".employee-shell")).toBeVisible();
      await expect(page).toHaveURL(/\/$/);
    });
  }
}

test("Service login rejects other redirect destinations and stale pending value", async ({
  page,
}) => {
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/session")
        ? {
            authenticated: true,
            user: { id: "viewer", name: "Тест", admin: false },
            csrf_token: "test",
          }
        : {},
    }),
  );
  for (const target of [
    "https://example.org/",
    "//example.org/",
    "/directory/?next=external",
    "/audit/?next=external",
    "/audit-arch/?next=external",
    "/audit-arch/../audit/",
    "/audit-arch//example.org/",
    "/audit-arch%2f",
    "/netmap/#external",
    "/audit/../admin/",
    "/netmap//example.org/",
    "/audit%2f",
    "/audit/\\example.org",
  ]) {
    await page.goto("/?return_to=" + encodeURIComponent(target));
    await expect(page.locator(".employee-shell")).toBeVisible();
    expect(new URL(page.url()).searchParams.get("return_to")).toBe(target);
  }
  await page.evaluate(() =>
    sessionStorage.setItem("pl-ui-login-return", "https://example.org/"),
  );
  await page.goto("/");
  await expect(page.locator(".employee-shell")).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem("pl-ui-login-return")),
  ).toBeNull();
});
