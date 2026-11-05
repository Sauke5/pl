import { expect, test, type Page } from "@playwright/test";
import type { Delivery } from "../../src/UpdateSettings";
import type {
  PublicUpgradeStatus,
  UpgradeOperation,
} from "../../src/UpgradeExperience";

const operation: UpgradeOperation = {
  operation_id: "9c3bbf23-0328-4c71-94c9-01c7a4f03dc0",
  kind: "upgrade",
  version: "0.4.5",
  phase: "snapshot",
};
async function fixture(page: Page, admin = true) {
  let delivery: Delivery = {
    current_version: "0.4.4",
    latest_version: "0.4.5",
    update_available: true,
    core_api: 1,
    modules: [],
    release_notes: {
      version: "0.4.5",
      title: "Обновления под контролем",
      summary:
        "Новая версия заметна сразу. Во время установки видно, что происходит.",
      sections: [
        {
          kind: "new",
          items: [
            { title: "Заметное уведомление", description: "" },
            { title: "Понятный экран ожидания", description: "" },
            { title: "Возвращение после проверки", description: "" },
          ],
        },
      ],
    },
  };
  let status: PublicUpgradeStatus = {
    active: false,
    ready: false,
    current_version: "0.4.4",
  };
  let unavailable = false,
    sessionUnavailable = false;
  let sessionAuthenticated = true;
  let sessionAdmin = admin;
  let sessionCSRF = "delivery-csrf";
  let recoverNetworkError = false;
  let deliveryReads = 0,
    sessionReads = 0;
  let loseAcceptance = false;
  let deliveryUnavailable = false;
  const writes: string[] = [];
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/upgrade-status")
      return unavailable
        ? route.abort("connectionreset")
        : route.fulfill({ json: status });
    if (path === "/delivery") {
      deliveryReads++;
      if (deliveryUnavailable) return route.abort("connectionreset");
      return route.fulfill({ json: delivery });
    }
    if (path === "/delivery/recover") {
      const body = route.request().postDataJSON();
      writes.push(path);
      requests.push({ path, body });
      expect(route.request().headers()["x-csrf-token"]).toBe(sessionCSRF);
      if (recoverNetworkError) return route.abort("connectionreset");
      status = {
        ...status,
        active: true,
        operation: {
          ...status.operation!,
          phase: "queued_recovery",
          error: undefined,
        },
      };
      return route.fulfill({ json: {} });
    }
    if (path === "/delivery/module-upgrade") {
      expect(route.request().headers()["x-csrf-token"]).toBe("delivery-csrf");
      const body = route.request().postDataJSON();
      writes.push(path);
      requests.push({ path, body });
      delivery = {
        ...delivery,
        operation: {
          ...operation,
          operation_id: body.operation_id,
          kind: "module_upgrade",
          module_id: body.module_id,
          version: delivery.current_version,
        },
      };
      status = { ...status, active: true, operation: delivery.operation };
      if (loseAcceptance) {
        deliveryUnavailable = true;
        return route.abort("connectionreset");
      }
      return route.fulfill({ json: delivery });
    }
    if (path === "/delivery/upgrade") {
      writes.push(path);
      delivery = {
        ...delivery,
        operation: {
          ...operation,
          operation_id: route.request().postDataJSON().operation_id,
        },
      };
      status = { ...status, active: true, operation: delivery.operation };
      if (loseAcceptance) {
        deliveryUnavailable = true;
        return route.abort("connectionreset");
      }
      return route.fulfill({ json: delivery });
    }
    if (path === "/session") {
      sessionReads++;
      if (sessionUnavailable) return route.abort("connectionreset");
      return route.fulfill({
        json: {
          authenticated: sessionAuthenticated,
          user: { id: "local-admin", name: "Admin", admin: sessionAdmin },
          csrf_token: sessionCSRF,
        },
      });
    }
    const data: Record<string, unknown> = {
      "/settings": {
        revision: 1,
        timezone: "UTC",
        stale_after_seconds: 180,
        session_lifetime_minutes: 480,
        local_password_min_length: 12,
      },
      "/runtime": {},
      "/modules": { items: [] },
      "/workspace-preferences": { revision: 1, system_ids: [], groups: [] },
      "/preferences": {
        favorites: [],
        hidden_sections: [],
        section_order: [],
        home_widgets: [],
        system_ids: [],
      },
      "/help-state": { disabled: true, seen: [] },
      "/chart-settings": { revision: 1, charts: [] },
      "/wayline": { sources: [] },
    };
    return route.fulfill({ json: data[path] ?? [] });
  });
  return {
    writes,
    requests,
    setAuth: (
      authenticated: boolean,
      admin: boolean,
      csrf = "fresh-recovery-csrf",
    ) => {
      sessionAuthenticated = authenticated;
      sessionAdmin = admin;
      sessionCSRF = csrf;
    },
    failRecovery: () => {
      recoverNetworkError = true;
    },
    setModules: (modules: Delivery["modules"]) => {
      delivery = { ...delivery, modules };
    },
    loseAcceptanceAndDelivery: () => {
      loseAcceptance = true;
    },
    get deliveryReads() {
      return deliveryReads;
    },
    get sessionReads() {
      return sessionReads;
    },
    setStatus: (v: PublicUpgradeStatus) => {
      status = v;
    },
    setUnavailable: (v: boolean) => {
      unavailable = v;
    },
    setSessionUnavailable: (v: boolean) => {
      sessionUnavailable = v;
    },
    newRelease: () => {
      delivery = {
        ...delivery,
        latest_version: "0.4.6",
        release_notes: undefined,
      };
    },
  };
}
async function evidence(page: Page, name: string) {
  if (process.env.PL_UI_EVIDENCE_DIR)
    await page.screenshot({
      path: process.env.PL_UI_EVIDENCE_DIR + "/" + name + ".png",
    });
}

test("admin sees release highlights, can dismiss only that release, and installation remains manual", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/#catalog");
  const banner = page.getByRole("region", { name: "Доступна PL 0.4.5" });
  await expect(banner).toBeVisible();
  await expect(
    banner.getByText("Обновления под контролем", { exact: true }),
  ).toBeVisible();
  await expect(banner.getByRole("listitem")).toHaveCount(3);
  await evidence(page, "release-banner-1920");
  await banner.getByRole("button", { name: "Посмотреть обновление" }).click();
  await expect(
    page.getByRole("heading", { name: "Версия и обновления PL" }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await banner
    .getByRole("button", { name: "Скрыть уведомление о PL 0.4.5" })
    .click();
  await page.reload();
  await expect(banner).toHaveCount(0);
  state.newRelease();
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Доступна PL 0.4.6" }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(0);
});
test("release banner and delivery reads are absent for an employee", async ({
  page,
}) => {
  const state = await fixture(page, false);
  await page.goto("/#catalog");
  await expect(
    page.getByRole("heading", { name: "Куда перейдём?", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".release-banner")).toHaveCount(0);
  expect(state.deliveryReads).toBe(0);
});
test("confirmed upgrade survives reload and API restart, waits for readiness and session resync", async ({
  page,
}) => {
  const state = await fixture(page);
  state.setStatus({
    active: true,
    ready: false,
    current_version: "0.4.4",
    operation,
  });
  await page.goto("/#catalog");
  await expect(
    page.getByRole("heading", { name: "Платформа обновляется" }),
  ).toBeVisible();
  await expect(
    page.getByText("Создаём резервную копию", { exact: true }),
  ).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".upgrade-symbol > svg")).toHaveCSS(
    "animation-name",
    "none",
  );
  await evidence(page, "upgrade-snapshot-1920");
  state.setSessionUnavailable(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Платформа обновляется" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Вход в Платформу" }),
  ).toHaveCount(0);
  state.setStatus({
    active: false,
    ready: false,
    current_version: "0.4.5",
    operation: { ...operation, phase: "complete" },
  });
  await expect(
    page.getByText("Обновление установлено", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".upgrade-scene")).toBeVisible();
  state.setStatus({
    active: false,
    ready: true,
    current_version: "0.4.5",
    operation: { ...operation, phase: "complete" },
  });
  await expect(
    page.getByRole("heading", { name: "Ожидаем подключения к PL" }),
  ).toBeVisible();
  state.setSessionUnavailable(false);
  await expect(page.locator(".upgrade-scene")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Каталог ресурсов", exact: true }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(0);
  expect(state.sessionReads).toBeGreaterThan(1);
});
test("ordinary outage does not impersonate an upgrade", async ({ page }) => {
  const state = await fixture(page);
  state.setUnavailable(true);
  state.setSessionUnavailable(true);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Повторить" })).toBeVisible();
  await expect(page.locator(".upgrade-scene")).toHaveCount(0);
});
test("confirmed failure is honest and never automatically retries installation", async ({
  page,
}) => {
  const state = await fixture(page);
  state.setStatus({
    active: true,
    ready: false,
    current_version: "0.4.4",
    operation,
  });
  await page.goto("/");
  await expect(page.locator(".upgrade-scene")).toBeVisible();
  state.setStatus({
    active: false,
    ready: true,
    current_version: "0.4.4",
    operation: {
      ...operation,
      phase: "rolled_back",
      error: "Проверка новой версии не пройдена",
    },
  });
  await expect(
    page.getByRole("heading", { name: "Предыдущая версия восстановлена" }),
  ).toBeVisible();
  await expect(
    page.getByText("Проверка новой версии не пройдена", { exact: true }),
  ).toBeVisible();
  await evidence(page, "upgrade-rolled-back-1920");
  expect(state.writes).toHaveLength(0);
  await page.getByRole("button", { name: "Вернуться в Платформу" }).click();
  await expect(page.locator(".upgrade-scene")).toHaveCount(0);
});

test("lost public connection keeps confirmed context but stops claiming live progress", async ({
  page,
}) => {
  await page.clock.install();
  const state = await fixture(page);
  state.setStatus({
    active: true,
    ready: false,
    current_version: "0.4.4",
    operation,
  });
  await page.goto("/#catalog");
  await expect(
    page.getByRole("heading", { name: "Платформа обновляется" }),
  ).toBeVisible();
  state.setUnavailable(true);
  await page.clock.fastForward(20_000);
  await expect(
    page.getByRole("heading", { name: "Ожидаем подключения к PL" }),
  ).toBeVisible();
  await expect(
    page.getByText("Последний подтверждённый этап", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Проверить связь" }),
  ).toBeVisible();
  await evidence(page, "upgrade-disconnected-1920");
  state.setUnavailable(false);
  await page.getByRole("button", { name: "Проверить связь" }).click();
  await expect(
    page.getByRole("heading", { name: "Платформа обновляется" }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(0);
});
for (const theme of ["dark", "light", "night"])
  test(`release and maintenance keep ${theme} theme at desktop sizes`, async ({
    page,
  }) => {
    await page.addInitScript(
      (theme) => localStorage.setItem("pl-ui-theme", theme),
      theme,
    );
    const state = await fixture(page);
    await page.goto("/#catalog");
    await expect(
      page.getByRole("region", { name: "Доступна PL 0.4.5" }),
    ).toBeVisible();
    await evidence(page, `release-banner-${theme}-1920`);
    await page.setViewportSize({ width: 3440, height: 1440 });
    await evidence(page, `release-banner-${theme}-3440`);
    state.setStatus({
      active: true,
      ready: false,
      current_version: "0.4.4",
      operation,
    });
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Платформа обновляется" }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const colors = await page.locator(".upgrade-scene").evaluate((el) => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--pl-ui-bg)";
      document.body.append(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { actual: getComputedStyle(el).backgroundColor, expected };
    });
    expect(colors.actual).toBe(colors.expected);
    await evidence(page, `upgrade-${theme}-3440`);
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect(
      page.getByRole("heading", { name: "Платформа обновляется" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator(".upgrade-scene")).toHaveCount(1);
    await expect(page.locator(".upgrade-scene-header")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Выбрать тему", exact: true }),
    ).toHaveCount(1);
    await evidence(page, `upgrade-${theme}-1000`);
  });

test("release CTA preserves the settings leave guard and the current draft", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/#settings?section=general");
  await page
    .getByRole("navigation", { name: "Разделы настроек" })
    .getByRole("button", { name: "Общие параметры", exact: true })
    .click();
  await page.getByLabel(/Порог устаревания/).fill("240");
  await page
    .getByRole("region", { name: "Доступна PL 0.4.5" })
    .getByRole("button", { name: "Посмотреть обновление" })
    .click();
  const prompt = page.getByRole("dialog");
  await expect(prompt).toContainText(/несохранён|Несохранён/);
  await prompt.getByRole("button", { name: /Остаться/ }).click();
  await expect(page.getByLabel(/Порог устаревания/)).toHaveValue("240");
  expect(state.writes).toHaveLength(0);
});
test("configuration operations and invalid public error payload never replace the app", async ({
  page,
}) => {
  const state = await fixture(page);
  state.setStatus({
    active: true,
    ready: false,
    current_version: "0.4.4",
    operation: { ...operation, kind: "configuration" },
  });
  await page.goto("/#catalog");
  await expect(
    page.getByRole("heading", { name: "Каталог ресурсов", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".upgrade-scene")).toHaveCount(0);
  state.setStatus({
    active: true,
    ready: false,
    current_version: "0.4.4",
    operation: { ...operation, error: { invalid: true } as unknown as string },
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Каталог ресурсов", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".upgrade-scene")).toHaveCount(0);
});

test("public active orphan recovery is visible without any local receipt and survives reload", async ({
  page,
}) => {
  const state = await fixture(page);
  state.setSessionUnavailable(true);
  state.setStatus({
    active: true,
    ready: false,
    current_version: "0.4.4",
    operation: {
      ...operation,
      phase: "recovery_required",
      error: "Операция остановлена. Требуется восстановление установки.",
    },
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Обновление не завершено", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Операция остановлена. Требуется восстановление установки.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Вход в Платформу" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Вернуться в Платформу" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Обновление не завершено", exact: true }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await evidence(page, "upgrade-orphan-recovery-1920");
});
test("queued recovery is an actual restoration stage instead of unavailable status", async ({
  page,
}) => {
  const state = await fixture(page);
  state.setStatus({
    active: true,
    ready: false,
    current_version: "0.4.4",
    operation: { ...operation, phase: "queued_recovery" },
  });
  await page.goto("/");
  await expect(
    page.getByText("Восстанавливаем предыдущую версию", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Платформа обновляется" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Ожидаем подключения к PL" }),
  ).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
test("lost acceptance and failed API reconciliation immediately consult public status without a second write", async ({
  page,
}) => {
  const state = await fixture(page);
  state.loseAcceptanceAndDelivery();
  await page.goto("/#settings?section=operations");
  await page
    .getByRole("navigation", { name: "Разделы настроек" })
    .getByRole("button", { name: "Эксплуатация", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Обновить до 0.4.5", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Обновление PL до 0.4.5" });
  await dialog
    .getByRole("button", { name: "Установить обновление", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Платформа обновляется" }),
  ).toBeVisible({ timeout: 5000 });
  expect(state.writes).toEqual(["/delivery/upgrade"]);
  await expect(
    page.getByText("Создаём резервную копию", { exact: true }),
  ).toBeVisible();
});

const moduleSHA = "d3".repeat(32);
const doskaUpdate = {
  module_id: "doska",
  version: "2.46.2",
  installed: true,
  installed_version: "2.46.2",
  update_available: true,
  upgrade_supported: true,
  artifact_sha256: moduleSHA,
};
async function moduleSettings(page: Page) {
  await page.goto("/#settings?section=operations");
  await page
    .getByRole("navigation", { name: "Разделы настроек" })
    .getByRole("button", { name: "Эксплуатация", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Обновления модулей", exact: true }),
  ).toBeVisible();
}
test("same-version module rebuild requires manual confirmation and sends its exact artifact SHA", async ({
  page,
}) => {
  const state = await fixture(page);
  state.setModules([
    doskaUpdate,
    {
      module_id: "wayline",
      version: "0.1.0",
      installed: true,
      installed_version: "0.1.0",
      update_available: true,
      upgrade_supported: false,
      blocked_reason: "Поставка не поддерживает обновление",
    },
  ]);
  await moduleSettings(page);
  const section = page.getByRole("region", { name: "Обновления модулей" });
  await expect(
    section.getByText("Установлено: 2.46.2 · Новая сборка: 2.46.2", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    section.getByText("Поставка не поддерживает обновление", { exact: true }),
  ).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  await evidence(page, "module-updates-1920");
  await section
    .getByRole("button", { name: "Обновить Doska", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Обновление Doska",
    exact: true,
  });
  await expect(dialog).toContainText("все локальные экземпляры Doska");
  await expect(dialog).toContainText("полную резервную копию");
  await expect(dialog).toContainText("PL и локальные модули будут недоступны");
  await expect(dialog).toContainText("Версия PL 0.4.4 останется прежней");
  expect(state.writes).toHaveLength(0);
  await dialog.getByText("Идентификатор поставки", { exact: true }).click();
  await expect(
    dialog.getByText("SHA-256 " + moduleSHA, { exact: true }),
  ).toBeVisible();
  await evidence(page, "module-upgrade-confirm-1920");
  await dialog
    .getByRole("button", { name: "Обновить модуль", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Обновляем Doska", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Обновление модуля · PL 0.4.4", { exact: true }),
  ).toBeVisible();
  expect(state.requests).toEqual([
    {
      path: "/delivery/module-upgrade",
      body: {
        operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        module_id: "doska",
        artifact_sha256: moduleSHA,
      },
    },
  ]);
  expect(state.writes).toEqual(["/delivery/module-upgrade"]);
  await evidence(page, "module-upgrade-screen-1920");
  const receipt = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("pl.confirmed-upgrade")!),
  );
  expect(receipt.operation).toMatchObject({
    kind: "module_upgrade",
    module_id: "doska",
    version: "0.4.4",
  });
  state.setUnavailable(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Обновляем Doska", exact: true }),
  ).toBeVisible();
  state.setUnavailable(false);
  state.setStatus({
    active: false,
    ready: true,
    current_version: "0.4.4",
    operation: { ...receipt.operation, phase: "complete" },
  });
  await expect(page.locator(".upgrade-scene")).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});
test("legacy, uninstalled, current, unsupported, blocked and unsigned module rows cannot offer an update", async ({
  page,
}) => {
  const state = await fixture(page);
  state.setModules([
    { module_id: "forms", version: "0.1.0" },
    { ...doskaUpdate, installed: false },
    { ...doskaUpdate, module_id: "grafana", update_available: false },
    { ...doskaUpdate, module_id: "wayline", upgrade_supported: false },
    {
      ...doskaUpdate,
      module_id: "netmap",
      blocked_reason: "Требуется ручная проверка",
    },
    { ...doskaUpdate, module_id: "bookstack", artifact_sha256: undefined },
  ]);
  await moduleSettings(page);
  const section = page.getByRole("region", { name: "Обновления модулей" });
  await expect(section.getByRole("button", { name: /^Обновить / })).toHaveCount(
    0,
  );
  await expect(
    section.getByText("Требуется ручная проверка", { exact: true }),
  ).toBeVisible();
  await expect(
    section.getByText(
      "Не удалось подтвердить новую поставку. Проверьте обновления ещё раз.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(state.writes).toHaveLength(0);
});
test("viewer never receives a module upgrade control or delivery query", async ({
  page,
}) => {
  const state = await fixture(page, false);
  state.setModules([doskaUpdate]);
  await page.goto("/#settings?section=operations");
  await expect(
    page.getByRole("heading", { name: "Куда перейдём?", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Обновить/ })).toHaveCount(0);
  expect(state.deliveryReads).toBe(0);
  expect(state.writes).toHaveLength(0);
});
test("module failure is identified separately and never resends a module upgrade", async ({
  page,
}) => {
  const state = await fixture(page);
  const op = {
    ...operation,
    kind: "module_upgrade",
    module_id: "doska",
    version: "0.4.4",
    phase: "recovery_required",
    error: "Проверка поставки модуля не пройдена",
  };
  state.setStatus({
    active: true,
    ready: false,
    current_version: "0.4.4",
    operation: op,
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Обновление Doska не завершено",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(op.error, { exact: true })).toBeVisible();
  await expect(
    page.getByText("Обновление до PL 0.4.4", { exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Обновление Doska не завершено",
      exact: true,
    }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(0);
});
test("lost module acceptance reconciles its module intent without a second POST", async ({
  page,
}) => {
  const state = await fixture(page);
  state.setModules([doskaUpdate]);
  state.loseAcceptanceAndDelivery();
  await moduleSettings(page);
  await page
    .getByRole("button", { name: "Обновить Doska", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Обновление Doska", exact: true })
    .getByRole("button", { name: "Обновить модуль", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Обновляем Doska", exact: true }),
  ).toBeVisible({ timeout: 5000 });
  expect(state.writes).toEqual(["/delivery/module-upgrade"]);
  expect(state.requests[0].body.artifact_sha256).toBe(moduleSHA);
});

for (const theme of ["light", "night"])
  test(`module update confirmation preserves ${theme} theme and desktop layout`, async ({
    page,
  }) => {
    await page.addInitScript(
      (theme) => localStorage.setItem("pl-ui-theme", theme),
      theme,
    );
    const state = await fixture(page);
    state.setModules([doskaUpdate]);
    await moduleSettings(page);
    const section = page.getByRole("region", { name: "Обновления модулей" });
    await section.scrollIntoViewIfNeeded();
    await evidence(page, `module-updates-${theme}-1920`);
    await section
      .getByRole("button", { name: "Обновить Doska", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Обновление Doska", exact: true }),
    ).toBeVisible();
    await evidence(page, `module-confirm-${theme}-1920`);
    await page.setViewportSize({ width: 3440, height: 1440 });
    await expect(
      page.getByRole("dialog", { name: "Обновление Doska", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await evidence(page, `module-confirm-${theme}-3440`);
    expect(state.writes).toHaveLength(0);
  });

const resumeOperation: UpgradeOperation = {
  ...operation,
  phase: "recovery_required",
  recovery_mode: "resume",
  error: "Не удалось запустить все модули",
};
test("committed version offers manual resume only after a live admin session and fresh CSRF", async ({
  page,
}) => {
  const state = await fixture(page);
  state.setAuth(true, true, "fresh-recovery-csrf");
  state.setStatus({
    active: true,
    ready: false,
    current_version: "0.4.5",
    operation: resumeOperation,
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Версия установлена", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Нужно завершить запуск модулей", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Завершить запуск модулей", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/PL вернулась к сохранённой версии/)).toHaveCount(
    0,
  );
  expect(state.writes).toHaveLength(0);
  await evidence(page, "upgrade-committed-resume-admin-1920");
  await page
    .getByRole("button", { name: "Завершить запуск модулей", exact: true })
    .click();
  await expect(
    page.getByText("Готовим запуск модулей", { exact: true }),
  ).toBeVisible();
  expect(state.requests).toEqual([
    {
      path: "/delivery/recover",
      body: { operation_id: resumeOperation.operation_id },
    },
  ]);
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("pl.confirmed-upgrade")!).operation
            .phase,
      ),
    )
    .toBe("queued_recovery");
  expect(state.writes).toEqual(["/delivery/recover"]);
});
for (const [label, authenticated, admin] of [
  ["anonymous", false, false],
  ["viewer", true, false],
] as const)
  test(`${label} cannot recover even when local receipt claims admin access`, async ({
    page,
  }) => {
    await page.addInitScript(
      (op) =>
        localStorage.setItem(
          "pl.confirmed-upgrade",
          JSON.stringify({
            operation: op,
            confirmedAt: Date.now(),
            admin: true,
            csrf_token: "forged",
          }),
        ),
      resumeOperation,
    );
    const state = await fixture(page);
    state.setAuth(authenticated, admin);
    state.setStatus({
      active: true,
      ready: false,
      current_version: "0.4.5",
      operation: resumeOperation,
    });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Версия установлена", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Продолжить восстановление может администратор PL.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Завершить запуск модулей",
        exact: true,
      }),
    ).toHaveCount(0);
    expect(state.writes).toHaveLength(0);
  });
test("recovery action revalidates current role before POST and rejects a changed viewer session", async ({
  page,
}) => {
  const state = await fixture(page);
  state.setStatus({
    active: true,
    ready: false,
    current_version: "0.4.5",
    operation: resumeOperation,
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Завершить запуск модулей", exact: true }),
  ).toBeVisible();
  state.setAuth(true, false);
  await page
    .getByRole("button", { name: "Завершить запуск модулей", exact: true })
    .click();
  await expect(
    page.getByText("Продолжить восстановление может администратор PL.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(0);
});
test("manual recovery network error stays honest and never repeats its POST", async ({
  page,
}) => {
  const state = await fixture(page);
  state.failRecovery();
  state.setStatus({
    active: true,
    ready: false,
    current_version: "0.4.5",
    operation: resumeOperation,
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Завершить запуск модулей", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Не удалось подтвердить запуск восстановления",
  );
  await expect(
    page.getByRole("heading", { name: "Версия установлена", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Завершить запуск модулей", exact: true }),
  ).toBeEnabled();
  expect(state.writes).toEqual(["/delivery/recover"]);
  await page
    .getByRole("button", { name: "Проверить связь", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Проверить связь", exact: true }),
  ).toBeEnabled();
  expect(state.writes).toEqual(["/delivery/recover"]);
});
test("rollback recovery differs from committed resume and module intent survives accepted recovery", async ({
  page,
}) => {
  const state = await fixture(page);
  const op = {
    ...resumeOperation,
    kind: "module_upgrade",
    module_id: "doska",
    version: "0.4.4",
    recovery_mode: "rollback" as const,
  };
  state.setStatus({
    active: true,
    ready: false,
    current_version: "0.4.4",
    operation: op,
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Обновление Doska не завершено",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Восстановить установку", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Завершить запуск модулей", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Восстановить установку", exact: true })
    .click();
  await expect(
    page.getByText("Восстанавливаем предыдущую версию", { exact: true }),
  ).toBeVisible();
  const receipt = await page.evaluate(
    () => JSON.parse(localStorage.getItem("pl.confirmed-upgrade")!).operation,
  );
  expect(receipt).toMatchObject({
    operation_id: op.operation_id,
    kind: "module_upgrade",
    module_id: "doska",
    phase: "queued_recovery",
    recovery_mode: "rollback",
  });
  expect(state.requests).toEqual([
    { path: "/delivery/recover", body: { operation_id: op.operation_id } },
  ]);
  state.setStatus({
    active: true,
    ready: false,
    current_version: "0.4.4",
    operation: { ...op, phase: "resuming" },
  });
  await expect(
    page.getByText("Запускаем модули", { exact: true }),
  ).toBeVisible();
  state.setStatus({
    active: true,
    ready: false,
    current_version: "0.4.4",
    operation: { ...op, phase: "reconciling" },
  });
  await expect(
    page.getByText("Обновляем состояние модулей", { exact: true }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(1);
});

test("restored snapshot resume identifies the previous version and only manually continues module startup", async ({
  page,
}) => {
  const state = await fixture(page);
  const op = { ...resumeOperation, restored_snapshot: true };
  state.setStatus({
    active: true,
    ready: false,
    current_version: "0.4.4",
    operation: { ...op, restored_snapshot: "true" as unknown as boolean },
  });
  await page.goto("/#catalog");
  await expect(
    page.getByRole("heading", { name: "Каталог ресурсов", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".upgrade-scene")).toHaveCount(0);
  state.setStatus({
    active: true,
    ready: false,
    current_version: "0.4.4",
    operation: op,
  });
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Предыдущая версия восстановлена",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Данные восстановлены. Нужно завершить запуск модулей.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Версия установлена", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Обновление до PL 0.4.5", { exact: true }),
  ).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
  await evidence(page, "upgrade-restored-snapshot-resume-1920");
  await page
    .getByRole("button", { name: "Завершить запуск модулей", exact: true })
    .click();
  await expect(
    page.getByText("Готовим запуск модулей", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Обновление до PL 0.4.5", { exact: true }),
  ).toHaveCount(0);
  expect(state.requests).toEqual([
    { path: "/delivery/recover", body: { operation_id: op.operation_id } },
  ]);
  const receipt = await page.evaluate(
    () => JSON.parse(localStorage.getItem("pl.confirmed-upgrade")!).operation,
  );
  expect(receipt).toMatchObject({
    operation_id: op.operation_id,
    recovery_mode: "resume",
    restored_snapshot: true,
    phase: "queued_recovery",
  });
  expect(state.writes).toEqual(["/delivery/recover"]);
});
