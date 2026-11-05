import { expect, test, type Page } from "@playwright/test";

const instanceID = "a4444444-4444-4444-8444-444444444444";
const integrationID = "b4444444-4444-4444-8444-444444444444";
const resourceID = "c4444444-4444-4444-8444-444444444444";
const initialJobID = "wiki-install-ready";
const instanceName = "Wiki лаборатории";
const originalEndpoint = "https://wiki.example.test:8443";
const replacementEndpoint = "https://replacement.example.test:9443";
const csrf = "wiki-connection-csrf";

type Write = { path: string; body: Record<string, unknown> };

async function fixture(
  page: Page,
  options: { catalog?: boolean; reconnectConflict?: boolean } = {},
) {
  const timestamp = new Date().toISOString();
  let installed = !options.catalog;
  let conflict = options.reconnectConflict === true;
  const instance = {
    id: instanceID,
    integration_id: integrationID,
    resource_id: resourceID,
    module_id: "bookstack",
    name: instanceName,
    mode: "external",
    endpoint: originalEndpoint,
    desired_state: "enabled",
    observed_state: "running",
    revision: 7,
    last_attempt: timestamp,
    last_success: timestamp,
    last_job_id: initialJobID,
  };
  const jobs: Record<string, unknown> = {
    [initialJobID]: {
      id: initialJobID,
      status: "succeeded",
      parameters: { action: "install" },
      created_at: timestamp,
      finished_at: timestamp,
    },
  };
  const writes: Write[] = [];
  const initialLogins: string[] = [];
  const externalRequests: string[] = [];
  const moduleRevisions: number[] = [];
  await page
    .context()
    .route(
      /^https?:\/\/[^/]+\.example\.test(?::\d+)?(?:\/|$)/,
      async (route) => {
        externalRequests.push(route.request().url());
        await route.abort();
      },
    );
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (path.endsWith("/initial-login")) {
      initialLogins.push(path);
      return route.fulfill({
        status: 503,
        json: { error: "unexpected_initial_login" },
      });
    }
    if (request.method() !== "GET") {
      expect(request.method()).toBe("POST");
      expect(request.headers()["x-csrf-token"]).toBe(csrf);
      const body = request.postDataJSON() as Write["body"];
      writes.push({ path, body });
      if (path === "/modules") {
        expect(body.module_id).toBe("bookstack");
        expect(body.mode).toBe("external");
        installed = true;
        instance.name = String(body.name);
        instance.endpoint = String(body.endpoint);
      } else if (path === `/modules/${instanceID}/actions`) {
        if (body.action === "reconnect") {
          expect(body.revision).toBe(instance.revision);
          if (conflict) {
            conflict = false;
            instance.revision++;
            return route.fulfill({
              status: 409,
              json: {
                error: "revision_conflict",
                message: "Подключение изменено другим администратором",
              },
            });
          }
          instance.endpoint = String(body.endpoint);
          instance.desired_state = "enabled";
          instance.observed_state = "running";
        } else if (body.action === "disable") {
          instance.desired_state = "disabled";
          instance.observed_state = "disabled";
        } else if (body.action === "remove") {
          expect(body.confirm_name).toBe(instance.name);
          installed = false;
          instance.desired_state = "removed";
          instance.observed_state = "absent";
        } else {
          return route.fulfill({
            status: 400,
            json: { error: "unexpected_action" },
          });
        }
      } else {
        return route.fulfill({
          status: 404,
          json: { error: "unexpected_mutation" },
        });
      }
      instance.revision++;
      const job = {
        id: `wiki-operation-${writes.length}`,
        status: "succeeded",
        parameters: { action: path === "/modules" ? "install" : body.action },
        created_at: timestamp,
        finished_at: timestamp,
      };
      instance.last_job_id = job.id;
      jobs[job.id] = job;
      return route.fulfill({
        status: 202,
        json: { instance: { ...instance }, job },
      });
    }
    if (path === "/modules") moduleRevisions.push(instance.revision);
    const responses: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "admin", name: "Admin", admin: true },
        csrf_token: csrf,
        features: {},
      },
      "/modules": { items: installed ? [{ ...instance }] : [] },
      "/modules/catalog": {
        local_available: false,
        managed_credentials_available: false,
        items: [
          {
            id: "bookstack",
            name: "Wiki",
            description: "BookStack с собственным входом",
            modes: ["external"],
            public_path: "/wiki/",
          },
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
    return route.fulfill({
      json: path.startsWith("/jobs/")
        ? (jobs[path.slice("/jobs/".length)] ?? {})
        : (responses[path] ?? []),
    });
  });
  return { writes, initialLogins, externalRequests, moduleRevisions, instance };
}

test("Wiki external catalog connects without a host controller or connector credentials", async ({
  page,
}) => {
  const state = await fixture(page, { catalog: true });
  await page.goto("/#module-catalog");
  await expect(
    page.getByRole("button", { name: "Установить на хост", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Подключить существующий", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Подключить Wiki",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "Название экземпляра", exact: true })
    .fill(instanceName);
  await dialog
    .getByRole("textbox", { name: /^Адрес Wiki/ })
    .fill(originalEndpoint);
  await expect(dialog.getByText(/APP_URL=/)).toContainText(
    `${new URL(page.url()).origin}/wiki`,
  );
  await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
  await expect(dialog.getByLabel(/секрет|API-ключ|пароль/i)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const card = page.locator(`#module-${instanceID}`);
  await expect(card).toBeVisible();
  await expect(card).toContainText(instanceName);
  await expect(
    card.getByRole("link", { name: "Открыть Wiki", exact: true }),
  ).toHaveAttribute("href", "/wiki/");
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({
    path: "/modules",
    body: {
      module_id: "bookstack",
      name: instanceName,
      mode: "external",
      endpoint: originalEndpoint,
      idempotency_key: expect.any(String),
    },
  });
  for (const field of ["secret_ref", "api_key", "password", "config"])
    expect(state.writes[0].body).not.toHaveProperty(field);
  expect(state.initialLogins).toEqual([]);
  expect(state.externalRequests).toEqual([]);
  expect(page.context().pages()).toHaveLength(1);
});

test("Wiki external reconnect preserves draft and identities after a revision conflict", async ({
  page,
}) => {
  const state = await fixture(page, { reconnectConflict: true });
  await page.goto("/#modules");
  const card = page.locator(`#module-${instanceID}`);
  await card.getByRole("button", { name: "Подробнее", exact: true }).click();
  const details = page.getByRole("dialog", { name: instanceName, exact: true });
  await details
    .getByRole("button", { name: "Изменить подключение", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Подключение Wiki",
    exact: true,
  });
  const endpoint = dialog.getByRole("textbox", { name: /^Адрес BookStack/ });
  await expect(endpoint).toHaveValue(originalEndpoint);
  await endpoint.fill(replacementEndpoint);
  const refreshed = page.waitForResponse(async (response) => {
    if (
      new URL(response.url()).pathname !== "/api/v1/modules" ||
      response.request().method() !== "GET"
    )
      return false;
    const data = await response.json();
    return data.items?.[0]?.revision === 8;
  });
  await dialog
    .getByRole("button", { name: "Сохранить и проверить", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Экземпляр уже изменён",
  );
  await refreshed;
  await expect(endpoint).toHaveValue(replacementEndpoint);
  await expect(card.locator(".module-card-endpoint")).toHaveText(
    originalEndpoint,
  );
  // The modal hides the background drawer from the accessibility tree. Inspect
  // its retained DOM here; interactive role locators are used again after close.
  const backgroundDetails = page.locator('.workspace-drawer[role="dialog"]');
  await expect(backgroundDetails).toHaveCount(1);
  await expect(backgroundDetails).toHaveAttribute("aria-hidden", "true");
  await expect(
    backgroundDetails.locator(".workspace-drawer-heading"),
  ).toContainText(instanceName);
  await expect(
    backgroundDetails.locator(
      `a[href="#settings?integration=${integrationID}"]`,
    ),
  ).toHaveCount(1);
  await expect(
    backgroundDetails.locator(`a[href="#catalog?resource=${resourceID}"]`),
  ).toHaveCount(1);
  expect(state.instance).toMatchObject({
    id: instanceID,
    integration_id: integrationID,
    resource_id: resourceID,
    name: instanceName,
    endpoint: originalEndpoint,
    mode: "external",
  });
  await dialog
    .getByRole("button", { name: "Сохранить и проверить", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(card.locator(".module-card-endpoint")).toHaveText(
    replacementEndpoint,
  );
  expect(state.writes.map(({ body }) => body)).toEqual([
    {
      action: "reconnect",
      endpoint: replacementEndpoint,
      revision: 7,
      idempotency_key: expect.any(String),
    },
    {
      action: "reconnect",
      endpoint: replacementEndpoint,
      revision: 8,
      idempotency_key: expect.any(String),
    },
  ]);
  expect(state.writes[1].body.idempotency_key).not.toBe(
    state.writes[0].body.idempotency_key,
  );
  await expect(
    details.getByRole("link", { name: "Интеграция", exact: true }),
  ).toHaveAttribute("href", `#settings?integration=${integrationID}`);
  await expect(
    details.getByRole("link", { name: "Ресурс в каталоге", exact: true }),
  ).toHaveAttribute("href", `#catalog?resource=${resourceID}`);
  expect(state.instance).toMatchObject({
    id: instanceID,
    integration_id: integrationID,
    resource_id: resourceID,
    name: instanceName,
    endpoint: replacementEndpoint,
    mode: "external",
  });
  expect(state.externalRequests).toEqual([]);
  expect(state.initialLogins).toEqual([]);
});

test("Wiki external lifecycle hides initial login and confirms named removal through the action menu", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(`/#modules?instance=${instanceID}&setup=${initialJobID}`);
  const card = page.locator(`#module-${instanceID}`);
  await expect(card).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Первоначальный вход", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Первый вход", exact: true }),
  ).toHaveCount(0);
  await expect(
    card.getByRole("link", { name: "Открыть Wiki", exact: true }),
  ).toHaveAttribute("href", "/wiki/");
  await card.getByRole("button", { name: "Подробнее", exact: true }).click();
  const details = page.getByRole("dialog", { name: instanceName, exact: true });
  await expect(
    details.getByRole("button", { name: "Первоначальный вход", exact: true }),
  ).toHaveCount(0);
  await expect(
    details.getByRole("link", { name: "Открыть Wiki", exact: true }),
  ).toHaveAttribute("href", "/wiki/");
  await details
    .getByRole("button", { name: "Закрыть панель", exact: true })
    .click();
  const menu = card.getByRole("button", {
    name: `Действия: ${instanceName}`,
    exact: true,
  });
  await menu.click();
  await card.getByRole("menuitem", { name: "Отключить", exact: true }).click();
  await expect(card.locator(".module-card-state")).toContainText("Отключён");
  await menu.click();
  await card.getByRole("menuitem", { name: "Удалить", exact: true }).click();
  const confirmation = page.getByRole("dialog", {
    name: `Удалить «${instanceName}»?`,
    exact: true,
  });
  await expect(confirmation).toContainText(
    "Внешний BookStack, его учётные записи, документы и вложения сохранятся на своём хосте",
  );
  const remove = confirmation.getByRole("button", {
    name: "Удалить полностью",
    exact: true,
  });
  const name = confirmation.getByLabel(`Введите название: ${instanceName}`, {
    exact: true,
  });
  await expect(remove).toBeDisabled();
  await name.fill(instanceName + " ");
  await expect(remove).toBeDisabled();
  expect(state.writes.map(({ body }) => body.action)).toEqual(["disable"]);
  await name.fill(instanceName);
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect(card).toHaveCount(0);
  expect(state.writes).toEqual([
    {
      path: `/modules/${instanceID}/actions`,
      body: { action: "disable", idempotency_key: expect.any(String) },
    },
    {
      path: `/modules/${instanceID}/actions`,
      body: {
        action: "remove",
        confirm_name: instanceName,
        idempotency_key: expect.any(String),
      },
    },
  ]);
  expect(state.initialLogins).toEqual([]);
  expect(state.externalRequests).toEqual([]);
  expect(page.context().pages()).toHaveLength(1);
  await expect(page).toHaveURL(/\/#modules\?/);
});
