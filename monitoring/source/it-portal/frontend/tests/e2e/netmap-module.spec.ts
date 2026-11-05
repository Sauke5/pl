import { expect, test, type Page } from "@playwright/test";

const instanceID = "a2222222-2222-4222-8222-222222222222";
const networkID = "0123456789abcdef";
const base = `/modules/${instanceID}/netmap`;
type Write = { path: string; body: Record<string, unknown> };
type Network = { id: string; name: string; cidr: string; profile: string };
type Poll = {
  id: string;
  network: string;
  state: string;
  error?: string;
  result?: Record<string, unknown>;
};

async function fixture(
  page: Page,
  options: {
    disabled?: boolean;
    existing?: boolean;
    failCreate?: boolean;
    failPoll?: boolean;
    unknownPoll?: boolean;
    missingSNMP?: boolean;
    alternateProfile?: boolean;
    failImport?: boolean;
  } = {},
) {
  const writes: Write[] = [];
  const reads: string[] = [];
  const networks: Network[] = options.existing
    ? [
        {
          id: networkID,
          name: "Лаборатория",
          cidr: "192.0.2.0/30",
          profile: "lab",
        },
      ]
    : [];
  const profiles = [
    {
      id: "lab",
      username: "collector",
      password_set: true,
      snmp_community_set: !options.missingSNMP,
      ssh_known_hosts_set: true,
      oxidized_model: "ios",
    },
  ];
  if (options.alternateProfile)
    profiles.push({ ...profiles[0], id: "office", snmp_community_set: true });
  const polls: Poll[] = options.unknownPoll
    ? [{ id: "unknown-job", network: networkID, state: "unrecognized" }]
    : [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (request.method() !== "GET") {
      expect(request.headers()["x-csrf-token"]).toBe("netmap-fixture-csrf");
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path, body });
      if (path === base + "/profiles") {
        const current = profiles.find((profile) => profile.id === body.id);
        const safe = {
          id: String(body.id),
          username: String(body.username || ""),
          oxidized_model: String(body.oxidized_model || ""),
          password_set: body.password ? true : !!current?.password_set,
          snmp_community_set: body.snmp_community
            ? true
            : !!current?.snmp_community_set,
          ssh_known_hosts_set: body.ssh_known_hosts
            ? true
            : !!current?.ssh_known_hosts_set,
        };
        if (current) Object.assign(current, safe);
        else profiles.push(safe);
        return route.fulfill({ json: { id: body.id } });
      }
      if (path === base + "/networks") {
        if (options.failCreate)
          return route.fulfill({
            status: 502,
            json: {
              error: "network_unconfirmed",
              message: "Не удалось сохранить сеть",
            },
          });
        const value = {
          id: networkID,
          name: String(body.name),
          cidr: String(body.cidr),
          profile: String(body.profile),
        };
        const existing = networks.find((network) => network.id === networkID);
        if (existing) Object.assign(existing, value);
        else networks.push(value);
        return route.fulfill({ json: { id: networkID, cidr: body.cidr } });
      }
      if (path === base + `/networks/${networkID}/poll`) {
        if (options.failPoll)
          return route.fulfill({
            status: 502,
            json: {
              error: "poll_unconfirmed",
              message: "Запуск проверки не подтверждён",
            },
          });
        polls.unshift({ id: "poll-1", network: networkID, state: "running" });
        return route.fulfill({ json: { id: "poll-1", state: "running" } });
      }
      if (path === base + `/networks/${networkID}/remove`) {
        networks.splice(0);
        return route.fulfill({ json: { removed: true } });
      }
      if (path === base + `/networks/${networkID}/observations`) {
        if (options.failImport)
          return route.fulfill({
            status: 400,
            json: {
              error: "invalid_observations",
              message: "Адрес вне выбранной сети",
            },
          });
        return route.fulfill({
          json: {
            accepted: (body.records as unknown[]).length,
            source: body.source,
          },
        });
      }
      return route.fulfill({
        status: 404,
        json: { error: "unexpected_mutation" },
      });
    }
    reads.push(path);
    if (path === base + "/networks")
      return route.fulfill({ json: { items: networks } });
    if (path === base + "/profiles")
      return route.fulfill({ json: { items: profiles } });
    if (path === base + "/polls")
      return route.fulfill({ json: { items: polls } });
    const module = {
      id: instanceID,
      module_id: "netmap",
      name: "Сеть лаборатории",
      mode: "local",
      desired_state: options.disabled ? "disabled" : "enabled",
      observed_state: options.disabled ? "disabled" : "running",
      revision: 1,
      version: "1.0.0",
    };
    const responses: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "admin", name: "Admin", admin: true },
        csrf_token: "netmap-fixture-csrf",
        features: {},
        local_users_enabled: true,
      },
      "/modules": { items: [module] },
      "/modules/catalog": {
        local_available: true,
        items: [
          { id: "netmap", name: "NetMap", modes: ["local"], view: "netmap" },
        ],
      },
      "/help-state": { disabled: true, seen: [] },
      "/preferences": {
        favorites: [],
        hidden_sections: [],
        section_order: [],
        home_widgets: [],
      },
      "/chart-settings": { revision: 1, charts: [] },
    };
    return route.fulfill({ json: responses[path] ?? [] });
  });
  return {
    writes,
    reads,
    completePoll(overrides: Record<string, unknown> = {}) {
      polls[0] = {
        id: "poll-1",
        network: networkID,
        state: "complete",
        result: {
          targets_total: 2,
          responders: 1,
          unresponsive: 1,
          devices: 1,
          observed_hosts: 0,
          interfaces_created: 4,
          interfaces_updated: 0,
          manual_conflicts: 0,
          errors: 0,
          ...overrides,
        },
      };
    },
    failPollResult() {
      polls[0] = {
        id: "failed-poll",
        network: networkID,
        state: "error",
        error: "Проверка завершилась с ошибкой",
        result: {
          targets_total: 2,
          responders: 1,
          interfaces_created: 2,
          errors: 1,
        },
      };
    },
  };
}

async function open(page: Page) {
  await page.goto(`/#modules?instance=${instanceID}&view=netmap`);
  await expect(
    page.getByRole("heading", { name: "NetMap", level: 1 }),
  ).toBeVisible();
}

test("NetMap creates a selected network without an automatic poll, then shows the actual asynchronous result", async ({
  page,
}, testInfo) => {
  const state = await fixture(page);
  await open(page);
  await expect(
    page.getByRole("link", { name: "Открыть карту", exact: true }),
  ).toHaveAttribute("href", "/netmap/");
  await expect(
    page.getByRole("link", { name: "NetBox", exact: true }),
  ).toHaveAttribute("href", "/netmap/netbox/");
  await expect(
    page.getByRole("link", { name: "Oxidized", exact: true }),
  ).toHaveAttribute("href", "/netmap/oxidized/");
  await expect(
    page.getByRole("link", { name: "Gitea", exact: true }),
  ).toHaveAttribute("href", "/netmap/gitea/");
  await expect(page.getByLabel("CIDR", { exact: false })).toHaveValue("");
  expect(state.writes).toHaveLength(0);
  await page.getByLabel("Название сети", { exact: true }).fill("Тестовая сеть");
  await page.getByLabel("CIDR", { exact: false }).fill("192.0.2.0/30");
  await page
    .getByRole("combobox", { name: "Профиль доступа", exact: true })
    .selectOption("lab");
  await page
    .getByRole("button", { name: "Добавить сеть", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Сеть сохранена." }),
  ).toBeVisible();
  expect(state.writes).toEqual([
    {
      path: base + "/networks",
      body: { cidr: "192.0.2.0/30", name: "Тестовая сеть", profile: "lab" },
    },
  ]);
  await expect(
    page.getByRole("link", { name: "На карте", exact: true }),
  ).toHaveAttribute("href", `/netmap/?scope=network-${networkID}`);
  await page
    .getByRole("button", { name: "Запустить проверку", exact: true })
    .click();
  await expect(page.getByText("Выполняется", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Запустить проверку", exact: true }),
  ).toBeDisabled();
  const jobs = page.locator(".netmap-poll-row");
  await expect(jobs.locator(".netmap-poll-value")).toHaveText([
    "—",
    "—",
    "—",
    "—",
    "—",
    "—",
    "—",
    "—",
    "—",
  ]);
  expect(state.writes[1]).toEqual({
    path: base + `/networks/${networkID}/poll`,
    body: {},
  });
  state.completePoll();
  await page
    .getByRole("button", { name: "Обновить данные", exact: true })
    .click();
  await expect(page.getByText("Завершена", { exact: true })).toBeVisible();
  await expect(jobs.locator(".netmap-poll-value")).toHaveText([
    "2",
    "1",
    "1",
    "1",
    "0",
    "4",
    "0",
    "0",
    "0",
  ]);
  const columns = page.locator(".netmap-settings-grid > .panel");
  const left = (await columns.nth(0).boundingBox())!;
  const right = (await columns.nth(1).boundingBox())!;
  expect(Math.abs(left.y - right.y)).toBeLessThan(2);
  expect(right.x).toBeGreaterThan(left.x + left.width);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.screenshot({
      path: testInfo.outputPath("netmap-" + theme + ".png"),
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Удалить сеть", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Инвентаризация NetBox и история конфигураций сохранятся.",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Удалить", exact: true })
    .click();
  await expect(
    page.getByText("Сетей пока нет. Добавьте первую сеть для инвентаризации."),
  ).toBeVisible();
  expect(state.writes[2]).toEqual({
    path: base + `/networks/${networkID}/remove`,
    body: {},
  });
});

test("collector secrets are write-only and blank edit values are omitted", async ({
  page,
}) => {
  const state = await fixture(page);
  await open(page);
  await page.getByLabel("ID профиля", { exact: false }).fill("lab-two");
  await page
    .getByLabel("SNMP community", { exact: false })
    .fill("fixture-community");
  await page.getByLabel("Логин SSH", { exact: true }).fill("collector-two");
  await page
    .getByLabel("Пароль SSH", { exact: false })
    .fill("fixture-password");
  await page.getByLabel("Модель Oxidized", { exact: false }).fill("ios");
  const knownHosts =
    "192.0.2.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  await page
    .getByLabel("SSH host keys (known_hosts)", { exact: false })
    .fill(knownHosts);
  await page
    .getByRole("button", { name: "Сохранить профиль", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Профиль сохранён." }),
  ).toBeVisible();
  await expect(page.getByLabel("SNMP community", { exact: false })).toHaveValue(
    "",
  );
  await expect(page.getByLabel("Пароль SSH", { exact: false })).toHaveValue("");
  await expect(
    page.getByLabel("SSH host keys (known_hosts)", { exact: false }),
  ).toHaveValue("");
  expect(state.writes[0]).toEqual({
    path: base + "/profiles",
    body: {
      id: "lab-two",
      username: "collector-two",
      oxidized_model: "ios",
      snmp_community: "fixture-community",
      password: "fixture-password",
      ssh_known_hosts: knownHosts,
    },
  });
  await page
    .getByRole("combobox", { name: "Профиль", exact: true })
    .selectOption("lab");
  await expect(page.getByLabel("Логин SSH", { exact: true })).toHaveValue(
    "collector",
  );
  await expect(
    page.getByLabel("Модель Oxidized", { exact: false }),
  ).toHaveValue("ios");
  await expect(page.getByLabel("SNMP community", { exact: false })).toHaveValue(
    "",
  );
  await expect(page.getByLabel("Пароль SSH", { exact: false })).toHaveValue("");
  await page
    .getByRole("button", { name: "Сохранить профиль", exact: true })
    .click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]).toEqual({
    path: base + "/profiles",
    body: { id: "lab", username: "collector", oxidized_model: "ios" },
  });
});

test("failed network save preserves the entered draft and does not start discovery", async ({
  page,
}) => {
  const state = await fixture(page, { failCreate: true });
  await open(page);
  await page
    .getByLabel("Название сети", { exact: true })
    .fill("Несохранённая сеть");
  await page.getByLabel("CIDR", { exact: false }).fill("192.0.2.0/30");
  await page
    .getByRole("combobox", { name: "Профиль доступа", exact: true })
    .selectOption("lab");
  await page
    .getByRole("button", { name: "Добавить сеть", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Не удалось сохранить сеть",
  );
  await expect(page.getByLabel("Название сети", { exact: true })).toHaveValue(
    "Несохранённая сеть",
  );
  await expect(page.getByLabel("CIDR", { exact: false })).toHaveValue(
    "192.0.2.0/30",
  );
  expect(state.writes).toHaveLength(1);
});

test("unknown poll status and a rejected start are never shown as successful results", async ({
  page,
}) => {
  const state = await fixture(page, {
    existing: true,
    failPoll: true,
    unknownPoll: true,
  });
  await open(page);
  await expect(
    page.getByText("Состояние неизвестно", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".netmap-poll-value")).toHaveText([
    "—",
    "—",
    "—",
    "—",
    "—",
    "—",
    "—",
    "—",
    "—",
  ]);
  await page
    .getByRole("button", { name: "Запустить проверку", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Запуск проверки не подтверждён",
  );
  await expect(page.getByText("Завершена", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Проверка запущена. Результат появится в истории.", {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(state.writes).toEqual([
    { path: base + `/networks/${networkID}/poll`, body: {} },
  ]);
});

test("a disabled instance does not read settings or expose network actions", async ({
  page,
}) => {
  const state = await fixture(page, { disabled: true });
  await open(page);
  await expect(
    page.getByText("NetMap отключён", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Открыть карту", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Запустить проверку", exact: true }),
  ).toHaveCount(0);
  expect(state.reads.filter((path) => path.startsWith(base))).toEqual([]);
  expect(state.writes).toEqual([]);
});

test("a partial failed poll retains reported counters and leaves missing results unknown", async ({
  page,
}) => {
  const state = await fixture(page, { existing: true });
  await open(page);
  state.failPollResult();
  await page
    .getByRole("button", { name: "Обновить данные", exact: true })
    .click();
  await expect(page.getByText("Ошибка", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Проверка завершилась с ошибкой", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".netmap-poll-value")).toHaveText([
    "2",
    "1",
    "—",
    "—",
    "—",
    "2",
    "—",
    "—",
    "1",
  ]);
  await expect(page.getByText("Завершена", { exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test("a profile without SNMP allows basic discovery and optional enrichment", async ({
  page,
}) => {
  const state = await fixture(page, { existing: true, missingSNMP: true });
  await open(page);
  await expect(page.getByRole("note")).toContainText("SNMP необязателен");
  await expect(
    page.getByRole("button", { name: "Запустить проверку", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Настроить профиль", exact: true })
    .click();
  await expect(page.getByLabel("ID профиля", { exact: false })).toHaveValue(
    "lab",
  );
  await expect(page.getByLabel("ID профиля", { exact: false })).toBeFocused();
  expect(state.writes).toEqual([]);
  await page
    .getByLabel("SNMP community", { exact: false })
    .fill("fixture-community");
  await page
    .getByRole("button", { name: "Сохранить профиль", exact: true })
    .click();
  await expect(page.getByRole("note")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Запустить проверку", exact: true }),
  ).toBeEnabled();
  expect(state.writes.map((write) => write.path)).toEqual([base + "/profiles"]);
});

test("changing the network profile preserves identity and never starts a scan", async ({
  page,
}) => {
  const state = await fixture(page, {
    existing: true,
    missingSNMP: true,
    alternateProfile: true,
  });
  await open(page);
  const profile = page.getByRole("combobox", {
    name: "Профиль выбранной сети",
    exact: true,
  });
  await expect(profile).toHaveValue("lab");
  await profile.selectOption("office");
  expect(state.writes).toEqual([]);
  await page
    .getByRole("button", { name: "Применить профиль к сети", exact: true })
    .click();
  await expect(profile).toHaveValue("office");
  await expect(
    page
      .getByRole("combobox", { name: "Выбранная сеть", exact: true })
      .locator("option"),
  ).toHaveCount(1);
  await expect(
    page.getByRole("link", { name: "На карте", exact: true }),
  ).toHaveAttribute("href", `/netmap/?scope=network-${networkID}`);
  await expect(page.getByRole("note")).toHaveCount(0);
  expect(state.writes).toEqual([
    {
      path: base + "/networks",
      body: { cidr: "192.0.2.0/30", name: "Лаборатория", profile: "office" },
    },
  ]);
});

test("a network without a profile can be checked and separates observed addresses from NetBox", async ({
  page,
}) => {
  const state = await fixture(page);
  await open(page);
  await page.getByLabel("Название сети", { exact: true }).fill("Домашняя сеть");
  await page.getByLabel("CIDR", { exact: false }).fill("192.0.2.0/30");
  await expect(
    page.getByRole("combobox", { name: "Профиль доступа", exact: true }),
  ).toHaveValue("");
  await page
    .getByRole("button", { name: "Добавить сеть", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "На карте", exact: true }),
  ).toBeVisible();
  expect(state.writes[0]).toEqual({
    path: base + "/networks",
    body: { cidr: "192.0.2.0/30", name: "Домашняя сеть", profile: "" },
  });
  await page
    .getByRole("button", { name: "Запустить проверку", exact: true })
    .click();
  await expect(page.getByText("Выполняется", { exact: true })).toBeVisible();
  state.completePoll({
    devices: 0,
    observed_hosts: 1,
    warnings: ["icmp_unavailable"],
  });
  await page
    .getByRole("button", { name: "Обновить данные", exact: true })
    .click();
  await expect(page.getByText("Завершена", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "NetBox", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Адресов без SNMP", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".netmap-poll-value")).toHaveText([
    "2",
    "1",
    "1",
    "0",
    "1",
    "4",
    "0",
    "0",
    "0",
  ]);
  await expect(page.locator(".netmap-poll-warning")).toContainText(
    "ICMP недоступен",
  );
});

test("an existing network can switch from a profile to basic discovery", async ({
  page,
}) => {
  const state = await fixture(page, { existing: true });
  await open(page);
  await page
    .getByRole("combobox", { name: "Профиль выбранной сети", exact: true })
    .selectOption("");
  await page
    .getByRole("button", { name: "Применить профиль к сети", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Профиль выбранной сети", exact: true }),
  ).toHaveValue("");
  expect(state.writes).toEqual([
    {
      path: base + "/networks",
      body: { cidr: "192.0.2.0/30", name: "Лаборатория", profile: "" },
    },
  ]);
});

test("observation import sends only the selected source and records through the signed API", async ({
  page,
}) => {
  const state = await fixture(page, { existing: true });
  await open(page);
  await page.getByText("Импорт наблюдений", { exact: true }).click();
  await page
    .getByLabel("ID источника наблюдений", { exact: true })
    .fill("router.dhcp");
  const records = [
    {
      ip: "192.0.2.1",
      hostname: "mobile-client",
      methods: ["dhcp"],
      observed_at: "2026-11-04T20:00:00Z",
    },
  ];
  await page.getByLabel("Файл наблюдений", { exact: false }).setInputFiles({
    name: "observations.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ records })),
  });
  await page
    .getByRole("button", { name: "Импортировать наблюдения", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Наблюдения импортированы" }),
  ).toBeVisible();
  expect(state.writes).toEqual([
    {
      path: base + `/networks/${networkID}/observations`,
      body: { source: "router.dhcp", records },
    },
  ]);
  await expect(
    page.getByLabel("Файл наблюдений", { exact: false }),
  ).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Импортировать наблюдения", exact: true }),
  ).toBeDisabled();
});

test("invalid or oversized observation files fail before any request", async ({
  page,
}) => {
  const state = await fixture(page, { existing: true });
  await open(page);
  await page.getByText("Импорт наблюдений", { exact: true }).click();
  await page
    .getByLabel("ID источника наблюдений", { exact: true })
    .fill("router");
  const input = page.getByLabel("Файл наблюдений", { exact: false });
  const submit = page.getByRole("button", {
    name: "Импортировать наблюдения",
    exact: true,
  });
  for (const [content, message] of [
    ["invalid", "Не удалось прочитать JSON"],
    [JSON.stringify({ records: [null] }), "от 1 до 4096 наблюдений"],
    [" ".repeat(3 * 1024 * 1024 + 1), "не больше 3 MiB"],
  ]) {
    await input.setInputFiles({
      name: "invalid.json",
      mimeType: "application/json",
      buffer: Buffer.from(content),
    });
    await submit.click();
    await expect(
      page.locator(".netmap-observation-import [role=alert]"),
    ).toContainText(message);
  }
  expect(state.writes).toEqual([]);
});

test("a rejected observation import keeps its file and source for correction", async ({
  page,
}) => {
  const state = await fixture(page, { existing: true, failImport: true });
  await open(page);
  await page.getByText("Импорт наблюдений", { exact: true }).click();
  const source = page.getByLabel("ID источника наблюдений", { exact: true });
  const input = page.getByLabel("Файл наблюдений", { exact: false });
  await source.fill("router");
  await input.setInputFiles({
    name: "observations.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify([{ ip: "198.51.100.1", methods: ["arp"] }]),
    ),
  });
  await page
    .getByRole("button", { name: "Импортировать наблюдения", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Адрес вне выбранной сети",
  );
  await expect(source).toHaveValue("router");
  await expect(input).toHaveValue(/observations.json$/);
  expect(state.writes).toHaveLength(1);
});
