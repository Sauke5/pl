import { expect, test, type Page } from "@playwright/test";

const instanceID = "4229a9e2-2759-44e2-8ec3-d9017afe017b";
const base = "/modules/" + instanceID + "/syslog";
const sw = { source: "sw-floor-2", address: "192.0.2.22" };
const gw = { source: "gw-office", address: "192.0.2.1" };
const receipt = (sec: string) => "2026-11-18T06:42:" + sec + "Z";
const switchMessage = {
  ...sw,
  time: receipt("07"),
  device_time: receipt("05"),
  severity: "4",
  program: "ifmgr",
  format: "rfc5424",
  message: "Interface Gi1/0/24 link down",
};
const gatewayMessage = {
  ...gw,
  time: receipt("09"),
  severity: "4",
  program: "routerd",
  format: "rfc5424",
  message: "Echo probe on vlan20 timed out",
};
const upMessage = {
  ...sw,
  time: receipt("29"),
  device_time: receipt("27"),
  severity: "5",
  program: "ifmgr",
  format: "rfc5424",
  message: "Interface Gi1/0/24 link up",
};
const device = { source: "sw-east", address: "192.0.2.33" };
async function fixture(page: Page, empty = false) {
  const state = {
    failSources: false,
    failMessages: false,
    failReceiver: false,
    conflict: false,
    arrived: false,
  };
  let config = {
    address: empty ? "" : "192.0.2.10",
    addresses: ["192.0.2.10", "192.0.2.11"],
    port: 1514,
    udp: true,
    tcp: true,
    retention_days: 14,
    revision: 5,
  };
  const reads: URL[] = [];
  const writes: Record<string, unknown>[] = [];
  await page.clock.setFixedTime(new Date("2026-11-18T07:00:00Z"));
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      u = new URL(req.url()),
      path = u.pathname.replace("/api/v1", "");
    const q = u.searchParams;
    const fail = (message: string, status = 502) =>
      route.fulfill({
        status,
        json: {
          error: status === 409 ? "revision_conflict" : "storage_unavailable",
          message,
        },
      });
    if (path === base + "/receiver") {
      if (req.method() === "PUT") {
        const payload = req.postDataJSON();
        writes.push(payload);
        if (state.conflict) {
          state.conflict = false;
          config.revision++;
          return fail("Настройки изменены", 409);
        }
        if (payload.expected_revision !== config.revision)
          return fail("Настройки изменены", 409);
        const { expected_revision, ...change } = payload;
        config = { ...config, ...change, revision: expected_revision + 1 };
      } else if (state.failReceiver) return fail("Адреса хоста недоступны");
      return route.fulfill({ json: config });
    }
    if (path === base + "/sources") {
      reads.push(u);
      if (state.failSources) return fail("Не удалось прочитать источники");
      const observed = state.arrived
        ? [
            {
              ...device,
              last_seen: "2026-11-18T07:00:00Z",
              severity: "6",
              last_message: "Device test",
            },
          ]
        : [];
      const items = empty
        ? observed
        : [
            ...observed,
            ...[gatewayMessage, upMessage].map((m) => ({
              ...m,
              last_seen: m.time,
              last_message: m.message,
            })),
          ];
      return route.fulfill({ json: { items, truncated: false } });
    }
    if (path === base + "/messages") {
      reads.push(u);
      if (state.failMessages) return fail("Хранилище сообщений недоступно");
      if (
        q.get("source") === device.source &&
        q.get("address") === device.address
      ) {
        const from = Date.parse(q.get("from")!);
        const candidate = {
          ...device,
          time: new Date(from).toISOString(),
          severity: "6",
          message: "Device test",
        };
        return route.fulfill({
          json: {
            items: [
              { ...candidate, source: "other-device" },
              { ...candidate, address: "192.0.2.99" },
              { ...candidate, time: new Date(from - 60000).toISOString() },
              ...(state.arrived ? [candidate] : []),
            ],
            truncated: false,
          },
        });
      }
      const items = (
        empty ? [] : [upMessage, gatewayMessage, switchMessage]
      ).filter(
        (m) =>
          (!q.has("source") || q.get("source") === m.source) &&
          (!q.has("address") || q.get("address") === m.address) &&
          (!q.has("severity") || q.get("severity") === m.severity) &&
          (!q.has("text") ||
            m.message.toLowerCase().includes(q.get("text")!.toLowerCase())) &&
          Date.parse(m.time) >= Date.parse(q.get("from")!) &&
          Date.parse(m.time) <= Date.parse(q.get("to")!),
      );
      return route.fulfill({ json: { items, truncated: false } });
    }
    const common: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "syslog-admin", name: "Admin", admin: true },
        csrf_token: "test-syslog",
        features: {},
      },
      "/help-state": { disabled: true, seen: [] },
      "/preferences": {
        favorites: [],
        hidden_sections: [],
        section_order: [],
        home_widgets: [],
      },
      "/delivery": { modules: [], core_api: 1 },
      "/modules": {
        items: [
          {
            id: instanceID,
            module_id: "syslog",
            name: "Центральный syslog",
            mode: "local",
            desired_state: "enabled",
            observed_state: "running",
            revision: 1,
            last_attempt: "2026-11-18T07:00:00Z",
            last_success: "2026-11-18T07:00:00Z",
          },
        ],
      },
      "/modules/catalog": {
        local_available: true,
        items: [
          {
            id: "syslog",
            name: "Центральный syslog",
            description: "Журнал сетевых устройств",
            version: "1",
            modes: ["local"],
          },
        ],
      },
    };
    return route.fulfill({ json: common[path] ?? [] });
  });
  return { state, reads, writes };
}
test("Из каталога открываются источники, а журнал сохраняет точные границы периода и поля сообщения", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/#module-catalog");
  await page
    .getByRole("searchbox", { name: "Поиск по каталогу модулей" })
    .fill("syslog");
  await page.getByRole("link", { name: "Открыть syslog" }).click();
  await expect(
    page.getByRole("heading", { name: "Источники syslog" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /gw-office.*192\.0\.2\.1/ }),
  ).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Поиск источника" });
  await search.fill("192.0.2.22");
  const source = page.getByRole("button", {
    name: /sw-floor-2.*192\.0\.2\.22/,
  });
  await source.click();
  await expect(source).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Период приёма").selectOption("custom");
  await page.getByLabel("Начало периода").fill("2026-11-18T09:40");
  await page.getByLabel("Конец периода").fill("2026-11-18T09:45");
  await page.getByRole("button", { name: "Применить период" }).click();
  await page.getByLabel("Уровень syslog").selectOption("4");
  await page
    .getByRole("searchbox", { name: "Текст сообщения" })
    .fill("Gi1/0/24");
  const event = page.getByRole("button", { name: switchMessage.message });
  await expect(event).toBeVisible();
  const from = "2026-11-18T06:40:00.000Z",
    to = "2026-11-18T06:45:00.000Z";
  await expect
    .poll(() =>
      f.reads
        .filter((u) => u.pathname.endsWith("/messages"))
        .at(-1)
        ?.searchParams.get("text"),
    )
    .toBe("Gi1/0/24");
  expect(
    Object.fromEntries(
      f.reads.filter((u) => u.pathname.endsWith("/messages")).at(-1)!
        .searchParams,
    ),
  ).toEqual({ from, to, ...sw, text: "Gi1/0/24", severity: "4" });
  await event.click();
  const detail = page.getByRole("dialog", { name: "Сообщение syslog" });
  await expect(
    detail.getByRole("heading", { name: "Текст сообщения" }),
  ).toBeVisible();
  await expect(detail.locator("pre")).toHaveText(switchMessage.message);
  await expect(detail).toContainText("09:42:05");
  await expect(detail).toContainText("09:42:07");
  await expect(detail).toContainText("192.0.2.22");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Все устройства за этот период" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Журнал syslog" }),
  ).toBeVisible();
  await page.getByRole("searchbox", { name: "Текст сообщения" }).fill("");
  await page.getByLabel("Уровень syslog").selectOption("");
  const gwEvent = page.getByRole("button", { name: gatewayMessage.message });
  await gwEvent.click();
  await expect(detail).toContainText("Не передано");
  expect(
    Object.fromEntries(
      f.reads.filter((u) => u.pathname.endsWith("/messages")).at(-1)!
        .searchParams,
    ),
  ).toEqual({ from, to });
});

test("Первый приём: параметры хоста, ожидание совпадающих имени и адреса, затем открытие поступившего сообщения", async ({
  page,
}) => {
  const f = await fixture(page, true);
  await page.goto("/#modules?instance=" + instanceID + "&view=syslog");
  await expect(page.getByText("За этот период источников нет")).toBeVisible();
  await page.getByRole("button", { name: "Подключить устройство" }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Приём syslog из сети выключен");
  await dialog.getByRole("button", { name: "Настроить приёмник" }).click();
  await expect(dialog).toHaveAccessibleName("Настройки приёмника syslog");
  await dialog
    .getByLabel("Адрес приёма на хосте PL")
    .selectOption("192.0.2.10");
  await dialog.getByLabel("Порт приёма").fill("5514");
  await dialog.getByLabel("UDP", { exact: true }).uncheck();
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog).toHaveAccessibleName("Подключить устройство");
  expect(f.writes).toEqual([
    {
      address: "192.0.2.10",
      udp: false,
      tcp: true,
      port: 5514,
      retention_days: 14,
      expected_revision: 5,
    },
  ]);
  await expect(dialog).toContainText("192.0.2.10");
  await expect(dialog).toContainText("5514");
  await expect(dialog.locator("dd").filter({ hasText: "TCP" })).toHaveText(
    "TCP",
  );
  await dialog.getByLabel("Имя устройства в syslog").fill(device.source);
  await dialog.getByLabel("IP отправителя").fill(device.address);
  f.state.failMessages = true;
  await dialog.getByRole("button", { name: "Начать ожидание" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Хранилище сообщений недоступно",
  );
  f.state.failMessages = false;
  await dialog.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Ожидаем сообщение");
  await expect(
    dialog.getByRole("button", { name: "Открыть сообщение" }),
  ).toHaveCount(0);
  f.state.arrived = true;
  await dialog.getByRole("button", { name: "Проверить поступление" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Получено сообщение от устройства",
  );
  await dialog.getByRole("button", { name: "Открыть сообщение" }).click();
  dialog = page.getByRole("dialog", { name: "Сообщение syslog" });
  await expect(dialog.locator("pre")).toHaveText("Device test");
  await expect(dialog).toContainText(device.address);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: /sw-east.*192\.0\.2\.33/ }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("Сбой чтения отличается от пустого результата, конфликт настроек можно перечитать", async ({
  page,
}) => {
  const f = await fixture(page);
  f.state.failSources = true;
  await page.goto("/#modules?instance=" + instanceID + "&view=syslog");
  await expect(page.getByRole("alert")).toContainText(
    "Не удалось прочитать источники",
  );
  await expect(page.getByText("За этот период источников нет")).toHaveCount(0);
  f.state.failSources = false;
  await page
    .getByRole("alert")
    .getByRole("button", { name: "Повторить" })
    .click();
  await page.getByRole("button", { name: /gw-office.*192\.0\.2\.1/ }).click();
  f.state.failReceiver = true;
  await page.getByRole("button", { name: "Приёмник", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText(
    "Адреса хоста недоступны",
  );
  f.state.failReceiver = false;
  await dialog.getByRole("button", { name: "Повторить" }).click();
  await dialog.getByLabel("Порт приёма").fill("6514");
  f.state.conflict = true;
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("Порт приёма")).toHaveValue("6514");
  await dialog
    .getByRole("button", { name: "Загрузить текущие параметры" })
    .click();
  await expect(dialog.getByLabel("Порт приёма")).toHaveValue("1514");
  await dialog.getByLabel("Хранение, дней").fill("21");
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog).toHaveCount(0);
  expect(f.writes.at(-1)).toMatchObject({
    retention_days: 21,
    expected_revision: 6,
  });
});
