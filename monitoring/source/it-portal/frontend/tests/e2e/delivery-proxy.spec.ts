import { expect, test, type Page } from "@playwright/test";
import type { DeliveryProxyStatus } from "../../src/DeliveryProxySettings";
import { settingsWorkspaceFixture } from "../fixtures/settingsWorkspace";

async function fixture(page: Page, failTest = false) {
  await settingsWorkspaceFixture(page);
  let status: DeliveryProxyStatus = {
    core_api: 1,
    revision: 0,
    configuration: { mode: "direct" },
    custom_ca: false,
    xray_inbounds: [
      {
        instance_id: "97a58150-bc1c-4ee9-8586-53574c96a42b",
        inbound_tag: "pl-downloads",
        protocol: "socks5",
        listen: "127.0.0.1",
        port: 1080,
        auth: "password",
        ready: true,
      },
    ],
  };
  const writes: { method: string; path: string; body: Record<string, any> }[] =
    [];
  await page.route("**/api/v1/delivery/proxy**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (request.method() === "GET") return route.fulfill({ json: status });
    expect(request.headers()["x-csrf-token"]).toBe("settings-test");
    const body = request.postDataJSON();
    writes.push({ method: request.method(), path, body });
    if (path.endsWith("/test"))
      return route.fulfill({
        json: {
          ok: !failTest,
          checked_at: "2026-11-05T08:00:00Z",
          mode: body.configuration.mode,
          latest_version: failTest ? "" : "0.4.0",
          ...(failTest
            ? {
                error_code: "delivery_proxy_unavailable",
                error: "Не удалось подключиться к прокси.",
              }
            : {}),
        },
      });
    const configuration = body.configuration;
    status = {
      ...status,
      revision: status.revision + 1,
      configuration: {
        mode: configuration.mode,
        ...(configuration.mode === "external"
          ? {
              external: {
                protocol: configuration.external.protocol,
                host: configuration.external.host,
                port: configuration.external.port,
                auth: configuration.external.auth,
                username: configuration.external.username,
                password_configured: configuration.external.auth === "password",
              },
            }
          : {}),
        ...(configuration.mode === "xray" ? { xray: configuration.xray } : {}),
      },
    };
    return route.fulfill({ json: status });
  });
  return { writes, status: () => status };
}

test("proxy check keeps the draft private and saved credentials stay bound to their endpoint", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/#settings?section=delivery");
  await page
    .getByRole("combobox", { name: "Способ подключения", exact: true })
    .selectOption("external");
  await page.getByLabel(/^Адрес прокси/).fill("proxy.example.test");
  await page
    .getByRole("combobox", { name: "Авторизация прокси", exact: true })
    .selectOption("password");
  await page
    .getByLabel("Пользователь прокси", { exact: true })
    .fill("pl-reader");
  await page.getByLabel(/^Пароль прокси/).fill("fixture-proxy-password");
  await page
    .getByRole("button", { name: "Проверить доступ к GitHub", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Подписанный каталог PL доступен",
  );
  expect(state.status().configuration.mode).toBe("direct");
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toEqual({
    method: "POST",
    path: "/delivery/proxy/test",
    body: {
      revision: 0,
      configuration: {
        mode: "external",
        external: {
          protocol: "http",
          host: "proxy.example.test",
          port: 3128,
          auth: "password",
          username: "pl-reader",
          password_action: "set",
          password: "fixture-proxy-password",
        },
      },
    },
  });
  await page
    .getByRole("navigation", { name: "Разделы настроек" })
    .getByRole("button", { name: "Обзор", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Есть несохранённые изменения" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Остаться", exact: true }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Параметры загрузок сохранены",
  );
  expect(state.writes[1].body.operation_id).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByLabel(/^Пароль прокси/)).toHaveValue("");
  await page.reload();
  await expect(page.getByLabel(/^Адрес прокси/)).toHaveValue(
    "proxy.example.test",
  );
  await expect(page.getByLabel(/^Пароль прокси/)).toHaveValue("");
  await page
    .getByRole("button", { name: "Проверить доступ к GitHub", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Подписанный каталог PL доступен",
  );
  expect(state.writes[2].body.configuration.external).toMatchObject({
    password_action: "keep",
  });
  expect(state.writes[2].body.configuration.external).not.toHaveProperty(
    "password",
  );
  await page.getByLabel(/^Адрес прокси/).fill("other-proxy.example.test");
  await expect(page.getByText(/Подписанный каталог PL доступен/)).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "Проверить доступ к GitHub", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Для этого прокси укажите имя пользователя и пароль",
  );
  expect(state.writes).toHaveLength(3);
  await page.getByLabel(/^Пароль прокси/).fill("replacement-fixture-password");
  await page
    .getByRole("button", { name: "Проверить доступ к GitHub", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Подписанный каталог PL доступен",
  );
  expect(state.writes[3].body.configuration.external).toMatchObject({
    host: "other-proxy.example.test",
    password_action: "set",
    password: "replacement-fixture-password",
  });
});

test("managed Xray selection sends only its identity and direct mode clears the route", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/#settings?section=delivery");
  await page
    .getByRole("combobox", { name: "Способ подключения", exact: true })
    .selectOption("xray");
  await page
    .getByRole("button", { name: "Проверить доступ к GitHub", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Выберите доступный вход установленного Xray",
  );
  expect(state.writes).toHaveLength(0);
  await page
    .getByRole("combobox", { name: "Вход Xray", exact: true })
    .selectOption(
      JSON.stringify(["97a58150-bc1c-4ee9-8586-53574c96a42b", "pl-downloads"]),
    );
  await page
    .getByRole("button", { name: "Проверить доступ к GitHub", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Подписанный каталог PL доступен",
  );
  expect(state.writes[0].body.configuration).toEqual({
    mode: "xray",
    xray: {
      instance_id: "97a58150-bc1c-4ee9-8586-53574c96a42b",
      inbound_tag: "pl-downloads",
    },
  });
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Параметры загрузок сохранены",
  );
  await page
    .getByRole("combobox", { name: "Способ подключения", exact: true })
    .selectOption("direct");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Параметры загрузок сохранены",
  );
  expect(state.writes[2].body.configuration).toEqual({ mode: "direct" });
});

test("unavailable proxy reports its failed check while preserving the entered settings", async ({
  page,
}) => {
  const state = await fixture(page, true);
  await page.goto("/#settings?section=delivery");
  await page
    .getByRole("combobox", { name: "Способ подключения", exact: true })
    .selectOption("external");
  await page.getByLabel(/^Протокол прокси/).selectOption("socks5");
  await page.getByLabel(/^Адрес прокси/).fill("127.0.0.1");
  await page.getByLabel("Порт прокси", { exact: true }).fill("1080");
  await page
    .getByRole("button", { name: "Проверить доступ к GitHub", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Не удалось подключиться к прокси",
  );
  await expect(page.getByLabel(/^Адрес прокси/)).toHaveValue("127.0.0.1");
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].body.configuration.external).toEqual({
    protocol: "socks5",
    host: "127.0.0.1",
    port: 1080,
    auth: "none",
    username: "",
    password_action: "clear",
  });
  expect(state.status().configuration.mode).toBe("direct");
});
