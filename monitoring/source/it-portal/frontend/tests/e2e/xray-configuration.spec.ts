import { test, expect, type Page } from "@playwright/test";

const id = "22222222-2222-4222-8222-222222222222";
const base = `/modules/${id}/xray/configuration`;
type Draft = {
  revision: number;
  ref: string;
  inbounds: {
    tag: string;
    protocol: string;
    listen: string;
    port: number;
    auth: string;
    username: string;
    password_set?: boolean;
    password?: string;
  }[];
  outbound: {
    mode: string;
    protocol?: string;
    server?: string;
    port?: number;
    link?: string;
  };
  routing: string;
};
async function fixture(
  page: Page,
  options: {
    readonly?: boolean;
    conflict?: boolean;
    reject?: boolean;
    failed?: boolean;
    catalog?: boolean;
    statusOutbound?: Draft["outbound"] | null;
  } = {},
) {
  let draft: Draft = {
    revision: 0,
    ref: "",
    inbounds: [],
    outbound: { mode: "direct" },
    routing: "proxy_all",
  };
  let applied: Draft | null = null;
  let retried = false;
  let installed = !options.catalog;
  let enabled = true;
  const observedAt = new Date().toISOString();
  const writes: { path: string; data: Record<string, unknown> }[] = [];
  const module = () => ({
    id,
    module_id: "xray",
    name: "Lab Xray",
    mode: "local",
    observed_state: enabled ? "running" : "disabled",
    desired_state: enabled ? "enabled" : "disabled",
    revision: 1,
    last_attempt: observedAt,
    last_success: observedAt,
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (
      request.method() !== "GET" &&
      (path.startsWith(base) ||
        path === "/modules" ||
        path === `/modules/${id}/actions`)
    ) {
      expect(request.headers()["x-csrf-token"]).toBe("xray-csrf");
      const data = request.postDataJSON();
      writes.push({ path, data });
      if (path.endsWith("/actions")) {
        if (data.action === "remove") installed = false;
        if (data.action === "disable") enabled = false;
        if (data.action === "enable") enabled = true;
        return route.fulfill({
          status: 202,
          json: {
            instance: module(),
            job: {
              id: "lifecycle-job",
              status: "succeeded",
              parameters: { action: data.action },
            },
          },
        });
      }
      if (path === "/modules") {
        installed = true;
        return route.fulfill({
          status: 202,
          json: {
            instance: module(),
            job: { id: "install-job", status: "succeeded" },
          },
        });
      }
      if (request.method() === "PUT") {
        if (options.conflict)
          return route.fulfill({
            status: 409,
            json: { code: "revision_conflict" },
          });
        if (options.reject)
          return route.fulfill({
            status: 400,
            json: {
              code: "invalid_data",
              message: "Неподдерживаемый параметр подключения",
            },
          });
        const incoming = data.configuration as Draft;
        expect(Object.keys(incoming.outbound).sort()).toEqual(
          incoming.outbound.link ? ["link", "mode"] : ["mode"],
        );
        draft = {
          ...incoming,
          revision: draft.revision + 1,
          ref: "33333333-3333-4333-8333-333333333333",
          inbounds: incoming.inbounds.map(({ password, ...item }) => ({
            ...item,
            password_set: !!password || !!item.password_set,
          })),
          outbound:
            incoming.outbound.mode === "imported"
              ? {
                  mode: "imported",
                  protocol: "vless",
                  server: "relay.example",
                  port: 443,
                }
              : { mode: "direct" },
        };
      } else if (path.endsWith("/validate"))
        return route.fulfill({ json: { valid: true } });
      else if (path.endsWith("/apply") || path.endsWith("/retry")) {
        if (path.endsWith("/retry")) retried = true;
        if (!options.failed || retried) applied = structuredClone(draft);
        return route.fulfill({
          status: 202,
          json: { job: { id: "xray-job", status: "queued" } },
        });
      }
    }
    const responses: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "admin", name: "Admin", admin: true },
        csrf_token: "xray-csrf",
        timezone: "Europe/Moscow",
      },
      "/help-state": { disabled: true, seen: [] },
      "/preferences": {
        favorites: [],
        hidden_sections: [],
        section_order: [],
        home_widgets: [],
      },
      "/chart-settings": { revision: 1, charts: [] },
      "/wayline": { sources: [] },
      "/modules/catalog": {
        local_available: true,
        items: [
          {
            id: "xray",
            name: "Xray",
            description: "SOCKS/HTTP proxy",
            version: "CI-pinned",
            modes: ["local"],
          },
        ],
      },
      "/modules": { items: installed ? [module()] : [] },
      [base]: {
        editable: !options.readonly,
        draft,
        applied,
        last_job_id: "",
        last_error: "",
        rolled_back: false,
      },
      [`/modules/${id}/xray/status`]: {
        state: "running",
        version: "CI-pinned",
        inbounds: applied?.inbounds || [],
        outbound:
          options.statusOutbound === undefined
            ? applied?.outbound || { mode: "direct" }
            : options.statusOutbound,
        routing: applied?.routing || "proxy_all",
        counters: [
          { name: "inbound>>>proxy_1>>>traffic>>>uplink", value: 1024 },
          { name: "outbound>>>proxy>>>traffic>>>uplink", value: 1024 },
          { name: "outbound>>>proxy>>>traffic>>>downlink", value: 2048 },
        ],
      },
      "/jobs/xray-job": {
        id: "xray-job",
        status: options.failed && !retried ? "failed" : "succeeded",
        error: options.failed && !retried ? "Применение не подтверждено" : "",
        finished_at: "2026-10-18T10:00:00Z",
      },
    };
    await route.fulfill({ json: responses[path] ?? [] });
  });
  await page.goto(
    options.catalog ? "/#module-catalog" : `/#modules?instance=${id}&view=xray`,
  );
  return writes;
}
async function addInbound(page: Page, protocol = "socks", index = 1) {
  await page
    .getByRole("button", { name: "Добавить inbound", exact: true })
    .click();
  const section = page.getByRole("region", {
    name: `Inbound ${index}`,
    exact: true,
  });
  await section
    .getByLabel(`Tag inbound ${index}`, { exact: true })
    .fill(`office_${index}`);
  await section
    .getByRole("combobox", { name: new RegExp(`^Протокол inbound ${index}`) })
    .selectOption(protocol);
  return section;
}
async function saveValidateApply(page: Page) {
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(
    page.getByText("Черновик v1 · Без изменений", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Проверить конфигурацию", exact: true })
    .click();
  await expect(
    page.getByText(/Конфигурация прошла xray run -test/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Применить конфигурацию", exact: true })
    .click();
}
for (const scenario of [
  { name: "direct", outbound: { mode: "direct" }, label: "Прямой выход" },
  {
    name: "imported",
    outbound: { mode: "imported", protocol: "vless", server: "relay.example" },
    label: "Через прокси",
  },
  { name: "missing", outbound: null, label: "Выбранный выход" },
  {
    name: "unknown",
    outbound: { mode: "unknown" },
    label: "Выбранный выход",
  },
]) {
  test(`Xray outbound traffic uses actual ${scenario.name} mode instead of draft`, async ({
    page,
  }) => {
    const writes = await fixture(page, { statusOutbound: scenario.outbound });
    const traffic = page
      .locator(".xray-traffic-grid .xray-traffic-table")
      .first();
    const row = traffic.getByRole("row").filter({
      has: page.getByText("proxy", { exact: true }),
    });
    await expect(row).toContainText(scenario.label);
    await expect(row).toContainText("2 048 байт");
    for (const draftMode of ["imported", "direct"]) {
      await page
        .getByRole("combobox", { name: /^Режим outbound/ })
        .selectOption(draftMode);
      await expect(row).toContainText(scenario.label);
    }
    expect(writes).toHaveLength(0);

    await page.route(`**/api/v1/modules/${id}/xray/status`, (route) =>
      route.fulfill({ status: 503, json: { code: "upstream_unavailable" } }),
    );
    await page
      .getByRole("button", { name: "Обновить состояние", exact: true })
      .click();
    await expect(
      page.locator(".xray-status-card").getByRole("alert"),
    ).toBeVisible();
    await expect(page.locator(".xray-traffic-grid")).toHaveCount(0);
  });
}
for (const theme of ["dark", "light"]) {
  test(`Xray saves SOCKS/HTTP, clears credentials and applies frozen plan (${theme})`, async ({
    page,
  }) => {
    const writes = await fixture(page);
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const socks = await addInbound(page);
    await socks
      .getByRole("combobox", { name: /^Авторизация inbound 1/ })
      .selectOption("password");
    await socks.getByLabel("Логин inbound 1", { exact: true }).fill("office");
    await socks
      .getByLabel("Пароль inbound 1", { exact: true })
      .fill("fixture-inbound-password");
    await addInbound(page, "http", 2);
    await page
      .getByRole("combobox", { name: /^Режим outbound/ })
      .selectOption("imported");
    const link = page.getByLabel("Ссылка подключения outbound", {
      exact: true,
    });
    await link.fill(
      "vless://fixture-user@relay.example:443?security=tls&type=tcp#lab",
    );
    await saveValidateApply(page);
    await expect(
      page.getByText("Применена версия 1", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Пароль inbound 1", { exact: true }),
    ).toHaveValue("");
    await expect(link).toHaveValue("");
    await expect(page.locator("body")).not.toContainText(
      "fixture-inbound-password",
    );
    const save = writes.find((write) => write.path === base)!;
    expect(save.data.configuration).toMatchObject({
      inbounds: [
        {
          protocol: "socks",
          auth: "password",
          password: "fixture-inbound-password",
        },
        { protocol: "http" },
      ],
      outbound: { mode: "imported", link: expect.stringContaining("vless://") },
    });
    expect(
      writes.find((write) => write.path.endsWith("/validate"))?.data,
    ).toEqual({ configuration_ref: "33333333-3333-4333-8333-333333333333" });
    expect(writes.find((write) => write.path.endsWith("/apply"))?.data).toEqual(
      { revision: 1, idempotency_key: expect.any(String) },
    );
  });
}
test("Xray accepts unauthenticated LAN and rejects duplicate bind", async ({
  page,
}) => {
  const writes = await fixture(page);
  const inbound = await addInbound(page);
  await inbound
    .getByLabel("IPv4 inbound 1", { exact: true })
    .fill("10.73.10.25");
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(
    page.getByText("Черновик v1 · Без изменений", { exact: true }),
  ).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].data.configuration).toMatchObject({
    inbounds: [{ listen: "10.73.10.25", auth: "none", username: "" }],
  });
  await inbound.getByLabel("IPv4 inbound 1", { exact: true }).fill("127.0.0.1");
  const second = await addInbound(page, "http", 2);
  await second.getByLabel("Порт inbound 2", { exact: true }).fill("1080");
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Адрес и порт inbound уже заняты",
  );
  expect(writes).toHaveLength(1);
});
test("Xray disabling authentication clears hidden credentials", async ({
  page,
}) => {
  const writes = await fixture(page);
  const inbound = await addInbound(page);
  const auth = inbound.getByRole("combobox", {
    name: /^Авторизация inbound 1/,
  });
  await auth.selectOption("password");
  await inbound
    .getByLabel("Логин inbound 1", { exact: true })
    .fill("fixture-user");
  await inbound
    .getByLabel("Пароль inbound 1", { exact: true })
    .fill("fixture-password");
  await auth.selectOption("none");
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(
    page.getByText("Черновик v1 · Без изменений", { exact: true }),
  ).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].data.configuration).toMatchObject({
    inbounds: [{ auth: "none", username: "" }],
  });
  expect(JSON.stringify(writes)).not.toContain("fixture-password");
  expect(JSON.stringify(writes)).not.toContain("fixture-user");
});
test("Xray revision conflict preserves edits and blocks apply", async ({
  page,
}) => {
  await fixture(page, { conflict: true });
  await addInbound(page);
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("другим администратором");
  await expect(page.getByLabel("Tag inbound 1", { exact: true })).toHaveValue(
    "office_1",
  );
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeDisabled();
});
test("Xray server import rejection does not enable validation or apply", async ({
  page,
}) => {
  await fixture(page, { reject: true });
  await addInbound(page);
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Неподдерживаемый параметр",
  );
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeDisabled();
});
test("Xray read-only configuration cannot mutate", async ({ page }) => {
  const writes = await fixture(page, { readonly: true });
  await expect(
    page.getByText("Настройки доступны только для чтения."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Добавить inbound", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Сохранить черновик", exact: true }),
  ).toBeDisabled();
  expect(writes).toHaveLength(0);
});
test("Xray retries the same failed persistent job", async ({ page }) => {
  const writes = await fixture(page, { failed: true });
  await addInbound(page);
  await saveValidateApply(page);
  await page
    .getByRole("button", { name: "Повторить то же задание", exact: true })
    .click();
  await expect(
    page.getByText("Применена версия 1", { exact: true }),
  ).toBeVisible();
  expect(writes.find((write) => write.path.endsWith("/retry"))?.data).toEqual({
    job_id: "xray-job",
  });
  expect(writes.filter((write) => write.path.endsWith("/apply"))).toHaveLength(
    1,
  );
});
test("Xray installs from backend catalogue and opens its configuration", async ({
  page,
}) => {
  const writes = await fixture(page, { catalog: true });
  await page
    .getByRole("button", { name: "Установить на хост", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Установить", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Управлять прокси", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Конфигурация Xray", exact: true }),
  ).toBeVisible();
  expect(writes.find((write) => write.path === "/modules")?.data).toMatchObject(
    { module_id: "xray", mode: "local" },
  );
});

test("Xray disable, enable and named removal use existing lifecycle", async ({
  page,
}) => {
  const writes = await fixture(page);
  await page.goto("/#modules");
  const card = page.locator(`#module-${id}`);
  const menu = card.getByRole("button", {
    name: "Действия: Lab Xray",
    exact: true,
  });
  await menu.click();
  await card.getByRole("menuitem", { name: "Отключить", exact: true }).click();
  await expect(card.locator(".module-card-state")).toContainText("Отключён");
  await menu.click();
  await card.getByRole("menuitem", { name: "Включить", exact: true }).click();
  await expect(card.locator(".module-card-state")).toContainText("Работает");
  await menu.click();
  await card.getByRole("menuitem", { name: "Удалить", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Удалить полностью", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByLabel("Введите название: Lab Xray", { exact: true })
    .fill("Lab Xray");
  await dialog
    .getByRole("button", { name: "Удалить полностью", exact: true })
    .click();
  await expect(card).toHaveCount(0);
  expect(
    writes
      .filter((write) => write.path.endsWith("/actions"))
      .map((write) => write.data.action),
  ).toEqual(["disable", "enable", "remove"]);
  expect(
    writes.find((write) => write.data.action === "remove")?.data.confirm_name,
  ).toBe("Lab Xray");
});

test("Xray rejects invalid and reserved tags before PUT, accepts dotted tag", async ({
  page,
}) => {
  const writes = await fixture(page);
  const inbound = await addInbound(page);
  const tag = inbound.getByLabel("Tag inbound 1", { exact: true });
  const save = page.getByRole("button", {
    name: "Сохранить черновик",
    exact: true,
  });
  for (const value of [
    "1office",
    "_office",
    ".office",
    "api",
    "proxy",
    "direct",
    "block",
  ]) {
    await tag.fill(value);
    await save.click();
    await expect(page.getByRole("alert")).toContainText(
      "Tag должен начинаться",
    );
    expect(writes).toHaveLength(0);
    await page
      .getByRole("button", { name: "Закрыть уведомление", exact: true })
      .click();
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  await tag.fill("office.socks-1_main");
  await save.click();
  await expect(
    page.getByText("Черновик v1 · Без изменений", { exact: true }),
  ).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].path).toBe(base);
  expect(writes[0].data.configuration).toMatchObject({
    inbounds: [{ tag: "office.socks-1_main" }],
  });
});

test("Xray validation announces one global result without an inline duplicate", async ({
  page,
}) => {
  const writes = await fixture(page);
  await addInbound(page);
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  const viewport = page.getByRole("region", {
    name: "Уведомления о действиях",
    exact: true,
  });
  const savedToast = viewport.locator(".action-notification").filter({
    hasText: "Черновик сохранён. Ссылка и пароли больше не отображаются.",
  });
  await expect(savedToast).toBeVisible();
  await savedToast
    .getByRole("button", { name: "Закрыть уведомление", exact: true })
    .click();
  await expect(viewport.getByRole("status")).toHaveCount(0);

  await page
    .getByRole("button", { name: "Проверить конфигурацию", exact: true })
    .click();
  const result = /Конфигурация прошла xray run -test/;
  await expect(viewport.getByRole("status")).toHaveCount(1);
  await expect(viewport.getByRole("status")).toContainText(result);
  await expect(page.getByText(result)).toHaveCount(1);
  await expect(
    page.locator(".notice.compact").filter({ hasText: result }),
  ).toHaveCount(0);
  expect(
    writes.filter((write) => write.path.endsWith("/validate")),
  ).toHaveLength(1);
});

test("Xray repeats the same manual validation error after its toast is closed", async ({
  page,
}) => {
  const writes = await fixture(page);
  const inbound = await addInbound(page);
  const tag = inbound.getByLabel("Tag inbound 1", { exact: true });
  await tag.fill("api");
  const save = page.getByRole("button", {
    name: "Сохранить черновик",
    exact: true,
  });
  const viewport = page.getByRole("region", {
    name: "Уведомления о действиях",
    exact: true,
  });
  const result = /Tag должен начинаться/;
  await save.click();
  await expect(viewport.getByRole("alert")).toHaveCount(1);
  await expect(viewport.getByRole("alert")).toContainText(result);
  await viewport
    .locator(".action-notification-error")
    .getByRole("button", { name: "Закрыть уведомление", exact: true })
    .click();
  await expect(viewport.getByRole("alert")).toHaveCount(0);

  // Do not edit or clear the field: save batches clearing and the next Error.
  await expect(tag).toHaveValue("api");
  await save.click();
  await expect(viewport.getByRole("alert")).toHaveCount(1);
  await expect(viewport.getByRole("alert")).toContainText(result);
  await expect(tag).toHaveValue("api");
  await expect(
    page.locator(".notice.compact").filter({ hasText: result }),
  ).toHaveCount(0);
  expect(writes).toHaveLength(0);
});
