import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

type HelpState = { disabled: boolean; seen: string[] };
async function signIn(page: Page) {
  const session = await (await page.request.get("/api/v1/session")).json();
  expect(session.demo).toBe(true);
  await expect(
    await page.request.post("/auth/demo", { data: { role: "admin" } }),
  ).toBeOK();
}
async function patch(page: Page, data: unknown) {
  const session = await (await page.request.get("/api/v1/session")).json();
  return page.request.patch("/api/v1/help-state", {
    data,
    headers: { "X-CSRF-Token": session.csrf_token },
  });
}
async function freshHelp(page: Page, failFirstSave = false) {
  const state: HelpState = { disabled: false, seen: [] };
  let fail = failFirstSave;
  await page.route("**/api/v1/help-state", async (route) => {
    if (route.request().method() === "PATCH") {
      if (fail) {
        fail = false;
        return route.fulfill({
          status: 503,
          json: { message: "Временная недоступность" },
        });
      }
      const update = route.request().postDataJSON();
      if (update.topic && !state.seen.includes(update.topic))
        state.seen.push(update.topic);
      if (typeof update.disabled === "boolean")
        state.disabled = update.disabled;
    }
    return route.fulfill({ json: state });
  });
  return state;
}
const coach = (page: Page) => page.locator(".help-coach");

test("real help state persists opt-out and manual replay, independently of personal favorites", async ({
  page,
}) => {
  await signIn(page);
  const preferences = await (
    await page.request.get("/api/v1/preferences")
  ).json();
  await expect(await patch(page, { disabled: true })).toBeOK();
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Моё рабочее пространство",
      exact: true,
    }),
  ).toBeVisible();
  await expect(coach(page)).toHaveCount(0);
  await page
    .getByRole("button", { name: "Показать подсказки", exact: true })
    .click();
  await expect(coach(page)).toBeVisible();
  await expect(
    coach(page).getByLabel("Больше не показывать подсказки"),
  ).toBeChecked();
  await coach(page)
    .getByRole("button", { name: "Понятно", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/v1/help-state")).json()).seen,
    )
    .toContain("home");
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Моё рабочее пространство",
      exact: true,
    }),
  ).toBeVisible();
  await expect(coach(page)).toHaveCount(0);
  expect(
    (await (await page.request.get("/api/v1/help-state")).json()).disabled,
  ).toBe(true);
  expect(await (await page.request.get("/api/v1/preferences")).json()).toEqual(
    preferences,
  );
});

test("first-open help, nested Escape, focus return, unchanged form and replay", async ({
  page,
}) => {
  await signIn(page);
  const state = await freshHelp(page);
  await page.goto("/");
  await expect(coach(page)).toHaveAttribute("data-help-topic", "home");
  await expect(
    coach(page).getByRole("button", { name: "Понятно", exact: true }),
  ).toBeFocused();
  for (let n = 0; n < 5; n++) {
    await page.keyboard.press("Tab");
    expect(
      await coach(page).evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
  }
  await coach(page)
    .getByRole("button", { name: "Понятно", exact: true })
    .click();
  await expect.poll(() => state.seen).toContain("home");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Каталог", exact: true })
    .click();
  await expect(coach(page)).toHaveAttribute("data-help-topic", "catalog");
  await expect(coach(page)).toContainText("В меню ⋯ справа");
  await page.keyboard.press("Escape");
  await expect(coach(page)).toHaveCount(0);
  await page
    .getByRole("button", { name: "Добавить ресурс", exact: true })
    .first()
    .click();
  await expect(coach(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(coach(page)).toHaveCount(0);
  const form = page.getByRole("dialog");
  await expect(form).toBeVisible();
  await form.getByLabel(/^Название/).fill("Черновик остаётся на месте");
  const replay = form.getByRole("button", {
    name: "Показать подсказки",
    exact: true,
  });
  await replay.click();
  await expect(coach(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(replay).toBeFocused();
  await expect(form.getByLabel(/^Название/)).toHaveValue(
    "Черновик остаётся на месте",
  );
  await replay.click();
  await coach(page).getByLabel("Больше не показывать подсказки").check();
  await coach(page)
    .getByRole("button", { name: "Понятно", exact: true })
    .click();
  await expect.poll(() => state.disabled).toBe(true);
  await page.keyboard.press("Escape");
  await page.locator(".workspace-problem-trigger button").first().click();
  await expect(
    page.getByRole("dialog", { name: "Текущие неисправности", exact: true }),
  ).toBeVisible();
  await expect(coach(page)).toHaveCount(0);
  await page
    .getByRole("button", { name: "Показать подсказки", exact: true })
    .click();
  await expect(coach(page)).toHaveAttribute("data-help-topic", "problems");
  await coach(page).getByLabel("Больше не показывать подсказки").uncheck();
  await coach(page)
    .getByRole("button", { name: "Понятно", exact: true })
    .click();
  await expect.poll(() => state.disabled).toBe(false);
});

test("failed preference save is visible, retryable and does not trap the user", async ({
  page,
}) => {
  await signIn(page);
  const state = await freshHelp(page, true);
  await page.goto("/");
  await expect(coach(page)).toBeVisible();
  await coach(page).getByLabel("Больше не показывать подсказки").check();
  await page.keyboard.press("Escape");
  await expect(coach(page)).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText(
    "Не удалось сохранить настройку подсказок",
  );
  await page
    .getByRole("status")
    .getByRole("button", { name: "Повторить", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveCount(0);
  expect(state.disabled).toBe(true);
  expect(state.seen).toContain("home");
});

test("help remains readable on narrow screens with reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page);
  await freshHelp(page);
  await page.goto("/");
  await expect(coach(page)).toBeVisible();
  const bounds = await coach(page).boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(845);
  await expect(
    coach(page).getByRole("button", { name: "Понятно", exact: true }),
  ).toBeInViewport();
  mkdirSync("../output/playwright", { recursive: true });
  await page.screenshot({ path: "../output/playwright/help-mobile-390.png" });
});
