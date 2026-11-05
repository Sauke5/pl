import { test, expect, type Page } from "@playwright/test";

const id = "66666666-6666-4666-8666-666666666666";
const base = `/modules/${id}/alertmanager/configuration`;
type Receiver = {
  name: string;
  kind: string;
  endpoint?: string;
  token?: string;
  endpoint_set?: boolean;
  token_set?: boolean;
  chat_id?: number;
  smtp?: {
    smarthost: string;
    from: string;
    to: string[];
    tls_mode: string;
    username: string;
    password?: string;
    password_set?: boolean;
  };
  proxy: {
    mode: string;
    url: string;
    username: string;
    no_proxy: string[];
    password?: string;
    ca_pem?: string;
    clear_ca?: boolean;
    password_set?: boolean;
    ca_set?: boolean;
  };
};
type Configuration = {
  revision: number;
  ref: string;
  route: {
    receiver: string;
    group_wait: string;
    group_interval: string;
    repeat_interval: string;
  };
  receivers: Receiver[];
};
async function fixture(
  page: Page,
  options: { forbidden?: boolean; conflict?: boolean; failed?: boolean } = {},
) {
  let draft: Configuration = {
    revision: 0,
    ref: "",
    route: {
      receiver: "",
      group_wait: "30s",
      group_interval: "5m",
      repeat_interval: "4h",
    },
    receivers: [],
  };
  let applied: Configuration | null = null;
  let retried = false;
  const writes: { path: string; data: Record<string, unknown> }[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (path.startsWith(base) && options.forbidden)
      return route.fulfill({ status: 403, json: { code: "forbidden" } });
    if (path.startsWith(base) && request.method() !== "GET") {
      expect(request.headers()["x-csrf-token"]).toBe("am-fixture-csrf");
      const data = request.postDataJSON();
      writes.push({ path, data });
      if (request.method() === "PUT") {
        if (options.conflict)
          return route.fulfill({ status: 409, json: { code: "conflict" } });
        const value = data.configuration as Configuration;
        const receivers = value.receivers.map((item) => {
          const previous = draft.receivers.find(
            (old) => old.name === item.name && old.kind === item.kind,
          );
          const settings = item.proxy;
          const proxy =
            settings.mode === "direct"
              ? {
                  mode: "direct",
                  url: "",
                  username: "",
                  no_proxy: [],
                  password_set: false,
                  ca_set: settings.clear_ca
                    ? false
                    : !!settings.ca_pem || !!previous?.proxy.ca_set,
                }
              : {
                  mode: "http",
                  url: settings.url,
                  username: settings.username,
                  no_proxy: settings.no_proxy,
                  password_set:
                    !!settings.password || !!previous?.proxy.password_set,
                  ca_set: settings.clear_ca
                    ? false
                    : !!settings.ca_pem || !!previous?.proxy.ca_set,
                };
          return {
            name: item.name,
            kind: item.kind,
            endpoint_set:
              !!item.endpoint ||
              !!previous?.endpoint_set ||
              item.kind === "telegram" ||
              item.kind === "pagerduty",
            token_set: !!item.token || !!previous?.token_set,
            ...(item.chat_id === undefined ? {} : { chat_id: item.chat_id }),
            proxy,
            ...(item.smtp
              ? {
                  smtp: {
                    smarthost: item.smtp.smarthost,
                    from: item.smtp.from,
                    to: item.smtp.to,
                    tls_mode: item.smtp.tls_mode,
                    username: item.smtp.username,
                    password_set:
                      !!item.smtp.password ||
                      (!!previous?.smtp?.password_set &&
                        previous.smtp.smarthost === item.smtp.smarthost &&
                        previous.smtp.username === item.smtp.username &&
                        previous.smtp.tls_mode === item.smtp.tls_mode),
                  },
                }
              : {}),
          };
        });
        draft = {
          ...value,
          revision: draft.revision + 1,
          ref: `77777777-7777-4777-8777-${String(draft.revision + 1).padStart(12, "0")}`,
          receivers,
        };
      } else if (path.endsWith("/validate"))
        return route.fulfill({ json: { valid: true } });
      else if (path.endsWith("/apply") || path.endsWith("/retry")) {
        if (path.endsWith("/retry")) retried = true;
        if (!options.failed || retried) applied = structuredClone(draft);
        return route.fulfill({
          status: 202,
          json: { job: { id: "am-job", status: "queued" } },
        });
      }
    }
    const responses: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "admin", name: "Admin", admin: true },
        csrf_token: "am-fixture-csrf",
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
      "/modules/catalog": { local_available: true, items: [] },
      "/modules": {
        items: [
          {
            id,
            module_id: "alertmanager",
            name: "Lab notifications",
            mode: "local",
            desired_state: "enabled",
            observed_state: "running",
            version: "CI-pinned",
          },
        ],
      },
      [base]: {
        editable: true,
        draft,
        applied,
        last_job_id: "",
        last_error: "",
        rolled_back: false,
      },
      "/jobs/am-job": {
        id: "am-job",
        status: options.failed && !retried ? "failed" : "succeeded",
        error: options.failed && !retried ? "Применение не подтверждено" : "",
        finished_at: "2026-10-18T12:00:00Z",
      },
    };
    await route.fulfill({ json: responses[path] ?? [] });
  });
  await page.goto(`/#modules?instance=${id}&view=alertmanager`);
  return writes;
}
async function addWebhook(page: Page) {
  await page
    .getByRole("button", { name: "Добавить получателя", exact: true })
    .click();
  await page
    .getByLabel("Endpoint получателя 1", { exact: true })
    .fill("https://notify.example/hooks/fixture-private-endpoint");
}
async function save(page: Page, revision: number) {
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(
    page.getByText(`Черновик · версия ${revision}`, { exact: true }),
  ).toBeVisible();
}
async function apply(page: Page) {
  await page
    .getByRole("button", { name: "Проверить конфигурацию", exact: true })
    .click();
  await expect(
    page.getByText(/Конфигурация прошла проверку amtool/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Применить конфигурацию", exact: true })
    .click();
}
for (const theme of ["dark", "light"]) {
  test(`Alertmanager proxy, write-only fields and frozen apply (${theme})`, async ({
    page,
  }) => {
    const writes = await fixture(page);
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page
      .getByRole("button", { name: "Добавить получателя", exact: true })
      .click();
    await page
      .getByLabel("Канал получателя 1", { exact: true })
      .selectOption("telegram");
    await page
      .getByLabel("Токен Telegram 1", { exact: true })
      .fill("fixture-telegram-token");
    await page
      .getByLabel("Telegram chat ID 1", { exact: true })
      .fill("-100123456");
    await page
      .getByLabel("Доставка получателя 1", { exact: true })
      .selectOption("http");
    await page
      .getByLabel("HTTP proxy URL 1", { exact: true })
      .fill("http://proxy.example:3128");
    await page.getByLabel("Логин proxy 1", { exact: true }).fill("office");
    await page
      .getByLabel("Пароль proxy 1", { exact: true })
      .fill("fixture-proxy-password");
    await page
      .getByLabel("No proxy 1", { exact: true })
      .fill("localhost\n192.168.0.0/16");
    await page
      .getByLabel("CA получателя 1", { exact: true })
      .fill("fixture-public-ca-pem");
    await save(page, 1);
    await expect(
      page.getByLabel("Токен Telegram 1", { exact: true }),
    ).toHaveValue("");
    await expect(
      page.getByLabel("Пароль proxy 1", { exact: true }),
    ).toHaveValue("");
    await expect(
      page.getByLabel("CA получателя 1", { exact: true }),
    ).toHaveValue("");
    await apply(page);
    await expect(page.getByText(/Применена версия 1/)).toBeVisible();
    const put = writes.find((write) => write.path === base)!;
    expect(put.data.configuration).toMatchObject({
      receivers: [
        {
          kind: "telegram",
          token: "fixture-telegram-token",
          chat_id: -100123456,
          proxy: {
            mode: "http",
            url: "http://proxy.example:3128",
            username: "office",
            password: "fixture-proxy-password",
            ca_pem: "fixture-public-ca-pem",
            no_proxy: ["localhost", "192.168.0.0/16"],
          },
        },
      ],
    });
    expect(writes.find((write) => write.path.endsWith("/apply"))?.data).toEqual(
      { revision: 1, idempotency_key: expect.any(String) },
    );
    expect(
      writes.find((write) => write.path.endsWith("/validate"))?.data,
    ).toEqual({ configuration_ref: "77777777-7777-4777-8777-000000000001" });
    await page.getByLabel("Повтор уведомления", { exact: true }).fill("6h");
    await save(page, 2);
    const second = writes.filter((write) => write.path === base)[1].data
      .configuration as Configuration;
    expect(second.receivers[0].token).toBeUndefined();
    expect(second.receivers[0].proxy.password).toBeUndefined();
    expect(second.receivers[0].proxy.ca_pem).toBeUndefined();
    await expect(
      page.getByText(
        "Токен сохранён; пустое поле сохранит его при прежнем имени, канале и API endpoint.",
      ),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
        }),
      ),
    ).not.toContain("fixture-telegram-token");
    expect(await page.evaluate(() => location.href)).not.toContain(
      "fixture-proxy-password",
    );
  });
}
test("installed Alertmanager opens from Notifications sidebar and survives reload", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "Уведомления", exact: true }).click();
  await expect(page).toHaveURL(/#notifications$/);
  await expect(
    page.getByRole("heading", { name: "Уведомления Alertmanager", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Добавить получателя", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Уведомления Alertmanager", exact: true }),
  ).toBeVisible();
});

test("Alertmanager default has notifications disabled", async ({ page }) => {
  const writes = await fixture(page);
  await expect(
    page.getByText("Уведомления выключены: получатели не добавлены."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeDisabled();
  expect(writes).toHaveLength(0);
});
test("Alertmanager forbidden config exposes no editable receiver fields", async ({
  page,
}) => {
  const writes = await fixture(page, { forbidden: true });
  await expect(page.getByRole("alert")).toContainText(
    "нужны права администратора",
  );
  await expect(
    page.getByRole("button", { name: "Добавить получателя", exact: true }),
  ).toHaveCount(0);
  expect(writes).toHaveLength(0);
});
test("Alertmanager proxy rejects credentials in URL before save", async ({
  page,
}) => {
  const writes = await fixture(page);
  await addWebhook(page);
  await page
    .getByLabel("Доставка получателя 1", { exact: true })
    .selectOption("http");
  await page
    .getByLabel("HTTP proxy URL 1", { exact: true })
    .fill("http://user:fixture-secret@proxy.example:3128");
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "без встроенных credentials",
  );
  expect(writes).toHaveLength(0);
});
test("Alertmanager direct delivery clears stored proxy settings", async ({
  page,
}) => {
  const writes = await fixture(page);
  await addWebhook(page);
  await page
    .getByLabel("Доставка получателя 1", { exact: true })
    .selectOption("http");
  await page
    .getByLabel("HTTP proxy URL 1", { exact: true })
    .fill("http://proxy.example:3128");
  await page.getByLabel("Логин proxy 1", { exact: true }).fill("office");
  await page
    .getByLabel("Пароль proxy 1", { exact: true })
    .fill("fixture-clear-password");
  await page
    .getByLabel("CA получателя 1", { exact: true })
    .fill("fixture-retained-ca");
  await save(page, 1);
  await page
    .getByLabel("Доставка получателя 1", { exact: true })
    .selectOption("direct");
  await save(page, 2);
  const configuration = writes.filter((write) => write.path === base)[1].data
    .configuration as Configuration;
  expect(configuration.receivers[0].proxy).toEqual({
    mode: "direct",
    url: "",
    username: "",
    no_proxy: [],
  });
  expect(configuration.receivers[0].endpoint).toBeUndefined();
  await expect(
    page.getByLabel("HTTP proxy URL 1", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("CA получателя 1", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("CA получателя 1", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    page.getByText(/CA сохранён; пустое поле сохранит сертификат/),
  ).toBeVisible();
});
test("Alertmanager retry uses same persistent job", async ({ page }) => {
  const writes = await fixture(page, { failed: true });
  await addWebhook(page);
  await save(page, 1);
  await apply(page);
  await page
    .getByRole("button", { name: "Повторить то же задание", exact: true })
    .click();
  await expect(page.getByText(/Применена версия 1/)).toBeVisible();
  expect(writes.find((write) => write.path.endsWith("/retry"))?.data).toEqual({
    job_id: "am-job",
  });
  expect(writes.filter((write) => write.path.endsWith("/apply"))).toHaveLength(
    1,
  );
});
test("Alertmanager revision conflict leaves entered endpoint available for correction", async ({
  page,
}) => {
  await fixture(page, { conflict: true });
  await addWebhook(page);
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("другим администратором");
  await expect(
    page.getByLabel("Endpoint получателя 1", { exact: true }),
  ).toHaveValue("https://notify.example/hooks/fixture-private-endpoint");
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeDisabled();
});

test("Alertmanager rejects noncanonical durations before PUT", async ({
  page,
}) => {
  const writes = await fixture(page);
  await addWebhook(page);
  const interval = page.getByLabel("Интервал группы", { exact: true });
  for (const value of ["1h30m", "01m", "-1s", "169h"]) {
    await interval.fill(value);
    await page
      .getByRole("button", { name: "Сохранить черновик", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("Проверьте интервалы");
    expect(writes).toHaveLength(0);
    await page
      .getByRole("button", { name: "Закрыть уведомление", exact: true })
      .click();
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  await interval.fill("10m");
  await save(page, 1);
  expect(writes[0].data.configuration).toMatchObject({
    route: { group_interval: "10m" },
  });
});

test("Alertmanager rejects invalid receiver names before PUT", async ({
  page,
}) => {
  const writes = await fixture(page);
  await addWebhook(page);
  const name = page.getByLabel("Название получателя 1", { exact: true });
  for (const value of ["1office", "_office", "office space"]) {
    await name.fill(value);
    await page
      .getByRole("button", { name: "Сохранить черновик", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("Название получателя:");
    expect(writes).toHaveLength(0);
    await page
      .getByRole("button", { name: "Закрыть уведомление", exact: true })
      .click();
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  await name.fill("office.notifications-1");
  await save(page, 1);
  expect(writes[0].data.configuration).toMatchObject({
    receivers: [{ name: "office.notifications-1" }],
  });
});

test("Alertmanager does not reuse a proxy password at a new proxy address", async ({
  page,
}) => {
  const writes = await fixture(page);
  await addWebhook(page);
  await page
    .getByLabel("Доставка получателя 1", { exact: true })
    .selectOption("http");
  await page
    .getByLabel("HTTP proxy URL 1", { exact: true })
    .fill("http://proxy.example:3128");
  await page.getByLabel("Логин proxy 1", { exact: true }).fill("office");
  await page
    .getByLabel("Пароль proxy 1", { exact: true })
    .fill("fixture-first-password");
  await save(page, 1);
  await page
    .getByLabel("HTTP proxy URL 1", { exact: true })
    .fill("http://new-proxy.example:3128");
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Задайте пароль нового proxy-пользователя",
  );
  expect(writes).toHaveLength(1);
  await page
    .getByLabel("Пароль proxy 1", { exact: true })
    .fill("fixture-second-password");
  await save(page, 2);
  expect(
    (writes[1].data.configuration as Configuration).receivers[0].proxy.password,
  ).toBe("fixture-second-password");
});

test("Alertmanager requires a fresh bot token for an entered Telegram API endpoint", async ({
  page,
}) => {
  const writes = await fixture(page);
  await page
    .getByRole("button", { name: "Добавить получателя", exact: true })
    .click();
  await page
    .getByLabel("Канал получателя 1", { exact: true })
    .selectOption("telegram");
  await page
    .getByLabel("Токен Telegram 1", { exact: true })
    .fill("fixture-first-token");
  await page
    .getByLabel("Telegram chat ID 1", { exact: true })
    .fill("-100123456");
  await save(page, 1);
  await page
    .getByLabel("Endpoint получателя 1", { exact: true })
    .fill("https://new-telegram.example/");
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("задайте токен заново");
  expect(writes).toHaveLength(1);
  await page
    .getByLabel("Токен Telegram 1", { exact: true })
    .fill("fixture-second-token");
  await save(page, 2);
  expect(
    (writes[1].data.configuration as Configuration).receivers[0].token,
  ).toBe("fixture-second-token");
});

test("Alertmanager explicitly removes a saved receiver CA", async ({
  page,
}) => {
  const writes = await fixture(page);
  await addWebhook(page);
  await page
    .getByLabel("CA получателя 1", { exact: true })
    .fill("fixture-existing-ca");
  await save(page, 1);
  const clear = page.getByRole("checkbox", {
    name: "Использовать системные CA получателя 1",
    exact: true,
  });
  await expect(clear).toBeVisible();
  await clear.check();
  await save(page, 2);
  const configuration = writes[1].data.configuration as Configuration;
  expect(configuration.receivers[0].proxy).toMatchObject({
    mode: "direct",
    clear_ca: true,
  });
  expect(configuration.receivers[0].proxy.ca_pem).toBeUndefined();
  await expect(clear).toHaveCount(0);
  await expect(
    page.getByText(/CA сохранён; пустое поле сохранит сертификат/),
  ).toHaveCount(0);
  await page.getByLabel("Повтор уведомления", { exact: true }).fill("6h");
  await save(page, 3);
  expect(
    (writes[2].data.configuration as Configuration).receivers[0].proxy.clear_ca,
  ).toBeUndefined();
});

test("Alertmanager entering a replacement CA cancels explicit removal", async ({
  page,
}) => {
  const writes = await fixture(page);
  await addWebhook(page);
  await page
    .getByLabel("CA получателя 1", { exact: true })
    .fill("fixture-existing-ca");
  await save(page, 1);
  const clear = page.getByRole("checkbox", {
    name: "Использовать системные CA получателя 1",
    exact: true,
  });
  await clear.check();
  await page
    .getByLabel("CA получателя 1", { exact: true })
    .fill("fixture-replacement-ca");
  await expect(clear).not.toBeChecked();
  await save(page, 2);
  const settings = (writes[1].data.configuration as Configuration).receivers[0]
    .proxy;
  expect(settings.ca_pem).toBe("fixture-replacement-ca");
  expect(settings.clear_ca).toBeUndefined();
});

for (const tlsMode of ["starttls", "implicit"]) {
  test(`Alertmanager email SMTP ${tlsMode}, write-only password and apply`, async ({
    page,
  }) => {
    const writes = await fixture(page);
    await page
      .getByRole("button", { name: "Добавить получателя", exact: true })
      .click();
    await page
      .getByLabel("Канал получателя 1", { exact: true })
      .selectOption("email");
    await expect(
      page.getByLabel("Endpoint получателя 1", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByLabel("Доставка получателя 1", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByLabel("SMTP сервер 1", { exact: true })
      .fill("smtp.example.invalid:587");
    await page
      .getByLabel("Защита SMTP 1", { exact: true })
      .selectOption(tlsMode);
    await page
      .getByLabel("Отправитель SMTP 1", { exact: true })
      .fill("alerts@example.invalid");
    await page
      .getByLabel("Получатели SMTP 1", { exact: true })
      .fill("ops@example.invalid\nadmin@example.invalid");
    await page.getByLabel("Логин SMTP 1", { exact: true }).fill("operator");
    await page
      .getByLabel("Пароль SMTP 1", { exact: true })
      .fill("fixture-smtp-password");
    await save(page, 1);
    const mail = (writes[0].data.configuration as Configuration).receivers[0];
    expect(mail.kind).toBe("email");
    expect(mail.smtp?.to).toEqual([
      "ops@example.invalid",
      "admin@example.invalid",
    ]);
    expect(mail.smtp?.tls_mode).toBe(tlsMode);
    expect(mail.smtp?.password).toBe("fixture-smtp-password");
    expect(mail.proxy.mode).toBe("direct");
    await expect(page.getByLabel("Пароль SMTP 1", { exact: true })).toHaveValue(
      "",
    );
    await expect(
      page.getByLabel("Отправитель SMTP 1", { exact: true }),
    ).toHaveValue("alerts@example.invalid");
    await apply(page);
    // A benign edit retains the private password without putting it back in the request.
    await page
      .getByLabel("Получатели SMTP 1", { exact: true })
      .fill("ops@example.invalid");
    await save(page, 2);
    const saves = writes.filter((entry) => entry.path === base);
    expect(
      (saves.at(-1)!.data.configuration as Configuration).receivers[0].smtp
        ?.password,
    ).toBeUndefined();
    await page
      .getByLabel("SMTP сервер 1", { exact: true })
      .fill("different.example.invalid:587");
    await page
      .getByRole("button", { name: "Сохранить черновик", exact: true })
      .click();
    await expect(
      page.getByText(
        "Задайте пароль SMTP для этого сервера, режима TLS и логина.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(writes.filter((entry) => entry.path === base)).toHaveLength(2);
  });
}

test("Alertmanager Teams Workflows v2 endpoint is write-only and configuration applies", async ({
  page,
}) => {
  const writes = await fixture(page);
  await page
    .getByRole("button", { name: "Добавить получателя", exact: true })
    .click();
  await page
    .getByLabel("Канал получателя 1", { exact: true })
    .selectOption("msteamsv2");
  await expect(
    page.getByLabel("Routing key PagerDuty 1", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel("Endpoint получателя 1", { exact: true })
    .fill("https://workflow.example.invalid/private-teams-hook");
  await save(page, 1);
  const receiver = (writes[0].data.configuration as Configuration).receivers[0];
  expect(receiver.kind).toBe("msteamsv2");
  expect(receiver.endpoint).toBe(
    "https://workflow.example.invalid/private-teams-hook",
  );
  expect(receiver.token).toBeUndefined();
  await expect(
    page.getByLabel("Endpoint получателя 1", { exact: true }),
  ).toHaveValue("");
  await apply(page);
  await expect(
    page.getByLabel("Endpoint получателя 1", { exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel("Канал получателя 1", { exact: true })
    .selectOption("pagerduty");
  await expect(
    page.getByLabel("Routing key PagerDuty 1", { exact: true }),
  ).toHaveValue("");
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(
    page.getByText("Задайте routing key интеграции PagerDuty Events API v2.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(writes.filter((entry) => entry.path === base)).toHaveLength(1);
});

test("Alertmanager PagerDuty Events v2 routing key is write-only and bound to endpoint", async ({
  page,
}) => {
  const writes = await fixture(page);
  await page
    .getByRole("button", { name: "Добавить получателя", exact: true })
    .click();
  await page
    .getByLabel("Канал получателя 1", { exact: true })
    .selectOption("pagerduty");
  await expect(
    page.getByLabel("Telegram chat ID 1", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel("Routing key PagerDuty 1", { exact: true })
    .fill("fixture-pagerduty-routing-key");
  await save(page, 1);
  const receiver = (writes[0].data.configuration as Configuration).receivers[0];
  expect(receiver.kind).toBe("pagerduty");
  expect(receiver.token).toBe("fixture-pagerduty-routing-key");
  expect(receiver.endpoint).toBeUndefined();
  await expect(
    page.getByLabel("Routing key PagerDuty 1", { exact: true }),
  ).toHaveValue("");
  await apply(page);
  await expect(
    page.getByLabel("Endpoint получателя 1", { exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel("Endpoint получателя 1", { exact: true })
    .fill("https://controlled.example.invalid/enqueue");
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(
    page.getByText("При вводе PagerDuty endpoint задайте routing key заново.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(writes.filter((entry) => entry.path === base)).toHaveLength(1);
  await page
    .getByLabel("Routing key PagerDuty 1", { exact: true })
    .fill("explicit-new-routing-key");
  await save(page, 2);
  expect(
    (
      writes.filter((entry) => entry.path === base).at(-1)!.data
        .configuration as Configuration
    ).receivers[0].token,
  ).toBe("explicit-new-routing-key");
});
