import { expect, test, type Page } from "@playwright/test";
import type { VPNState } from "../../src/ocserv";

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
    await tab.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Матрица доступа" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page
      .getByRole("button", { name: "Изменить профиль", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "Изменить профиль",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByRole("link", { name: "Сотрудники", exact: true }).click();
  }
  expect(errors).toEqual([]);
});
