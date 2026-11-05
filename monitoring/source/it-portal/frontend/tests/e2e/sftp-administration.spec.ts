import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

test.use({ reducedMotion: "reduce" });
const nativeUsername = "pl-ui-" + "a".repeat(64);

type Options = {
  authenticated?: boolean;
  admin?: boolean;
  canAdmin?: boolean;
  files?: boolean;
  configured?: boolean;
  failed?: boolean;
};

async function setup(page: Page, options: Options = {}) {
  let capabilities = 0;
  let logout = 0;
  const {
    authenticated = true,
    admin = true,
    canAdmin = admin,
    files = true,
    configured = true,
    failed = false,
  } = options;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/session") {
      return route.fulfill({
        json: {
          authenticated,
          features: { sftp: true },
          user: authenticated
            ? { id: "fixture-user", name: "Тестовый пользователь", admin }
            : undefined,
          csrf_token: "fixture-csrf",
          ad_login_enabled: true,
          oidc_login_enabled: true,
          board_anonymous_enabled: false,
        },
      });
    }
    if (path === "/api/v1/sftp-adm") {
      capabilities++;
      return route.fulfill({
        status: failed ? 503 : 200,
        json: failed
          ? { error: "unavailable", message: "Сервис временно недоступен" }
          : {
              configured,
              can_admin: canAdmin,
              can_access_files: files,
              native_username: nativeUsername,
            },
      });
    }
    if (path === "/api/v1/sftp-server") {
      return route.fulfill({
        json: {
          can_manage: admin,
          collections: [],
          versions: [],
          accounts: [],
          audit: [],
        },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.route("**/auth/logout", async (route) => {
    logout++;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe("fixture-csrf");
    return route.fulfill({
      status: 503,
      json: { message: "Выход не выполнен" },
    });
  });
  for (const [path, title] of [
    ["/sftp-adm/open/files", "Файлы SFTPGo"],
    ["/sftp-adm/open/admin", "Управление SFTPGo"],
  ]) {
    await page.route(`**${path}`, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<h1>${title}</h1>`,
      }),
    );
  }
  return { capabilities: () => capabilities, logout: () => logout };
}

for (const [width, height] of [[1920, 1080]]) {
  for (const theme of ["dark", "light"]) {
    test(`SFTP administration ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(
        (value) => localStorage.setItem("pl-ui-theme", value),
        theme,
      );
      await setup(page);
      await page.goto("/sftp-adm");
      await expect(
        page.getByRole("heading", { name: "Файловый сервер" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Открыть файлы" }),
      ).toHaveAttribute("href", "/sftp-adm/open/files");
      await expect(
        page.getByRole("link", { name: "Открыть управление" }),
      ).toHaveAttribute("href", "/sftp-adm/open/admin");
      await expect(page.locator(".user-info")).toContainText(
        "Тестовый пользователь",
      );
      await expect(page.locator(".breadcrumb a")).toHaveText("Платформа");
      const geometry = await page.evaluate(() => {
        const sidebar = document
          .querySelector(".sidebar")!
          .getBoundingClientRect();
        const header = document
          .querySelector(".topbar")!
          .getBoundingClientRect();
        const title = getComputedStyle(document.querySelector("h1")!);
        return {
          sidebarWidth: sidebar.width,
          headerHeight: header.height,
          titleSize: title.fontSize,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      expect(geometry).toEqual({
        sidebarWidth: width === 1920 ? 226 : 240,
        headerHeight: 79,
        titleSize: "30px",
        overflow: false,
      });
      const dir = process.env.SFTP_ADM_SCREENSHOT_DIR;
      if (dir) {
        mkdirSync(dir, { recursive: true });
        await page.screenshot({
          path: join(dir, `sftp-adm-${width}-${theme}.png`),
          animations: "disabled",
        });
      }
      await page.getByRole("link", { name: "Открыть файлы" }).click();
      await expect(
        page.getByRole("heading", { name: "Файлы SFTPGo" }),
      ).toBeVisible();
    });
  }
}

test("SFTP employee access is separate from administration", async ({
  page,
}) => {
  await setup(page, { admin: false, canAdmin: true });
  await page.goto("/sftp-adm/");
  await expect(page.getByRole("link", { name: "Открыть файлы" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Открыть управление" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Обмен базами" })).toHaveCount(
    0,
  );
});

test("SFTP files deny by default without hiding administrative access", async ({
  page,
}) => {
  await setup(page, { files: false });
  await page.goto("/sftp-adm");
  await expect(page.getByText("Доступ к файлам не выдан.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Открыть файлы" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("link", { name: "Открыть управление" }),
  ).toBeVisible();
});

test("SFTP capability failure never exposes launch links", async ({ page }) => {
  await setup(page, { failed: true });
  await page.goto("/sftp-adm");
  await expect(page.getByRole("alert")).toContainText(
    "Сервис временно недоступен",
  );
  await expect(page.locator('a[href^="/sftp-adm/open/"]')).toHaveCount(0);
});

test("SFTP unconfigured service has no active links", async ({ page }) => {
  await setup(page, { configured: false });
  await page.goto("/sftp-adm");
  await expect(
    page.getByText("Веб-интерфейс SFTPGo не подключён."),
  ).toBeVisible();
  await expect(page.locator('a[href^="/sftp-adm/open/"]')).toHaveCount(0);
});

test("SFTP anonymous request shows shared login without mounting service", async ({
  page,
}) => {
  const state = await setup(page, { authenticated: false });
  await page.goto("/sftp-adm");
  await expect(
    page.getByRole("heading", { name: "Вход в Платформу" }),
  ).toBeVisible();
  expect(state.capabilities()).toBe(0);
  await expect(page.locator(".sftp-adm-shell")).toHaveCount(0);
});

test("SFTP shared logout retains page and error when server rejects it", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/sftp-adm");
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Выход не выполнен");
  expect(state.logout()).toBe(1);
  await expect(page).toHaveURL(/\/sftp-adm$/);
});

test("SFTP native identity can be copied for access assignment", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (value: string) => {
          (window as unknown as Record<string, string>).copiedLogin = value;
        },
      },
    });
  });
  await setup(page);
  await page.goto("/sftp-adm");
  await expect(page.locator(".sftp-adm-identity code")).toHaveText(
    nativeUsername,
  );
  await page.getByRole("button", { name: "Скопировать логин" }).click();
  await expect(
    page.getByRole("button", { name: "Логин скопирован" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as Record<string, string>).copiedLogin,
    ),
  ).toBe(nativeUsername);
});

test("SFTP missing clipboard reports a copy error without a false success", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: undefined });
  });
  await setup(page);
  await page.goto("/sftp-adm");
  await page.getByRole("button", { name: "Скопировать логин" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Не удалось скопировать логин.",
  );
  await expect(
    page.getByRole("button", { name: "Логин скопирован" }),
  ).toHaveCount(0);
});

test("SFTP navigation remains accessible when the shared sidebar is collapsed", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/sftp-adm");
  await page.getByRole("button", { name: "Свернуть меню" }).click();
  await expect(page.locator(".sftp-adm-shell")).toHaveClass(
    /sidebar-collapsed/,
  );
  await page.getByRole("button", { name: "Обмен базами" }).click();
  await expect(page).toHaveURL(/\/sftp-server$/);
  await expect(page.locator(".sftp-shell")).toHaveClass(/sidebar-collapsed/);
  await page.getByRole("button", { name: "Журнал действий" }).click();
  await expect(
    page.getByRole("heading", { name: "Журнал действий" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Файловый сервер", exact: true })
    .click();
  await expect(page).toHaveURL(/\/sftp-adm$/);
  await page.getByRole("button", { name: "Развернуть меню" }).click();
  await expect(page.getByRole("link", { name: "Открыть файлы" })).toBeVisible();
});

test("SFTP exchange remains separate with administrator navigation", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/sftp-server");
  await expect(
    page.getByRole("heading", { name: "Выгрузки баз" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Файловый сервер", exact: true })
    .click();
  await expect(page).toHaveURL(/\/sftp-adm$/);
  await expect(
    page.getByRole("link", { name: "Открыть управление" }),
  ).toBeVisible();
});

for (const [target, heading] of [
  ["/sftp-adm", "Файловый сервер"],
  ["/sftp-adm/", "Файловый сервер"],
  ["/sftp-adm/open/admin", "Управление SFTPGo"],
  ["/sftp-adm/open/files", "Файлы SFTPGo"],
]) {
  test(`SFTP shared login returns to ${target}`, async ({ page }) => {
    await setup(page);
    await page.goto("/?return_to=" + encodeURIComponent(target));
    await expect.poll(() => new URL(page.url()).pathname).toBe(target);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    expect(
      await page.evaluate(() => sessionStorage.getItem("pl-ui-login-return")),
    ).toBeNull();
  });
}
