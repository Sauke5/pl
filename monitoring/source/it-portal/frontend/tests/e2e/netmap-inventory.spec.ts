import { expect, test, type Page } from "@playwright/test";

const instanceID = "a3333333-3333-4333-8333-333333333333";
const profileID = "b3333333-3333-4333-8333-333333333333";
const targetID = "c3333333-3333-4333-8333-333333333333";
const base = `/modules/${instanceID}/netmap`;
const hostFingerprint = "SHA256:fixturePublicHostFingerprint";
const knownHosts = "192.0.2.10 ssh-ed25519 fixture-public-host-key";
type Write = {
  method: string;
  path: string;
  body: Record<string, unknown>;
  idempotency: string;
};

async function fixture(
  page: Page,
  { guided = true, emptyProfiles = false } = {},
) {
  const writes: Write[] = [];
  const profiles: Record<string, unknown>[] = [
    {
      id: profileID,
      name: "Коммутаторы офиса",
      kind: "network",
      username: "inventory-reader",
      port: 22,
      driver: "huawei_vrp",
      auth_method: "password",
      password_set: true,
      ssh_known_hosts_set: true,
    },
  ];
  if (emptyProfiles) profiles.length = 0;
  const targets: Record<string, unknown>[] = [];
  const jobs: Record<string, unknown>[] = [];
  let testFails = false;
  let probeFails = false;
  let enrollFails = false;
  let finishJob = false;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const method = request.method();
    if (method !== "GET") {
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(request.headers()["x-csrf-token"]).toBe("inventory-csrf");
      const idempotency = request.headers()["idempotency-key"];
      expect(idempotency).toMatch(/^[a-f0-9-]{36}$/);
      writes.push({ method, path, body, idempotency });
      if (path === base + "/inventory/ssh-host-key") {
        return probeFails
          ? route.fulfill({ status: 422, json: { error: "inventory_timeout" } })
          : route.fulfill({
              json: {
                algorithm: "ssh-ed25519",
                fingerprint: hostFingerprint,
                known_hosts: knownHosts,
              },
            });
      }
      if (path === base + "/inventory/enroll") {
        if (enrollFails) return route.abort("failed");
        const profile = body.profile as Record<string, unknown> | undefined;
        const id = body.profile_id || "d3333333-3333-4333-8333-333333333333";
        if (profile)
          profiles.push({
            id,
            name: body.address,
            kind: profile.kind,
            username: profile.username,
            driver: profile.driver,
            port: profile.port,
          });
        targets.push({
          id: targetID,
          profile_id: id,
          name: body.name || body.address,
          kind: body.kind,
          address: body.address,
          network_id: body.network_id,
          interval_minutes: body.interval_minutes,
        });
        jobs.unshift({
          id: "job-1",
          target_id: targetID,
          target_name: body.name || body.address,
          state: "queued",
          created_at: "2026-11-06T18:00:00Z",
        });
        return route.fulfill({
          status: 202,
          json: {
            target_id: targetID,
            profile_id: id,
            job_id: "job-1",
            state: "queued",
          },
        });
      }
      if (path === base + "/inventory/profiles") {
        const id =
          (body.id as string) || "d3333333-3333-4333-8333-333333333333";
        const current = profiles.find((profile) => profile.id === id);
        const {
          password,
          private_key,
          passphrase,
          enable_password,
          ssh_known_hosts,
          ca_pem,
          ...safe
        } = body;
        const result = {
          ...current,
          ...safe,
          id,
          password_set: !!password || current?.password_set,
          private_key_set: !!private_key || current?.private_key_set,
          passphrase_set: !!passphrase || current?.passphrase_set,
          enable_password_set:
            !!enable_password || current?.enable_password_set,
          ssh_known_hosts_set:
            !!ssh_known_hosts || current?.ssh_known_hosts_set,
          ca_pem_set: !!ca_pem || current?.ca_pem_set,
        };
        if (current) Object.assign(current, result);
        else profiles.push(result);
        return route.fulfill({ json: result });
      }
      if (path === base + "/inventory/targets") {
        targets.push({ ...body, id: targetID });
        return route.fulfill({ json: targets[0] });
      }
      if (path === base + "/inventory/targets/" + targetID + "/collect") {
        jobs.unshift({
          id: "job-1",
          target_id: targetID,
          target_name: "Коммутатор этажа",
          state: "queued",
          created_at: "2026-11-06T18:00:00Z",
        });
        return route.fulfill({ status: 202, json: jobs[0] });
      }
      if (path === base + "/inventory/profiles/" + profileID + "/test") {
        return testFails
          ? route.fulfill({
              status: 422,
              json: { error: "inventory_auth_failed" },
            })
          : route.fulfill({
              json: {
                state: "succeeded",
                summary: {
                  hostname: "office-switch",
                  interfaces: 24,
                  addresses: 2,
                },
                warnings: [],
              },
            });
      }
      return route.fulfill({
        status: 404,
        json: { error: "unexpected_inventory_write" },
      });
    }
    if (path === base + "/inventory/capabilities")
      return guided
        ? route.fulfill({
            json: {
              guided_enrollment: true,
              ssh_host_key: true,
              drivers: [
                "auto",
                "openwrt",
                "mikrotik_routeros",
                "keenetic",
                "tplink_jetstream",
                "huawei_vrp",
                "cisco_ios",
                "junos",
              ],
            },
          })
        : route.fulfill({
            status: 400,
            json: { error: "netmap_invalid_request" },
          });
    if (path === base + "/inventory/profiles")
      return route.fulfill({ json: { items: profiles } });
    if (path === base + "/inventory/targets")
      return route.fulfill({ json: { items: targets } });
    if (path === base + "/inventory/jobs") {
      if (finishJob && jobs.length)
        Object.assign(jobs[0], {
          state: "partial",
          started_at: "2026-11-06T18:00:01Z",
          finished_at: "2026-11-06T18:00:03Z",
          result: {
            summary: {
              hostname: "office-switch",
              manufacturer: "Huawei",
              model: "S5735",
              os_name: "VRP",
              interfaces: 24,
              addresses: 2,
              neighbors: 4,
            },
            sync: {
              object_type: "device",
              object_id: 18,
              created: 26,
              updated: 0,
              unchanged: 0,
              conflicts: 1,
              errors: 0,
            },
            warnings: ["netbox_conflict"],
          },
        });
      return route.fulfill({ json: { items: jobs } });
    }
    if (path === base + "/networks")
      return route.fulfill({
        json: {
          items: [
            {
              id: "0123456789abcdef",
              name: "Офис",
              cidr: "192.0.2.0/24",
              profile: "legacy",
            },
          ],
          capabilities: { inventory: 1 },
        },
      });
    if ([base + "/profiles", base + "/polls"].includes(path))
      return route.fulfill({ json: { items: [] } });
    const module = {
      id: instanceID,
      module_id: "netmap",
      name: "Карта офиса",
      mode: "local",
      desired_state: "enabled",
      observed_state: "running",
      version: "1.0.0",
      revision: 1,
    };
    const responses: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "admin", name: "Admin", admin: true },
        csrf_token: "inventory-csrf",
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
    profiles,
    targets,
    failTest(value: boolean) {
      testFails = value;
    },
    failProbe(value: boolean) {
      probeFails = value;
    },
    failEnroll(value: boolean) {
      enrollFails = value;
    },
    finishJob() {
      finishJob = true;
    },
  };
}

async function open(page: Page) {
  await page.goto(`/#modules?instance=${instanceID}&view=netmap`);
  await expect(
    page.getByRole("heading", { name: "Устройства", exact: true }),
  ).toBeVisible();
}

async function openProfiles(page: Page) {
  await page
    .getByRole("button", { name: "Доступ и конфигурации", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Профили для опроса", exact: true }),
  ).toBeVisible();
}

test("first device checks a public SSH key before sending credentials, retries safely and opens the map", async ({
  page,
}, testInfo) => {
  const state = await fixture(page, { emptyProfiles: true });
  await open(page);
  const add = page.getByRole("button", {
    name: "Добавить устройство",
    exact: true,
  });
  await expect(add).toBeEnabled();
  await expect(
    page.getByRole("heading", { name: "Профили для опроса", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "История проверок", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => window.PLTheme?.set("night"));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
  await page.locator(".netmap-page").screenshot({
    path: testInfo.outputPath("netmap-devices-night.png"),
    animations: "disabled",
  });
  await add.click();

  const dialog = page.getByRole("dialog", { name: "Добавить устройство" });
  await expect(dialog.getByLabel("Система оборудования")).toHaveValue("auto");
  for (const label of [
    "OpenWrt / FriendlyWrt",
    "MikroTik RouterOS",
    "Keenetic",
    "TP-Link JetStream (управляемые коммутаторы)",
  ])
    await expect(
      dialog
        .getByLabel("Система оборудования")
        .locator("option")
        .filter({ hasText: label }),
    ).toHaveCount(1);
  await expect(
    dialog.getByLabel(/known_hosts|Доверенные SSH-ключи/),
  ).toHaveCount(0);
  await dialog.getByLabel("IP-адрес", { exact: true }).fill("192.0.2.10");
  await dialog
    .getByLabel("Пользователь", { exact: true })
    .fill("router-reader");
  await dialog
    .getByLabel("Пароль", { exact: true })
    .fill("fixture-password-not-live");
  await dialog.screenshot({
    path: testInfo.outputPath("netmap-access-night.png"),
    animations: "disabled",
  });

  state.failProbe(true);
  const readFingerprint = dialog.getByRole("button", {
    name: "Получить отпечаток",
    exact: true,
  });
  await readFingerprint.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Устройство не ответило",
  );
  await expect(dialog.getByLabel("Пользователь", { exact: true })).toHaveValue(
    "router-reader",
  );
  expect(state.writes[0]).toMatchObject({
    path: base + "/inventory/ssh-host-key",
    body: { address: "192.0.2.10", port: 22 },
  });
  expect(Object.keys(state.writes[0].body).sort()).toEqual(["address", "port"]);

  state.failProbe(false);
  await readFingerprint.click();
  await expect(
    dialog.getByText(hostFingerprint, { exact: true }),
  ).toBeVisible();
  expect(state.writes.map((write) => write.path)).toEqual(
    Array(2).fill(base + "/inventory/ssh-host-key"),
  );
  expect(Object.keys(state.writes[1].body).sort()).toEqual(["address", "port"]);
  const enroll = dialog.getByRole("button", {
    name: "Добавить и опросить",
    exact: true,
  });
  await expect(enroll).toBeDisabled();
  await dialog.screenshot({
    path: testInfo.outputPath("netmap-fingerprint-night.png"),
    animations: "disabled",
  });
  await dialog
    .getByRole("checkbox", { name: "Отпечаток совпадает с ключом устройства" })
    .check();
  state.failEnroll(true);
  await enroll.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Не удалось связаться с NetMap",
  );
  expect(state.writes[2].path).toBe(base + "/inventory/enroll");
  state.failEnroll(false);
  await enroll.click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes[3].idempotency).toBe(state.writes[2].idempotency);
  expect(state.writes[3].body).toEqual({
    address: "192.0.2.10",
    kind: "network",
    interval_minutes: 0,
    profile: {
      kind: "network",
      username: "router-reader",
      port: 22,
      driver: "auto",
      auth_method: "password",
      password: "fixture-password-not-live",
      ssh_known_hosts: knownHosts,
    },
  });
  await expect(page.getByText("В очереди", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "На карте", exact: true }),
  ).toHaveCount(0);
  state.finishJob();
  await expect(page.getByText("office-switch", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "На карте", exact: true }),
  ).toHaveAttribute("href", "/netmap/?device=device%3A18");
  await page.locator(".netmap-page").screenshot({
    path: testInfo.outputPath("netmap-device-reported-night.png"),
    animations: "disabled",
  });
  expect(state.writes).toHaveLength(4);
});

test("an older module keeps manual device setup available", async ({
  page,
}) => {
  const state = await fixture(page, { guided: false });
  await open(page);
  await expect(
    page.getByText("Мастер добавления доступен после обновления NetMap."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Добавить вручную", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Название", { exact: true }).fill("Коммутатор");
  await dialog.getByLabel("IP-адрес", { exact: true }).fill("192.0.2.10");
  await dialog
    .getByRole("button", { name: "Сохранить устройство", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes.map((write) => write.path)).toEqual([
    base + "/inventory/targets",
  ]);
  await expect(
    page.getByRole("button", { name: "Опросить", exact: true }),
  ).toBeEnabled();
});

test("saved inventory profile is a summary; editing keeps stored credentials and trust", async ({
  page,
}) => {
  const state = await fixture(page);
  await open(page);
  await openProfiles(page);
  await expect(
    page
      .locator(".netmap-inventory")
      .getByText("Коммутаторы офиса", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".netmap-inventory input")).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
  await page
    .getByRole("button", {
      name: "Изменить профиль Коммутаторы офиса",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Пароль", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("Доверенные SSH-ключи устройств")).toHaveValue(
    "",
  );
  await dialog
    .getByLabel("Название", { exact: true })
    .fill("Коммутаторы второго этажа");
  await dialog
    .getByRole("button", { name: "Сохранить профиль", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const write = state.writes[0];
  expect(write.path).toBe(base + "/inventory/profiles");
  expect(write.body).toMatchObject({
    id: profileID,
    name: "Коммутаторы второго этажа",
    auth_method: "password",
    driver: "huawei_vrp",
    port: 22,
  });
  for (const key of [
    "password",
    "private_key",
    "passphrase",
    "enable_password",
    "ssh_known_hosts",
    "ca_pem",
  ])
    expect(write.body).not.toHaveProperty(key);
  await expect(
    page
      .locator(".netmap-inventory")
      .getByText("Коммутаторы второго этажа", { exact: true }),
  ).toBeVisible();
});

test("inventory target uses an explicit per-device profile and schedule, then shows actual partial result", async ({
  page,
}) => {
  const state = await fixture(page);
  await open(page);
  await page
    .getByRole("button", { name: "Добавить устройство", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("IP-адрес", { exact: true }).fill("192.0.2.10");
  await dialog.getByLabel("Данные входа").selectOption(profileID);
  await dialog.getByText("Дополнительные настройки", { exact: true }).click();
  await dialog.getByLabel("Название в списке").fill("Коммутатор этажа");
  await dialog
    .getByLabel("Связать с опрошенной сетью")
    .selectOption("0123456789abcdef");
  await dialog.getByLabel("Когда обновлять сведения").selectOption("15");
  await dialog
    .getByRole("button", { name: "Добавить и опросить", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes[0].body).toMatchObject({
    kind: "network",
    profile_id: profileID,
    address: "192.0.2.10",
    network_id: "0123456789abcdef",
    interval_minutes: 15,
  });
  expect(state.writes[0].body).not.toHaveProperty("id");
  expect(state.writes[0].body).not.toHaveProperty("profile");
  expect(state.writes[0].path).toBe(base + "/inventory/enroll");
  await expect(
    page
      .locator(".netmap-inventory")
      .getByText("Каждые 15 мин", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".netmap-inventory").getByText("В очереди", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Сбор выполняется", exact: true }),
  ).toBeDisabled();
  state.finishJob();
  await expect(
    page
      .locator(".netmap-inventory")
      .getByText("Обновлено частично", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Результат", exact: true }).click();
  await expect(dialog).toContainText("office-switch");
  await expect(dialog).toContainText("24 / 2");
  await expect(dialog).toContainText("26 / 0");
  await expect(dialog).toContainText("Наблюдения о соседях");
  await expect(dialog).toContainText(
    "Проверьте привязку устройства и ручные изменения",
  );
  await expect(
    dialog.getByRole("link", { name: "Открыть NetBox" }),
  ).toHaveAttribute("href", "/netmap/netbox/");
  expect(state.writes).toHaveLength(1);
});

test("profile test translates failure, preserves entered address, and reads preview without a NetBox write", async ({
  page,
}) => {
  const state = await fixture(page);
  state.failTest(true);
  await open(page);
  await openProfiles(page);
  await page
    .getByRole("button", { name: "Проверить доступ", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("IP-адрес устройства").fill("192.0.2.10");
  await dialog
    .getByRole("button", { name: "Проверить доступ", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Устройство отклонило доступ",
  );
  await expect(dialog.getByLabel("IP-адрес устройства")).toHaveValue(
    "192.0.2.10",
  );
  await expect(dialog).not.toContainText("inventory_auth_failed");
  state.failTest(false);
  await dialog
    .getByRole("button", { name: "Проверить доступ", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText(
    "Доступ подтверждён · office-switch · интерфейсов: 24",
  );
  expect(state.writes.map((write) => write.path)).toEqual(
    Array(2).fill(base + "/inventory/profiles/" + profileID + "/test"),
  );
});

test("Windows profile defaults to verified HTTPS and keeps the editor within themed desktop viewport", async ({
  page,
}, testInfo) => {
  const state = await fixture(page);
  await open(page);
  await openProfiles(page);
  await page
    .locator(".netmap-inventory")
    .getByRole("button", { name: "Добавить профиль", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Что опрашиваем").selectOption("windows");
  await dialog.getByLabel("Название", { exact: true }).fill("Серверы Windows");
  await dialog.getByLabel("Пользователь", { exact: true }).fill("LAB\\reader");
  await dialog
    .getByLabel("Пароль", { exact: true })
    .fill("fixture-password-not-live");
  await expect(dialog.getByLabel("Порт", { exact: true })).toHaveValue("5986");
  await expect(dialog.getByLabel("Соединение WinRM")).toHaveValue("https");
  await expect(dialog.getByLabel("Доверенные SSH-ключи устройств")).toHaveCount(
    0,
  );
  for (const theme of ["dark", "light", "night"]) {
    await page.evaluate((value) => {
      window.PLTheme?.set(value);
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1920);
    expect(box.y + box.height).toBeLessThanOrEqual(1080);
    await page.screenshot({
      path: testInfo.outputPath("inventory-windows-" + theme + ".png"),
    });
  }
  await dialog
    .getByRole("button", { name: "Сохранить профиль", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes[0].body).toMatchObject({
    kind: "windows",
    scheme: "https",
    transport: "ntlm",
    port: 5986,
    username: "LAB\\reader",
  });
  for (const key of ["driver", "auth_method", "ssh_known_hosts", "private_key"])
    expect(state.writes[0].body).not.toHaveProperty(key);
});

test("replacing an encrypted SSH key can explicitly clear its passphrase", async ({
  page,
}) => {
  const state = await fixture(page);
  Object.assign(state.profiles[0], {
    auth_method: "key",
    password_set: false,
    private_key_set: true,
    passphrase_set: true,
  });
  await open(page);
  await openProfiles(page);
  await page
    .getByRole("button", {
      name: "Изменить профиль Коммутаторы офиса",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Ключ больше не защищён паролем", { exact: true })
    .check();
  await expect(
    dialog.getByLabel("Пароль ключа, если задан", { exact: false }),
  ).toBeDisabled();
  await expect(
    dialog.getByLabel("Закрытый ключ SSH", { exact: false }),
  ).toBeEnabled();
  await dialog
    .getByLabel("Закрытый ключ SSH", { exact: false })
    .fill("fixture-unencrypted-private-key");
  await dialog
    .getByRole("button", { name: "Сохранить профиль", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes[0].body).toMatchObject({
    auth_method: "key",
    private_key: "fixture-unencrypted-private-key",
    clear_secrets: ["passphrase"],
  });
  expect(state.writes[0].body).not.toHaveProperty("password");
  expect(state.writes[0].body).not.toHaveProperty("passphrase");
});
