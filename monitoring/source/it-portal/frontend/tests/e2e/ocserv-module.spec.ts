import { expect, test, type Page } from "@playwright/test";
import type { VPNState } from "../../src/ocserv";
import type { GatewaySetup } from "../../src/OcservGateway";

const id = "112a5e71-c9b3-4e90-83c9-8ff7b8384332";
const pageURL = "/#modules?instance=" + id + "&view=ocserv";
const path = "/modules/" + id + "/ocserv/";
const profile = { id: "office", name: "Офис", networks: ["10.80.10.0/24"] };
const grant = {
  subject: "user-87",
  display_name: "Анна Смирнова",
  profile_id: "office",
  expires_at: "",
  status: "active",
};
const gatewaySetup = (ready = false): GatewaySetup => ({
  revision: "setup-1",
  name: "Корпоративный VPN",
  auth_mode: ready ? "oidc" : "",
  public_host: ready ? "vpn.example.test" : "",
  public_port: 4443,
  bind_address: ready ? "192.168.10.4" : "",
  port: 4443,
  pool: ready ? "10.77.0.0/24" : "",
  issuer: ready ? "https://id.example.test/dex" : "",
  client_id: ready ? "pl-vpn" : "",
  has_certificate: ready,
  has_key: ready,
  has_client_secret: ready,
  has_idp_ca: ready,
  certificate_pin: "",
  ready,
});

async function setupAPI(page: Page, state: VPNState, setup = gatewaySetup()) {
  const flags = {
    discoveries: 0,
    conflict: false,
    reject: false,
    publicIP: "198.51.100.17",
  };
  const updates: Record<string, unknown>[] = [];
  await page.route("**/api/v1" + path + "discovery", async (route) => {
    flags.discoveries++;
    return route.fulfill({
      json: {
        public_ip: flags.publicIP,
        source: flags.publicIP ? "external" : "unavailable",
        addresses: ["192.168.10.4"],
        bind_address: "192.168.10.4",
        pool: "10.77.0.0/24",
      },
    });
  });
  await page.route("**/api/v1" + path + "setup", async (route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fulfill({ json: setup });
    expect(req.method()).toBe("POST");
    expect(req.headers()["x-csrf-token"]).toBe("browser-fixture");
    const body = req.postDataJSON();
    updates.push(body);
    if (flags.conflict) {
      flags.conflict = false;
      setup.revision = "changed-by-operator";
      setup.public_host = "vpn2.example.test";
      return route.fulfill({
        status: 409,
        json: { error: "ocserv_conflict", message: "Конфликт версии" },
      });
    }
    if (flags.reject) {
      flags.reject = false;
      return route.fulfill({
        status: 422,
        json: {
          error: "invalid_setup",
          message: "Сертификат не соответствует ключу.",
        },
      });
    }
    expect(body.revision).toBe(setup.revision);
    for (const field of [
      "name",
      "auth_mode",
      "issuer",
      "client_id",
      "public_host",
      "bind_address",
      "pool",
    ] as const)
      setup[field] = body[field] || "";
    setup.public_port = body.public_port;
    setup.port = body.port;
    setup.ready = setup.has_certificate = setup.has_key = true;
    setup.revision += "-applied";
    if ("client_secret" in body) setup.has_client_secret = !!body.client_secret;
    if ("idp_ca_pem" in body) setup.has_idp_ca = !!body.idp_ca_pem;
    setup.managed_certificates = setup.auth_mode === "certificate";
    Object.assign(state.gateway, {
      ready: true,
      name: setup.name,
      auth_mode: setup.auth_mode,
      managed_certificates: setup.managed_certificates,
      pool: setup.pool,
    });
    return route.fulfill({ json: setup });
  });
  return { flags, updates };
}
function example(): VPNState {
  return {
    revision: 4,
    gateway: {
      name: "Основной шлюз",
      auth_mode: "certificate",
      ready: true,
      pool: "10.77.0.0/24",
      observed_at: "2026-11-17T10:00:00Z",
      sessions_known: true,
    },
    profiles: [
      profile,
      {
        id: "support",
        name: "Поддержка",
        networks: ["10.80.10.0/25", "10.80.20.0/24"],
      },
      {
        id: "combined",
        name: "Два сегмента",
        networks: ["10.80.10.0/25", "10.80.10.128/25"],
      },
    ],
    grants: [grant],
    sessions: [
      {
        id: "7",
        subject: grant.subject,
        ip: "10.77.0.15",
        device: "OpenConnect",
        since: "2026-11-17T09:56:42Z",
      },
    ],
    events: [],
  };
}

// Browser contract fixture. Real TLS, packet rules and cookie revocation are covered by the ocserv lab.
async function portal(page: Page, initial = example(), admin = true) {
  const state = structuredClone(initial);
  const writes: { action: string; body: Record<string, unknown> }[] = [];
  const flags = { reads: 0, conflict: false, forbidden: false };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const routePath = new URL(request.url()).pathname.slice("/api/v1".length);
    const reply = (json: unknown, status = 200) =>
      route.fulfill({ json, status });
    if (routePath === "/stream") return; // Keep the shell SSE connection pending in this contract fixture.
    if (routePath.startsWith(path)) {
      const action = routePath.slice(path.length);
      if (flags.forbidden)
        return reply(
          {
            error: "forbidden",
            message: "Недостаточно прав для управления VPN.",
          },
          403,
        );
      if (action === "state") {
        expect(request.method()).toBe("GET");
        flags.reads++;
        return reply(state);
      }
      expect(request.method()).toBe("POST");
      expect(request.headers()["x-csrf-token"]).toBe("browser-fixture");
      const body = request.postDataJSON();
      writes.push({ action, body });
      if (flags.conflict) {
        flags.conflict = false;
        state.revision++;
        return reply(
          { error: "revision_conflict", message: "Конфликт версии" },
          409,
        );
      }
      expect(body.revision).toBe(state.revision);
      expect(body).not.toHaveProperty("actor");
      switch (action) {
        case "profile":
          state.profiles = [
            ...state.profiles.filter((item) => item.id !== body.id),
            { id: body.id, name: body.name, networks: body.networks },
          ];
          break;
        case "grant":
          state.grants = [
            ...state.grants.filter((item) => item.subject !== body.subject),
            {
              subject: body.subject,
              display_name: body.display_name,
              profile_id: body.profile_id,
              expires_at: body.expires_at,
              status: "active",
            },
          ];
          break;
        case "revoke":
          state.grants.find((item) => item.subject === body.subject)!.status =
            "revoked";
          state.sessions = state.sessions.filter(
            (item) => item.subject !== body.subject,
          );
          break;
        case "terminate":
          state.sessions = state.sessions.filter((item) => item.id !== body.id);
          break;
        default:
          throw new Error("Unexpected gateway operation: " + action);
      }
      state.events.unshift({
        at: "2026-11-17T10:00:00Z",
        actor: "admin",
        subject: body.subject || body.id,
        action,
      });
      state.revision++;
      return reply(state);
    }
    const common: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "admin", name: "Администратор", admin },
        csrf_token: "browser-fixture",
        features: {},
      },
      "/preferences": {
        favorites: [],
        hidden_sections: [],
        section_order: [],
        home_widgets: [],
      },
      "/help-state": { disabled: true, seen: [] },
      "/delivery": { modules: [], core_api: 1 },
      "/modules": {
        items: [
          {
            id,
            module_id: "ocserv",
            name: "Корпоративный VPN",
            mode: "local",
            version: "1.6.0",
            desired_state: "enabled",
            observed_state: "running",
            revision: 1,
          },
        ],
      },
      "/modules/catalog": {
        local_available: true,
        items: [
          {
            id: "ocserv",
            name: "Корпоративный VPN",
            description: "Доступ сотрудников к корпоративным сетям.",
            version: "1.6.0",
            modes: ["local"],
            direction: "Сети",
            capabilities: [],
          },
          {
            id: "syslog",
            name: "Сбор журналов",
            description: "Системные события",
            modes: ["local"],
            direction: "Мониторинг",
            capabilities: [],
          },
        ],
      },
    };
    return reply(common[routePath] ?? []);
  });
  return { state, writes, flags };
}

test("Корпоративный VPN открывается из бокового меню сразу под прокси", async ({
  page,
}) => {
  await portal(page);
  await page.route("**/api/v1/modules", (route) =>
    route.fulfill({
      json: {
        items: [
          { id: "xray-instance", module_id: "xray", name: "Прокси" },
          { id, module_id: "ocserv", name: "Корпоративный VPN" },
        ].map((item) => ({
          ...item,
          mode: "local",
          desired_state: "enabled",
          observed_state: "running",
        })),
      },
    }),
  );
  await page.goto("/#modules");
  const navigation = page.getByRole("navigation", {
    name: "Основная навигация",
  });
  const proxy = navigation.getByRole("link", { name: "Прокси", exact: true });
  const vpn = navigation.getByRole("link", {
    name: "Корпоративный VPN",
    exact: true,
  });
  await expect(proxy.locator("+ a")).toHaveText("Корпоративный VPN");
  await vpn.click();
  await expect(page).toHaveURL((url) => url.hash === pageURL.slice(1));
  await expect(vpn).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Корпоративный VPN", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Сети и профили", exact: true }).click();
  await expect(vpn).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Матрица доступа" }),
  ).toBeVisible();
});

test("Карточка VPN под прокси открывает мастер шлюза из настроек", async ({
  page,
}) => {
  const { state } = await portal(page);
  await setupAPI(page, state);
  await page.goto("/#settings");
  const navigation = page.getByRole("navigation", { name: "Разделы настроек" });
  const proxy = navigation.getByRole("button", {
    name: "Прокси для загрузок",
    exact: true,
  });
  await expect(proxy.locator("+ button")).toHaveText("Корпоративный VPN");
  await page
    .getByRole("searchbox", { name: "Поиск по настройкам" })
    .fill("OpenConnect");
  await page
    .locator('[aria-label="Результаты поиска настроек"]')
    .getByRole("button", { name: /Корпоративный VPN/ })
    .click();
  await expect(page).toHaveURL(/#settings\?section=vpn$/);
  await expect(
    page.getByRole("heading", { name: "Корпоративный VPN", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Открыть модуль VPN" }),
  ).toHaveAttribute("href", pageURL.slice(1));
  await page.getByRole("button", { name: "Настроить шлюз" }).click();
  const wizard = page.getByRole("dialog", { name: "Шлюз VPN" });
  await expect(wizard.getByLabel("Внешний адрес VPN")).toHaveValue(
    "198.51.100.17",
  );
  await wizard.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(wizard).toHaveCount(0);
  await expect(page).toHaveURL(/#settings\?section=vpn$/);
});

test("Настройки VPN ведут в каталог, если модуль ещё не установлен", async ({
  page,
}) => {
  await portal(page);
  await page.route("**/api/v1/modules", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.goto("/#settings?section=vpn");
  await expect(page.getByText("Корпоративный VPN не установлен")).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Основная навигация" })
      .getByRole("link", { name: "Корпоративный VPN", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Настроить шлюз" }),
  ).toHaveCount(0);
  const settings = page.locator("[data-settings-content]");
  await settings.getByRole("link", { name: "Каталог модулей" }).click();
  await expect(page).toHaveURL(/#module-catalog$/);
});

test("Каталог сетей открывает сотрудников, матрица учитывает пересекающиеся сети и возврат к сотруднику", async ({
  page,
}, info) => {
  const { writes } = await portal(page);
  await page.goto("/#module-catalog");
  await page
    .getByRole("combobox", { name: "Направление", exact: true })
    .selectOption("Сети");
  await expect(page).toHaveURL(/direction=/);
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Направление", exact: true }),
  ).toHaveValue("Сети");
  await expect(
    page.getByRole("heading", { name: "Сбор журналов" }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Открыть VPN" }).click();
  await expect(
    page.getByRole("link", { name: "Сотрудники", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Доступ сотрудников" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Карточка доступа" }),
  ).toBeVisible();
  await expect(page.getByText("OpenConnect", { exact: true })).toBeVisible();
  const viewport = page.viewportSize()!;
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(viewport.width);
  await page.screenshot({ path: info.outputPath("employees.png") });
  await page.getByRole("link", { name: "Сети и профили", exact: true }).click();
  await expect(page).toHaveURL(/tab=networks$/);
  let row = page.getByRole("row", { name: /10\.80\.10\.0\/24/ });
  await expect(row.getByRole("cell")).toHaveText([
    "Разрешено",
    "Частично",
    "Разрешено",
  ]);
  row = page.getByRole("row", { name: /10\.80\.20\.0\/24/ });
  await expect(row.getByRole("cell")).toHaveText([
    "Закрыто",
    "Разрешено",
    "Закрыто",
  ]);
  await page.screenshot({ path: info.outputPath("networks.png") });
  await page.reload();
  await expect(
    page.getByRole("link", { name: "Сети и профили" }),
  ).toHaveAttribute("aria-current", "page");
  await page
    .getByRole("button", { name: "Открыть доступ: Анна Смирнова" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Карточка доступа" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Завершить сессию 7" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Завершить сессию", exact: true })
    .click();
  await expect(page.getByText("Открытых сессий нет.")).toBeVisible();
  expect(writes.at(-1)).toEqual({
    action: "terminate",
    body: { id: "7", revision: 4 },
  });
  await page.getByRole("button", { name: "Отозвать доступ" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Отозвать доступ" })
    .click();
  await expect(
    page.getByRole("button", { name: "Выдать повторно" }),
  ).toBeVisible();
  expect(writes.at(-1)).toEqual({
    action: "revoke",
    body: { subject: "user-87", revision: 5 },
  });
  await page.getByRole("button", { name: "Журнал", exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("row", { name: /Отзыв доступа user-87 admin/ }),
  ).toBeVisible();
});

test("Пустой шлюз позволяет подготовить профиль и назначить сотрудника по идентификатору провайдера", async ({
  page,
}) => {
  const seed = example();
  seed.profiles = [];
  seed.grants = [];
  seed.sessions = [];
  seed.gateway.ready = false;
  seed.gateway.auth_mode = "oidc";
  const { writes } = await portal(page, seed);
  await page.goto(pageURL);
  await expect(
    page.getByRole("button", { name: "Выдать доступ", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Создать профиль", exact: true })
    .click();
  let d = page.getByRole("dialog");
  await d.getByLabel("Название профиля").fill("Разработка");
  await d.getByLabel("Идентификатор профиля").fill("engineers");
  await d.getByLabel("Разрешённые IPv4-подсети").fill("10.80.20.1/24");
  await d.getByRole("button", { name: "Создать профиль" }).click();
  await expect(d.getByRole("alert")).toContainText("сетевым адресом");
  expect(writes).toHaveLength(0);
  await d.getByLabel("Разрешённые IPv4-подсети").fill("10.80.20.0/24");
  await d.getByRole("button", { name: "Создать профиль" }).click();
  await expect(d).toHaveCount(0);
  expect(writes[0]).toEqual({
    action: "profile",
    body: {
      id: "engineers",
      name: "Разработка",
      networks: ["10.80.20.0/24"],
      revision: 4,
    },
  });
  await page
    .getByRole("button", { name: "Выдать доступ", exact: true })
    .click();
  d = page.getByRole("dialog");
  await d.getByLabel("Имя сотрудника").fill("Борис Котов");
  await d.getByLabel("Идентификатор OIDC (sub)").fill("id-54");
  await d.getByRole("button", { name: "Выдать доступ" }).click();
  await expect(d).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Открыть доступ: Борис Котов" }),
  ).toBeVisible();
  expect(writes[1]).toEqual({
    action: "grant",
    body: {
      subject: "id-54",
      display_name: "Борис Котов",
      profile_id: "engineers",
      expires_at: "",
      revision: 5,
    },
  });
});

test("Конфликт при отзыве требует повторной проверки, а закрытый API не показывает предыдущие данные", async ({
  page,
}) => {
  const { writes, flags } = await portal(page);
  await page.goto(pageURL);
  await page.getByRole("button", { name: "Отозвать доступ" }).click();
  const d = page.getByRole("dialog");
  flags.conflict = true;
  await d.getByRole("button", { name: "Отозвать доступ" }).click();
  await expect(d.getByRole("alert")).toContainText("Данные изменились");
  await d.getByRole("button", { name: "Загрузить актуальные данные" }).click();
  await expect(d).toHaveCount(0);
  expect(writes).toHaveLength(1);
  await expect(
    page.getByRole("button", { name: "Изменить доступ" }),
  ).toBeVisible();
  flags.forbidden = true;
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Недостаточно прав");
  await expect(
    page.getByRole("button", { name: "Отозвать доступ" }),
  ).toHaveCount(0);
  await expect(page.getByText("Анна Смирнова", { exact: true })).toHaveCount(0);
});

test("Сотрудник PL не загружает административный экран VPN и список назначений", async ({
  page,
}) => {
  const { flags, writes } = await portal(page, example(), false);
  await page.goto(pageURL);
  await expect(page.locator(".pl-ui-main")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Доступ сотрудников" }),
  ).toHaveCount(0);
  expect(flags.reads).toBe(0);
  expect(writes).toHaveLength(0);
});

test("Рабочие области PL сохраняют таблицы и управление с клавиатуры в обеих темах", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await portal(page);
  await page.goto(pageURL);
  for (const [width, height, theme] of [
    [1920, 1200, "light"],
    [2560, 1080, "dark"],
    [3440, 1440, "light"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate((mode) => window.PLTheme.set(mode), theme);
    const tab = page.getByRole("link", { name: "Сети и профили", exact: true });
    await tab.press("Enter");
    await expect(tab).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("heading", { name: "Матрица доступа" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page
      .getByRole("button", { name: "Изменить профиль", exact: true })
      .press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "Изменить профиль",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    const employees = page.getByRole("link", {
      name: "Сотрудники",
      exact: true,
    });
    await employees.click();
    await expect(employees).toHaveAttribute("aria-current", "page");
  }
  expect(errors).toEqual([]);
});

test("Чистый шлюз сам подставляет адреса и выдаёт комплект выбранному сотруднику PL", async ({
  page,
}, info) => {
  const initial = example();
  initial.gateway.ready = false;
  initial.gateway.auth_mode = "";
  initial.grants = [];
  initial.sessions = [];
  const { state, writes } = await portal(page, initial);
  const initialSetup = { ...gatewaySetup(), public_host: "192.168.10.4" };
  const { flags, updates } = await setupAPI(page, state, initialSetup);
  const employee = {
    id: "local:4b70b341-fad4-4ec1-85c9-b46ed94ff295",
    name: "Анна Смирнова",
    username: "anna",
  };
  await page.route("**/api/v1/local-users", (route) =>
    route.fulfill({
      json: {
        items: [
          employee,
          { ...employee, id: "disabled", name: "Отключён", disabled: true },
          { ...employee, id: "local-admin", builtin: true },
        ],
      },
    }),
  );
  await page.goto(pageURL);
  await page.getByRole("button", { name: "Настроить шлюз" }).click();
  const d = page.getByRole("dialog", { name: "Шлюз VPN" });
  await expect(d.getByLabel("Внешний адрес VPN")).toHaveValue(flags.publicIP);
  await expect(d.getByLabel("Локальный IPv4")).toHaveValue("192.168.10.4");
  await expect(d.getByLabel("Пул адресов VPN")).toHaveValue("10.77.0.0/24");
  await d.getByLabel("Внешний адрес VPN").fill("vpn.example.test");
  await d.getByLabel("Внешний порт").fill("443");
  const beforeRefresh = flags.discoveries;
  await d.getByRole("button", { name: "Определить заново" }).click();
  await expect.poll(() => flags.discoveries).toBeGreaterThan(beforeRefresh);
  await expect(d.getByLabel("Внешний адрес VPN")).toHaveValue(
    "vpn.example.test",
  );
  await d.screenshot({ path: info.outputPath("gateway-address.png") });
  await d.getByRole("button", { name: "Далее" }).click();
  await expect(d.getByLabel("Способ входа")).toHaveValue("certificate");
  await expect(d.getByLabel("Адрес Dex (issuer)")).toHaveCount(0);
  await d.getByRole("button", { name: "Далее" }).click();
  await expect(d.getByText("Выпустит PL", { exact: true })).toBeVisible();
  await d.getByRole("button", { name: "Применить", exact: true }).click();
  await expect(d.getByText("Настройки применены.")).toBeVisible();
  expect(updates).toEqual([
    {
      revision: "setup-1",
      auth_mode: "certificate",
      name: "Корпоративный VPN",
      public_host: "vpn.example.test",
      public_port: 443,
      bind_address: "192.168.10.4",
      port: 4443,
      pool: "10.77.0.0/24",
    },
  ]);
  await d.getByRole("button", { name: "Готово" }).click();
  await page
    .getByRole("button", { name: "Выдать доступ", exact: true })
    .click();
  const form = page.getByRole("dialog");
  await expect(form.getByRole("option", { name: "Отключён" })).toHaveCount(0);
  await form.getByLabel("Сотрудник PL").selectOption(employee.id);
  await form.getByRole("button", { name: "Выдать доступ" }).click();
  await expect(form).toHaveCount(0);
  expect(writes).toEqual([
    {
      action: "grant",
      body: {
        subject: employee.id,
        display_name: employee.name,
        profile_id: profile.id,
        expires_at: "",
        revision: 4,
      },
    },
  ]);
  await expect(
    page.getByRole("status").filter({ hasText: "Профиль OpenConnect готов" }),
  ).toBeVisible();
  const download = page.getByRole("link", {
    name: "Скачать профиль OpenConnect",
  });
  await expect(download).toHaveAttribute(
    "href",
    "/api/v1" +
      path +
      "client-profile?subject=" +
      encodeURIComponent(employee.id),
  );
  await page.route("**/client-profile?*", (route) =>
    route.fulfill({
      headers: {
        "content-disposition": 'attachment; filename="pl-vpn-employee.zip"',
        "content-type": "application/zip",
      },
      body: "browser-fixture",
    }),
  );
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    download.click(),
  ]);
  expect(file.suggestedFilename()).toBe("pl-vpn-employee.zip");
  await page.getByText("Как подключиться", { exact: true }).click();
  await expect(
    page.getByText("openconnect.exe --config pl-vpn.conf", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Отозвать доступ" }).click();
  await form.getByRole("button", { name: "Отозвать доступ" }).click();
  await expect(download).toHaveCount(0);
});

test("Внешний Dex принимает PEM, сохраняет черновик при ошибке и не раскрывает секрет", async ({
  page,
}) => {
  const { state } = await portal(page);
  const { flags, updates } = await setupAPI(page, state);
  flags.publicIP = "";
  await page.goto(pageURL);
  await page.getByRole("button", { name: "Шлюз", exact: true }).click();
  const d = page.getByRole("dialog", { name: "Шлюз VPN" });
  await expect(d.getByRole("status")).toContainText("определить не удалось");
  await d.getByLabel("Внешний адрес VPN").fill("vpn.example.test");
  await d.getByRole("button", { name: "Далее" }).click();
  await d.getByLabel("Способ входа").selectOption("oidc");
  await expect(
    d.getByText("https://vpn.example.test:4443/sso/callback", { exact: true }),
  ).toBeVisible();
  await d
    .getByLabel("Адрес Dex (issuer)")
    .fill("https://login.example.test/dex");
  await d.getByLabel("Идентификатор клиента Dex").fill("vpn-client");
  await d.getByLabel("Секрет клиента Dex").fill("browser-fixture-secret");
  const upload = (file: string) => ({
    name: file,
    mimeType: "application/x-pem-file",
    buffer: Buffer.from("fixture-" + file),
  });
  await d
    .getByLabel("Сертификат шлюза", { exact: true })
    .setInputFiles(upload("test.crt"));
  await d.getByRole("button", { name: "Далее" }).click();
  await expect(d.getByRole("alert")).toContainText("закрытый ключ");
  await d.getByLabel("Закрытый ключ шлюза").setInputFiles(upload("test.key"));
  await d
    .getByLabel("Сертификат CA для Dex")
    .setInputFiles(upload("test-ca.pem"));
  await d.getByRole("button", { name: "Далее" }).click();
  await expect(d).not.toContainText("browser-fixture-secret");
  flags.reject = true;
  await d.getByRole("button", { name: "Применить" }).click();
  await expect(d.getByRole("alert")).toContainText(
    "Сертификат не соответствует ключу",
  );
  await d.getByRole("button", { name: "Назад" }).click();
  await expect(d.getByLabel("Секрет клиента Dex")).toHaveValue(
    "browser-fixture-secret",
  );
  await d.getByRole("button", { name: "Далее" }).click();
  await d.getByRole("button", { name: "Применить" }).click();
  await expect(d.getByText("Настройки применены.")).toBeVisible();
  expect(updates[1]).toMatchObject({
    auth_mode: "oidc",
    cert_pem: "fixture-test.crt",
    key_pem: "fixture-test.key",
    idp_ca_pem: "fixture-test-ca.pem",
    client_secret: "browser-fixture-secret",
  });
  await d.getByRole("button", { name: "Изменить настройки" }).click();
  await d.getByRole("button", { name: "Далее" }).click();
  await expect(d.getByLabel("Секрет клиента Dex")).toHaveValue("");
  await expect(d.getByLabel("Закрытый ключ шлюза")).toHaveValue("");
  await d.getByRole("button", { name: "Далее" }).click();
  await d.getByRole("button", { name: "Применить" }).click();
  await expect(d.getByText("Настройки применены.")).toBeVisible();
  for (const field of ["client_secret", "cert_pem", "key_pem", "idp_ca_pem"])
    expect(updates[2]).not.toHaveProperty(field);
  expect(
    await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])),
  ).not.toContain("browser-fixture-secret");
});

test("Конфликт настроек шлюза требует перечитать версию и повторно проверить адрес", async ({
  page,
}) => {
  const { state } = await portal(page);
  const { flags, updates } = await setupAPI(page, state, gatewaySetup(true));
  await page.goto(pageURL);
  await page.getByRole("button", { name: "Шлюз", exact: true }).click();
  const d = page.getByRole("dialog", { name: "Шлюз VPN" });
  await d.getByRole("button", { name: "Изменить настройки" }).click();
  await d.getByRole("button", { name: "Далее" }).click();
  await d.getByLabel("Секрет клиента Dex").fill("stale-fixture-secret");
  await d.getByRole("button", { name: "Далее" }).click();
  flags.conflict = true;
  await d.getByRole("button", { name: "Применить" }).click();
  await expect(d.getByRole("alert")).toContainText(
    "Настройки шлюза изменились",
  );
  await expect(d.getByRole("button", { name: "Применить" })).toHaveCount(0);
  await d
    .getByRole("button", { name: "Загрузить действующие настройки" })
    .click();
  await expect(d.getByLabel("Внешний адрес VPN")).toHaveValue(
    "vpn2.example.test",
  );
  await d.getByLabel("Внешний порт").fill("443");
  await d.getByRole("button", { name: "Далее" }).click();
  await expect(d.getByLabel("Секрет клиента Dex")).toHaveValue("");
  await expect(
    d.getByText("https://vpn2.example.test/sso/callback", { exact: true }),
  ).toBeVisible();
  await d.getByLabel("Удалить сохранённый секрет").check();
  await d.getByLabel("Использовать только системные CA").check();
  await d.getByRole("button", { name: "Далее" }).click();
  await d.getByRole("button", { name: "Применить" }).click();
  await expect(d.getByText("Настройки применены.")).toBeVisible();
  expect(updates[1]).toMatchObject({
    revision: "changed-by-operator",
    idp_ca_pem: "",
    client_secret: "",
  });
});

test("Профиль сотрудника скачивается из его сессии и скрывается при отзыве", async ({
  page,
}) => {
  const { flags } = await portal(page, example(), false);
  let available = true;
  await page.route("**/me/vpn-profile/status", (route) =>
    route.fulfill({ json: { available } }),
  );
  await page.goto("/");
  const download = page.getByRole("link", {
    name: "Скачать профиль OpenConnect",
  });
  await expect(download).toHaveAttribute("href", "/api/v1/me/vpn-profile");
  await page.route("**/me/vpn-profile", (route) => {
    expect(new URL(route.request().url()).search).toBe("");
    return route.fulfill({
      headers: {
        "content-disposition": 'attachment; filename="pl-vpn.conf"',
        "content-type": "application/octet-stream",
      },
      body: "protocol=anyconnect",
    });
  });
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    download.click(),
  ]);
  expect(file.suggestedFilename()).toBe("pl-vpn.conf");
  available = false;
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Куда перейдём?" }),
  ).toBeVisible();
  await expect(download).toHaveCount(0);
  expect(flags.reads).toBe(0);
});

test("Ручной CA сохраняет выдачу по CN, просроченный доступ исключает скачивание", async ({
  page,
}) => {
  const { state } = await portal(page);
  await page.goto(pageURL);
  const download = page.getByRole("link", {
    name: "Скачать профиль OpenConnect",
  });
  await expect(
    page.getByRole("heading", { name: "Карточка доступа" }),
  ).toBeVisible();
  await expect(download).toHaveCount(0);
  await page
    .getByRole("button", { name: "Выдать доступ", exact: true })
    .click();
  const d = page.getByRole("dialog");
  await expect(d.getByLabel("Имя в сертификате (CN)")).toBeVisible();
  await d.getByRole("button", { name: "Отмена" }).click();
  state.gateway.auth_mode = "oidc";
  state.grants[0].expires_at = "2020-01-01T00:00:00Z";
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(page.locator(".vpn-gateway-summary")).toContainText(
    "Внешний Dex",
  );
  await expect(download).toHaveCount(0);
});

test("Пустой каталог PL даёт переход к созданию сотрудника", async ({
  page,
}) => {
  const initial = example();
  initial.gateway.managed_certificates = true;
  await portal(page, initial);
  await page.route("**/api/v1/local-users", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.goto(pageURL);
  await page
    .getByRole("button", { name: "Выдать доступ", exact: true })
    .click();
  const d = page.getByRole("dialog");
  await expect(
    d.getByRole("link", { name: "Локальные пользователи" }),
  ).toHaveAttribute("href", "#settings?section=users");
  await expect(d.getByRole("button", { name: "Выдать доступ" })).toBeDisabled();
});
