import { expect, test } from "@playwright/test";

test("deployment settings protect drafts, confirm restart and persist server policy", async ({
  page,
}) => {
  let state = {
    core_api: 1,
    revision: 0,
    public_url: "https://pl.example.test",
    bind_address: "0.0.0.0",
    allowed_cidrs: ["10.20.0.0/16"],
    allowed_ports: [80, 443],
    custom_tls: false,
    outbound_ca_pem: "",
    operation: undefined as Record<string, unknown> | undefined,
  };
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (path === "/installation") {
      if (request.method() === "GET") return route.fulfill({ json: state });
      expect(request.method()).toBe("PUT");
      expect(request.headers()["x-csrf-token"]).toBe("installation-csrf");
      const body = request.postDataJSON();
      writes.push(body);
      state = {
        ...state,
        operation: {
          kind: "configuration",
          operation_id: body.operation_id,
          phase: "queued",
          next_url: body.public_url,
        },
      };
      return route.fulfill({ json: state });
    }
    const responses: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "local-admin", admin: true },
        csrf_token: "installation-csrf",
      },
      "/settings": { revision: 1, timezone: "UTC", stale_after_seconds: 180 },
      "/modules": { items: [] },
      "/preferences": { favorites: [], hidden_sections: [], section_order: [] },
      "/help-state": { disabled: true, seen: [] },
      "/wayline": { sources: [] },
    };
    return route.fulfill({ json: responses[path] ?? [] });
  });
  await page.goto("/#settings?section=installation");
  await expect(page.getByLabel(/^Адрес PL/)).toHaveValue(
    "https://pl.example.test",
  );
  await page.getByLabel(/^Разрешённые порты интеграций/).fill("80, 443, 9090");
  await page
    .getByRole("navigation", { name: "Разделы настроек" })
    .getByRole("button", { name: "Общие параметры", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Есть несохранённые изменения" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Остаться", exact: true }).click();
  await page
    .getByRole("button", { name: "Применить параметры", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Применить параметры установки?",
  });
  await expect(confirmation).toBeVisible();
  expect(writes).toHaveLength(0);
  await confirmation
    .getByRole("button", { name: "Проверить и применить", exact: true })
    .click();
  await expect(confirmation).toBeHidden();
  await expect(page.getByRole("status")).toContainText(
    "Применяем параметры установки",
  );
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    revision: 0,
    allowed_cidrs: ["10.20.0.0/16"],
    allowed_ports: [80, 443, 9090],
    outbound_ca_pem: "",
  });
  expect(writes[0]).not.toHaveProperty("tls_key_pem");
  state = {
    ...state,
    revision: 1,
    allowed_ports: [80, 443, 9090],
    operation: { ...state.operation, phase: "complete" },
  };
  await page.reload();
  await expect(page.getByRole("status")).toContainText("Параметры применены");
  await expect(page.getByLabel(/^Разрешённые порты интеграций/)).toHaveValue(
    "80, 443, 9090",
  );
  await expect(
    page.getByRole("button", { name: "Применить параметры", exact: true }),
  ).toBeDisabled();
});

test("accepted address change survives loss of the old origin and a page reload", async ({
  page,
}) => {
  let unavailable = false;
  const operationID = "4c90ec54-5fd0-442b-8857-d58a9a54fb1b";
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (unavailable) return route.abort("connectionrefused");
    if (path === "/installation") {
      const status = {
        core_api: 1,
        revision: 0,
        public_url: "https://pl.example.test",
        bind_address: "0.0.0.0",
        allowed_cidrs: ["127.0.0.1/32"],
        allowed_ports: [80, 443],
        custom_tls: false,
      };
      if (request.method() === "GET") return route.fulfill({ json: status });
      return route.fulfill({
        json: {
          ...status,
          operation: {
            kind: "configuration",
            operation_id: operationID,
            phase: "queued",
            next_url: "https://new-pl.example.test:8443",
          },
        },
      });
    }
    const responses: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "local-admin", admin: true },
        csrf_token: "transition-csrf",
      },
      "/settings": { revision: 1, timezone: "UTC", stale_after_seconds: 180 },
      "/modules": { items: [] },
      "/preferences": { favorites: [], hidden_sections: [], section_order: [] },
      "/help-state": { disabled: true, seen: [] },
      "/wayline": { sources: [] },
    };
    return route.fulfill({ json: responses[path] ?? [] });
  });
  await page.goto("/#settings?section=installation");
  await page.getByLabel(/^Адрес PL/).fill("https://new-pl.example.test:8443");
  await page
    .getByRole("button", { name: "Применить параметры", exact: true })
    .click();
  await page
    .getByRole("dialog", {
      name: "Применить параметры установки?",
      exact: true,
    })
    .getByRole("button", { name: "Проверить и применить", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", {
      name: "Применить параметры установки?",
      exact: true,
    }),
  ).toBeHidden();
  unavailable = true;
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Адрес PL изменяется", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: "https://new-pl.example.test:8443",
      exact: true,
    }),
  ).toHaveAttribute(
    "href",
    "https://new-pl.example.test:8443/#settings?section=installation",
  );
  await expect(page.getByText("Failed to fetch", { exact: true })).toHaveCount(
    0,
  );
});
