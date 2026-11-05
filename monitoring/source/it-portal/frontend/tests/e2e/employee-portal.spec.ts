import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const published = [
  {
    id: "wiki",
    name: "База знаний",
    description: "Корпоративная документация в Wiki.",
    category: "Знания и файлы",
    icon: "book",
    url: "https://wiki.example.test/",
    status: "unknown",
  },
  {
    id: "vega",
    name: "1Ф · Vega",
    description: "Корпоративное приложение 1Ф.",
    category: "Рабочие системы",
    icon: "app",
    url: "https://vega.example.test/",
    status: "unknown",
  },
  {
    id: "files",
    name: "Файловый аудитор",
    description: "Аудит документов на HOT и ARCH.",
    category: "Знания и файлы",
    icon: "folder",
    url: "/audit/",
    status: "unknown",
  },
  {
    id: "help",
    name: "Техническая поддержка",
    description: "Сервис поддержки PL · 1С:ITILIUM.",
    category: "Помощь",
    icon: "support",
    url: "https://support.example.test/",
    status: "unknown",
    support: true,
  },
];
async function fixture(
  page: Page,
  state: {
    id: string;
    items: typeof published;
    authenticated?: boolean;
    error?: boolean;
    delay?: boolean;
  },
) {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/session"))
      return route.fulfill({
        json: {
          authenticated: state.authenticated !== false,
          user:
            state.authenticated === false
              ? undefined
              : { id: state.id, name: "Проверенный сотрудник", admin: false },
          csrf_token: "fixture-csrf",
          ad_login_enabled: true,
          timezone: "Europe/Moscow",
        },
      });
    if (path.endsWith("/board")) {
      if (state.delay) await new Promise((resolve) => setTimeout(resolve, 800));
      return state.error
        ? route.fulfill({
            status: 503,
            json: { message: "Тестовая недоступность" },
          })
        : route.fulfill({ json: { title: "Сервисы PL", items: state.items } });
    }
    if (path === "/api/v1/dashboard-layout") {
      expect(route.request().method()).toBe("GET");
      expect(new URL(route.request().url()).searchParams.get("view")).toBe(
        "employee",
      );
      return route.fulfill({ json: { revision: 0, tiles: [], hidden: [] } });
    }
    if (path.endsWith("/help-state"))
      return route.fulfill({ json: { disabled: true, seen: [] } });
    throw new Error(`Unexpected employee request: ${path}`);
  });
}
for (const [width, height] of [[1920, 1080]])
  for (const theme of ["dark", "light"]) {
    test(`employee composition ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(
        (theme) => localStorage.setItem("pl-ui-theme", theme),
        theme,
      );
      await fixture(page, { id: "employee", items: published });
      await page.goto("/");
      await expect(
        page.getByRole("heading", { name: "Куда перейдём?" }),
      ).toBeVisible();
      await expect(page.getByText("Проверенный сотрудник")).toBeVisible();
      await expect(page.locator(".employee-card")).toHaveCount(4);
      await expect(page.locator(".sidebar")).toHaveCount(0);
      await expect(page.locator(".employee-support a")).toHaveAttribute(
        "href",
        "https://support.example.test/",
      );
      if (theme === "light")
        expect(
          await page
            .locator(".employee-support a")
            .evaluate((el) => getComputedStyle(el).color),
        ).toBe("rgb(255, 255, 255)");
      const geometry = await page.evaluate(() => ({
        w: innerWidth,
        scroll: document.documentElement.scrollWidth,
        hero: document.querySelector(".employee-hero")!.getBoundingClientRect()
          .width,
        cards: [...document.querySelectorAll(".employee-card")].map(
          (e) => e.getBoundingClientRect().width,
        ),
      }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.w);
      expect(geometry.cards[0]).toBeGreaterThan(600);
      if (process.env.EMPLOYEE_SCREENSHOT_DIR) {
        mkdirSync(process.env.EMPLOYEE_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: join(
            process.env.EMPLOYEE_SCREENSHOT_DIR,
            `employee-${theme}-${width}.png`,
          ),
          fullPage: true,
        });
      }
      await page.keyboard.press("Control+k");
      await expect(
        page.getByRole("searchbox", { name: "Найти сервис" }),
      ).toBeFocused();
      await page.getByRole("searchbox").fill("Vega");
      await expect(page.locator(".employee-card")).toHaveCount(1);
      await page.getByRole("searchbox").fill("несуществующий");
      await expect(page.getByText("Ничего не найдено")).toBeVisible();
      await page.getByRole("button", { name: "Сбросить поиск" }).click();
      await page
        .getByRole("button", { name: "Знания и файлы", exact: true })
        .click();
      await expect(page.locator(".employee-card")).toHaveCount(2);
      await page.getByRole("button", { name: "Все", exact: true }).click();
      await expect(page.locator(".employee-card")).toHaveCount(4);
      const toggle = page.getByRole("button", {
        name: "Добавить в избранное: База знаний",
      });
      await toggle.click();
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Убрать из избранного: База знаний" }),
      ).toHaveAttribute("aria-pressed", "true");
    });
  }
test("favorites are per user and removed publications are pruned", async ({
  page,
}) => {
  const state = { id: "first", items: published };
  await fixture(page, state);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Добавить в избранное: База знаний" })
    .click();
  state.id = "second";
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Добавить в избранное: База знаний" }),
  ).toHaveAttribute("aria-pressed", "false");
  state.id = "first";
  state.items = published.slice(1);
  await page.reload();
  await expect(page.locator(".employee-card")).toHaveCount(3);
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("pl-ui-employee-favorites:first")),
    )
    .toBe("[]");
});
test("unsafe links disabled, support fallback, logout keeps CSRF", async ({
  page,
}) => {
  const state = {
    id: "first",
    items: [
      { ...published[0], url: "javascript:alert(1)" },
      { ...published[1], url: "//evil.test/" },
      { ...published[2], url: "/auth/logout" },
    ],
  };
  await fixture(page, state);
  await page.goto("/");
  await expect(page.locator(".employee-card a")).toHaveCount(0);
  await expect(
    page.getByText("Сервис поддержки пока не опубликован.", { exact: false }),
  ).toBeVisible();
  await page.route("**/auth/logout", (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe("fixture-csrf");
    return route.fulfill({
      status: 503,
      json: { message: "Выход временно недоступен" },
    });
  });
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(page.getByText("Выход временно недоступен")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Выйти", exact: true }),
  ).toBeEnabled();
});
test("loading, empty, error recovery and missing route", async ({ page }) => {
  const state = {
    id: "first",
    items: [] as typeof published,
    delay: true,
    error: false,
  };
  await fixture(page, state);
  await page.goto("/");
  await expect(page.locator('.employee-grid[aria-busy="true"]')).toBeVisible();
  await expect(page.getByText("Сервисы пока не опубликованы")).toBeVisible();
  state.delay = false;
  state.error = true;
  await page.reload();
  await expect(page.getByText("Тестовая недоступность")).toBeVisible();
  state.error = false;
  state.items = published;
  await page.getByRole("button", { name: "Повторить" }).click();
  await expect(page.locator(".employee-card")).toHaveCount(4);
  await page.goto("/missing");
  await expect(
    page.getByRole("heading", { name: "Страница не найдена" }),
  ).toBeVisible();
});

test("admin saves employee metadata without changing publication", async ({
  page,
}) => {
  let saved: Record<string, unknown> | undefined;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/resources" && route.request().method() === "POST") {
      saved = route.request().postDataJSON();
      return route.fulfill({
        status: 201,
        json: { ...saved, id: "created", revision: 1 },
      });
    }
    if (path === "/settings" && route.request().method() !== "GET")
      throw new Error("resource metadata changed publication");
    const data: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "admin", name: "Admin", admin: true },
        csrf_token: "test",
        timezone: "Europe/Moscow",
      },
      "/preferences": { favorites: [], hidden_sections: [], section_order: [] },
      "/dashboard-layout": { revision: 0, tiles: [], hidden: [] },
      "/workspace-preferences": { revision: 0, system_ids: [], groups: [] },
      "/help-state": { disabled: true, seen: [] },
      "/chart-settings": { revision: 1, charts: [] },
      "/wayline": { sources: [] },
      "/dictionaries": {
        types: [],
        sites: [],
        environments: [],
        directions: [],
      },
    };
    return route.fulfill({ json: data[path] ?? [] });
  });
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Каталог", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Добавить ресурс", exact: true })
    .first()
    .click();
  await page.getByLabel("Название *", { exact: true }).fill("Support service");
  await page
    .getByLabel("Основной адрес *", { exact: true })
    .fill("https://support.example.test/");
  await page.getByText("Подписи для сотрудника", { exact: true }).click();
  await page
    .getByLabel("Понятное название", { exact: true })
    .fill("Техническая поддержка");
  await page
    .getByLabel("Описание для сотрудника", { exact: true })
    .fill("Помощь сотрудникам");
  await page.getByLabel("Категория сервиса", { exact: true }).fill("Помощь");
  await page.getByLabel("Использовать как сервис поддержки").check();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => saved).toBeDefined();
  expect(saved?.employee).toEqual({
    display_name: "Техническая поддержка",
    description: "Помощь сотрудникам",
    category: "Помощь",
    icon: "app",
    support: true,
  });
});
