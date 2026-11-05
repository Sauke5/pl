import { expect, test, type Page } from "@playwright/test";

const instanceID = "f2222222-2222-4222-8222-222222222222";
const jobID = "f3333333-3333-4333-8333-333333333333";
const gatewayKey = "AB".repeat(32);

async function fixture(
  page: Page,
  options: {
    managedCredentials?: boolean;
    existingMode?: "local" | "external";
    success?: boolean;
    state?: "disabled" | "unavailable";
    admin?: boolean;
  } = {},
) {
  const writes: Record<string, unknown>[] = [];
  const reads: string[] = [];
  const timestamp = new Date().toISOString();
  const makeInstance = (mode: "local" | "external") => ({
    id: instanceID,
    module_id: "netmap",
    name: "Удалённая сеть",
    mode,
    endpoint: "https://netmap.example.org",
    desired_state: options.state === "disabled" ? "disabled" : "enabled",
    observed_state: options.state || "running",
    last_attempt: timestamp,
    last_success: timestamp,
    last_job_id: jobID,
  });
  let instance = options.existingMode
    ? makeInstance(options.existingMode)
    : undefined;
  const job = {
    id: jobID,
    status: "succeeded",
    parameters: { action: "install" },
    created_at: timestamp,
    finished_at: timestamp,
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    reads.push(path);
    if (request.method() === "POST" && path === "/modules") {
      expect(request.headers()["x-csrf-token"]).toBe("netmap-external-csrf");
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push(body);
      if (!options.success)
        return route.fulfill({
          status: 503,
          json: {
            error: "fixture_stop",
            message: "Проверка запроса завершена",
          },
        });
      instance = makeInstance(body.mode === "local" ? "local" : "external");
      return route.fulfill({ status: 202, json: { instance, job } });
    }
    if (path.startsWith(`/modules/${instanceID}/netmap/`))
      return options.state === "unavailable"
        ? route.fulfill({ status: 503, json: { message: "NetMap недоступен" } })
        : route.fulfill({ json: { items: [] } });
    const responses: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "admin", name: "Admin", admin: options.admin !== false },
        csrf_token: "netmap-external-csrf",
        features: {},
      },
      "/help-state": { disabled: true, seen: [] },
      "/preferences": {
        favorites: [],
        hidden_sections: [],
        section_order: [],
        home_widgets: [],
      },
      "/chart-settings": { revision: 1, charts: [] },
      "/modules": { items: instance ? [instance] : [] },
      "/modules/catalog": {
        local_available: true,
        managed_credentials_available: options.managedCredentials !== false,
        items: [
          {
            id: "netmap",
            name: "NetMap",
            description: "Сеть и история конфигураций",
            modes: ["local", "external"],
          },
        ],
      },
      ["/jobs/" + jobID]: job,
    };
    return route.fulfill({ json: responses[path] ?? [] });
  });
  await page.goto("/#module-catalog");
  return {
    writes,
    reads,
    removeInstance: () => {
      instance = undefined;
    },
  };
}

async function openExternal(page: Page) {
  await page
    .getByRole("button", { name: "Подключить существующий", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Подключить NetMap", exact: true });
}

test("NetMap external submits a private key, clears it and safely reuses an identical retry", async ({
  page,
}) => {
  const { writes } = await fixture(page);
  const dialog = await openExternal(page);
  const endpoint = dialog.getByLabel(/^Адрес NetMap/);
  const key = dialog.getByLabel(/^Ключ подключения NetMap/);
  const submit = dialog.getByRole("button", {
    name: "Подключить",
    exact: true,
  });
  await expect(key).toHaveAttribute("type", "password");
  await expect(key).toHaveAttribute("autocomplete", "off");
  for (const address of [
    "http://netmap.example.org",
    "https://netmap.example.org/netmap/",
  ]) {
    await endpoint.fill(address);
    await key.fill(gatewayKey);
    await submit.click();
    await expect(dialog.getByRole("alert")).toContainText("HTTPS-адрес");
    expect(writes).toHaveLength(0);
  }
  await endpoint.fill("https://netmap.example.org");
  await key.fill("a".repeat(63));
  expect(
    await key.evaluate((input: HTMLInputElement) => input.checkValidity()),
  ).toBe(false);
  await key.fill(gatewayKey);
  await submit.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Проверка запроса завершена",
  );
  await expect(key).toHaveValue("");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    module_id: "netmap",
    mode: "external",
    endpoint: "https://netmap.example.org",
    gateway_key: gatewayKey.toLowerCase(),
  });
  for (const field of ["api_key", "secret_ref", "config"])
    expect(writes[0]).not.toHaveProperty(field);
  await key.fill(gatewayKey);
  await submit.click();
  await expect(key).toHaveValue("");
  await expect(submit).toBeEnabled();
  expect(writes).toHaveLength(2);
  expect(writes[1].idempotency_key).toBe(writes[0].idempotency_key);
  await key.fill("cd".repeat(32));
  await submit.click();
  await expect(key).toHaveValue("");
  await expect(submit).toBeEnabled();
  expect(writes).toHaveLength(3);
  expect(writes[2].idempotency_key).not.toBe(writes[0].idempotency_key);
  const storage = await page.evaluate(() =>
    JSON.stringify([
      Object.entries(localStorage),
      Object.entries(sessionStorage),
    ]),
  );
  expect(storage.toLowerCase()).not.toContain(gatewayKey.toLowerCase());
  await key.fill(gatewayKey);
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  const reopened = await openExternal(page);
  await expect(reopened.getByLabel(/^Ключ подключения NetMap/)).toHaveValue("");
  await reopened.getByRole("button", { name: "Отмена", exact: true }).click();
  await page
    .getByRole("button", { name: "Установить на хост", exact: true })
    .click();
  const local = page.getByRole("dialog", {
    name: "Установить NetMap",
    exact: true,
  });
  await expect(local.getByLabel(/^Ключ подключения NetMap/)).toHaveCount(0);
  await local.getByRole("button", { name: "Установить", exact: true }).click();
  await expect(local.getByRole("alert")).toContainText(
    "Проверка запроса завершена",
  );
  expect(writes).toHaveLength(4);
  expect(writes[3]).toMatchObject({ module_id: "netmap", mode: "local" });
  expect(writes[3]).not.toHaveProperty("gateway_key");
});

test("NetMap external requires credential storage capability", async ({
  page,
}) => {
  await fixture(page, { managedCredentials: false });
  await expect(
    page.getByRole("button", { name: "Подключить существующий", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Установить на хост", exact: true }),
  ).toBeEnabled();
});

test("NetMap local and external share one alias in the add dialog", async ({
  page,
}) => {
  const { writes } = await fixture(page, { existingMode: "local" });
  const dialog = await openExternal(page);
  await expect(dialog).toContainText("доступен один экземпляр приложения");
  await expect(dialog.getByLabel(/^Ключ подключения NetMap/)).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Открыть установленный" }),
  ).toBeVisible();
  expect(writes).toHaveLength(0);
});

test("NetMap external uses PL links and never requests local initial credentials", async ({
  page,
}) => {
  const { reads } = await fixture(page, { success: true });
  const dialog = await openExternal(page);
  await dialog.getByLabel("Название экземпляра").fill("Удалённая сеть");
  await dialog.getByLabel(/^Адрес NetMap/).fill("https://netmap.example.org");
  await dialog.getByLabel(/^Ключ подключения NetMap/).fill(gatewayKey);
  await dialog.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`#modules\\?instance=${instanceID}$`),
  );
  const card = page.locator("#module-" + instanceID);
  await expect(
    card.getByRole("link", { name: "Открыть карту" }),
  ).toHaveAttribute("href", "/netmap/");
  await card.getByRole("button", { name: "Подробнее", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Настроить сети" }),
  ).toHaveAttribute("href", `#modules?instance=${instanceID}&view=netmap`);
  expect(reads.some((path) => path.endsWith("/initial-login"))).toBe(false);
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  const remove = page.getByRole("dialog", {
    name: "Удалить «Удалённая сеть»?",
    exact: true,
  });
  await expect(remove).toContainText("ключ связи");
  await expect(remove).toContainText("все данные сохранятся на своём хосте");
  await expect(remove).not.toContainText(
    "Будут удалены все компоненты сетевого стека",
  );
  await expect(
    remove.getByRole("button", { name: "Удалить подключение", exact: true }),
  ).toBeVisible();
  await remove.getByRole("button", { name: "Отмена", exact: true }).click();
  await page.getByRole("link", { name: "Настроить сети" }).click();
  await expect(
    page.getByRole("heading", { name: "NetMap", exact: true }),
  ).toBeVisible();
  const services = page.getByRole("navigation", { name: "Сервисы NetMap" });
  for (const [name, path] of [
    ["NetBox", "netbox"],
    ["Gitea", "gitea"],
    ["Oxidized", "oxidized"],
  ])
    await expect(
      services.getByRole("link", { name, exact: true }),
    ).toHaveAttribute("href", `/netmap/${path}/`);
  expect(reads.some((path) => path.endsWith("/initial-login"))).toBe(false);
});

for (const [mode, state] of [
  ["local", "disabled"],
  ["external", "unavailable"],
] as const) {
  test(`NetMap sidebar retains ${mode} ${state} settings and disappears after removal`, async ({
    page,
  }) => {
    const { reads, removeInstance } = await fixture(page, {
      existingMode: mode,
      state,
    });
    const navigation = page
      .locator(".sidebar")
      .getByRole("button", { name: "NetMap", exact: true });
    await expect(navigation).toBeVisible();
    // Merely drawing navigation reads PL's saved module list, not the adapter.
    expect(
      reads.some((path) => path.startsWith(`/modules/${instanceID}/netmap/`)),
    ).toBe(false);
    await navigation.click();
    await expect(page).toHaveURL(/#netmap$/);
    await expect(navigation).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("heading", { name: "NetMap", exact: true }),
    ).toBeVisible();
    if (state === "disabled")
      await expect(
        page.getByText("NetMap отключён", { exact: true }),
      ).toBeVisible();
    else
      await expect(page.getByRole("alert").first()).toContainText(
        "NetMap недоступен",
      );
    removeInstance();
    await page.goto("/#modules");
    await page.getByRole("button", { name: "Обновить", exact: true }).click();
    await expect(navigation).toHaveCount(0);
  });
}

test("NetMap settings navigation is administrator-only", async ({ page }) => {
  const { reads } = await fixture(page, {
    existingMode: "external",
    admin: false,
  });
  await page.goto("/#netmap");
  await expect(
    page.getByRole("heading", { name: "Нет доступа", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  expect(
    reads.some((path) => path.startsWith(`/modules/${instanceID}/netmap/`)),
  ).toBe(false);
});
