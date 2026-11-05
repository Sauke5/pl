import { expect, test, type Page } from "@playwright/test";

const instanceID = "a2222222-2222-4222-8222-222222222222";
const password = "K7m2Xp4Q";
const jobID = "b3333333-3333-4333-8333-333333333333";
type Installation = {
  status: "running" | "succeeded" | "failed";
  marker?: boolean;
  failedService?: string;
};

async function fixture(
  page: Page,
  kind: "netmap" | "bookstack" | "grafana" = "bookstack",
  rejected = false,
  installation?: Installation,
  nativePassword = password,
) {
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (path === `/modules/${instanceID}/initial-login`) {
      expect(request.method()).toBe("POST");
      expect(request.headers()["x-csrf-token"]).toBe("initial-login-csrf");
      const body = request.postDataJSON() as Record<string, unknown>;
      requests.push(body);
      if (rejected || installation?.failedService === body.service)
        return route.fulfill({
          status: 409,
          json: { message: "Первоначальные данные входа недоступны" },
        });
      const service = String(body.service);
      const paths: Record<string, string> = {
        bookstack: "/wiki/login",
        grafana: "/grafana/login",
        netbox: "/netmap/netbox/login/",
        gitea: "/netmap/gitea/user/login",
      };
      return route.fulfill({
        json: {
          instance_id: instanceID,
          module_id: kind,
          service,
          username:
            service === "bookstack"
              ? "admin@pl.invalid"
              : service === "grafana"
                ? "admin"
                : "pl-admin",
          password: service === "grafana" ? "admin" : nativePassword,
          path: paths[service],
        },
      });
    }
    const responses: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "admin", name: "Admin", admin: true },
        csrf_token: "initial-login-csrf",
        features: {},
      },
      "/modules": {
        items: [
          {
            id: instanceID,
            module_id: kind,
            name: kind === "bookstack" ? "Wiki" : "Сеть",
            mode: "local",
            desired_state: "enabled",
            observed_state:
              installation?.status === "running" ? "pending" : "running",
            version: "1.0.0",
            last_job_id: installation ? jobID : undefined,
          },
        ],
      },
      "/modules/catalog": {
        local_available: true,
        items: [
          {
            id: kind,
            name: kind === "bookstack" ? "Wiki" : "NetMap",
            modes: ["local"],
            view: kind === "bookstack" ? "nativeapp" : "netmap",
          },
        ],
      },
      "/help-state": { disabled: true, seen: [] },
      ["/jobs/" + jobID]: {
        id: jobID,
        status: installation?.status || "succeeded",
        parameters: { action: "install" },
        created_at: "2026-10-30T03:00:00Z",
        finished_at:
          installation?.status === "running"
            ? undefined
            : "2026-10-30T03:00:01Z",
      },
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
  const route = new URLSearchParams({ instance: instanceID });
  if (installation && installation.marker !== false) route.set("setup", jobID);
  await page.goto("/#modules?" + route.toString());
  await expect(page.locator("#module-" + instanceID)).toBeVisible();
  return requests;
}

async function mockClipboard(page: Page, rejected = false) {
  const install = (fail: boolean) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          if (fail)
            throw new DOMException("Clipboard denied", "NotAllowedError");
          (window as unknown as { copiedLogin: string }).copiedLogin = value;
        },
      },
    });
  };
  await page.addInitScript(install, rejected);
  await page.evaluate(install, rejected);
}

async function copiedValue(page: Page) {
  return page.evaluate(
    () => (window as unknown as { copiedLogin?: string }).copiedLogin,
  );
}

async function storedValues(page: Page) {
  return page.evaluate(() =>
    JSON.stringify([
      Object.entries(localStorage),
      Object.entries(sessionStorage),
    ]),
  );
}

test("Wiki has two clickable fields, cursor feedback and a real new-tab link", async ({
  page,
  context,
}, testInfo) => {
  await context.route("**/wiki/login", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Wiki login</h1>" }),
  );
  const requests = await fixture(page);
  await mockClipboard(page);
  expect(requests).toHaveLength(0);
  await page
    .getByRole("button", { name: "Первоначальный вход", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Первый вход", exact: true });
  const username = dialog.getByRole("button", { name: "Логин", exact: true });
  const secret = dialog.getByRole("button", { name: "Пароль", exact: true });
  await expect(username).toHaveText("admin@pl.invalid");
  await expect(secret).toHaveText("••••••••");
  expect(requests).toEqual([{ service: "bookstack" }]);
  // Capture both fields in one frame while the dialog's opening animation runs.
  const [loginBox, secretBox] = await dialog
    .locator(".initial-login-value")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const { x, y, width } = element.getBoundingClientRect();
        return { x, y, width };
      }),
    );
  expect(Math.abs(loginBox.y - secretBox.y)).toBeLessThan(2);
  expect(secretBox.x).toBeGreaterThan(loginBox.x + loginBox.width);
  await expect(
    dialog.getByRole("button", { name: /Копировать|Показать пароль/ }),
  ).toHaveCount(0);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await dialog.screenshot({
      path: testInfo.outputPath("first-login-" + theme + ".png"),
    });
  }
  await username.evaluate((element) =>
    element.addEventListener(
      "click",
      (event) => {
        const pointer = event as MouseEvent;
        (
          window as unknown as { copyPoint: { x: number; y: number } }
        ).copyPoint = { x: pointer.clientX, y: pointer.clientY };
      },
      { once: true },
    ),
  );
  await username.click({ position: { x: 12, y: 12 } });
  expect(await copiedValue(page)).toBe("admin@pl.invalid");
  const feedback = dialog.getByRole("status");
  await expect(feedback).toHaveText("Скопировано");
  const point = await page.evaluate(
    () =>
      (window as unknown as { copyPoint: { x: number; y: number } }).copyPoint,
  );
  const feedbackBox = (await feedback.boundingBox())!;
  expect(Math.abs(feedbackBox.x - point.x)).toBeLessThan(3);
  expect(Math.abs(feedbackBox.y - (point.y + 18))).toBeLessThan(3);
  await secret.click({ position: { x: secretBox.width - 12, y: 12 } });
  await expect(secret).toHaveText(password);
  expect(await copiedValue(page)).toBe(password);
  const link = dialog.getByRole("link", { name: "Открыть Wiki", exact: true });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  const originalURL = page.url();
  const [opened] = await Promise.all([
    context.waitForEvent("page"),
    link.click(),
  ]);
  await expect(opened).toHaveURL(/\/wiki\/login$/);
  await expect(
    opened.getByRole("heading", { name: "Wiki login" }),
  ).toBeVisible();
  expect(page.url()).toBe(originalURL);
  await opened.close();
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Первоначальный вход", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Пароль", exact: true }),
  ).toHaveText("••••••••");
  expect(await storedValues(page)).not.toContain(password);
});

test("NetMap uses service tabs and displays the selected service failure", async ({
  page,
}) => {
  const requests = await fixture(page, "netmap", true);
  await page
    .getByRole("button", { name: "Первоначальный вход", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("tab", { name: "NetBox", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    dialog.getByRole("tab", { name: "Gitea", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText(
    "Первоначальные данные входа недоступны",
  );
  await expect(
    dialog.getByRole("button", { name: "Пароль", exact: true }),
  ).toHaveCount(0);
  expect(requests).toEqual(
    expect.arrayContaining([{ service: "netbox" }, { service: "gitea" }]),
  );
});

test("successful installation opens once and service switching masks the password", async ({
  page,
}) => {
  await mockClipboard(page);
  const requests = await fixture(page, "netmap", false, {
    status: "succeeded",
  });
  const dialog = page.getByRole("dialog", { name: "Первый вход", exact: true });
  await expect(dialog).toBeVisible();
  for (const service of ["NetBox", "Gitea"]) {
    await dialog.getByRole("tab", { name: service, exact: true }).click();
    const secret = dialog.getByRole("button", { name: "Пароль", exact: true });
    await expect(
      dialog.getByRole("button", { name: "Логин", exact: true }),
    ).toHaveText("pl-admin");
    await expect(secret).toHaveText("••••••••");
    await secret.click();
    await expect(secret).toHaveText(password);
    expect(await copiedValue(page)).toBe(password);
    await expect(
      dialog.getByRole("link", { name: "Открыть " + service, exact: true }),
    ).toHaveAttribute("target", "_blank");
  }
  expect(requests).toHaveLength(2);
  await expect(page).not.toHaveURL(/setup=/);
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  const count = requests.length;
  await page.reload();
  await expect(page.locator(".module-job")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(requests).toHaveLength(count);
  expect(await storedValues(page)).not.toContain(password);
});

test("historical Grafana never auto-opens and fields also copy with the keyboard", async ({
  page,
}) => {
  await mockClipboard(page);
  const requests = await fixture(page, "grafana", false, {
    status: "succeeded",
    marker: false,
  });
  await expect(page.locator(".module-job")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(requests).toEqual([]);
  await page
    .getByRole("button", { name: "Первоначальный вход", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const username = dialog.getByRole("button", { name: "Логин", exact: true });
  const secret = dialog.getByRole("button", { name: "Пароль", exact: true });
  await expect(username).toHaveText("admin");
  await expect(secret).toHaveText("••••••••");
  await username.focus();
  await username.press("Enter");
  expect(await copiedValue(page)).toBe("admin");
  await secret.focus();
  await secret.press("Space");
  await expect(secret).toHaveText("admin");
  expect(await copiedValue(page)).toBe("admin");
  await expect(dialog.getByRole("status")).toHaveText("Скопировано");
  await expect(
    dialog.getByRole("link", { name: "Открыть Grafana" }),
  ).toHaveAttribute("href", "/grafana/login");
  expect(requests).toEqual([{ service: "grafana" }]);
});

test("first-login hint waits for actual installation success", async ({
  page,
}) => {
  const installation: Installation = { status: "running" };
  const requests = await fixture(page, "bookstack", false, installation);
  await expect(page.locator(".module-job")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Первоначальный вход", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(requests).toEqual([]);
  installation.status = "succeeded";
  const dialog = page.getByRole("dialog", { name: "Первый вход", exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Пароль", exact: true }),
  ).toHaveText("••••••••");
  await expect(
    dialog.getByRole("button", { name: "Логин", exact: true }),
  ).toHaveText("admin@pl.invalid");
  expect(requests).toEqual([{ service: "bookstack" }]);
});

test("a failed service retries without discarding the other login", async ({
  page,
}) => {
  const installation: Installation = {
    status: "succeeded",
    failedService: "gitea",
  };
  const requests = await fixture(page, "netmap", false, installation);
  const dialog = page.getByRole("dialog", { name: "Первый вход", exact: true });
  const secret = dialog.getByRole("button", { name: "Пароль", exact: true });
  await expect(secret).toHaveText("••••••••");
  const netbox = dialog.getByRole("tab", { name: "NetBox", exact: true });
  await netbox.focus();
  await netbox.press("ArrowRight");
  await expect(
    dialog.getByRole("tab", { name: "Gitea", exact: true }),
  ).toBeFocused();
  await expect(dialog.getByRole("alert")).toContainText(
    "Первоначальные данные входа недоступны",
  );
  installation.failedService = undefined;
  await dialog
    .getByRole("button", { name: "Повторить получение данных" })
    .click();
  await expect(secret).toHaveText("••••••••");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog
    .getByRole("tab", { name: "Gitea", exact: true })
    .press("ArrowLeft");
  await expect(netbox).toBeFocused();
  await expect(secret).toHaveText("••••••••");
  expect(
    requests.filter((request) => request.service === "netbox"),
  ).toHaveLength(1);
});

test("legacy passwords are copied in full and clipboard denial is visible", async ({
  page,
}) => {
  const legacy = "a".repeat(64);
  await mockClipboard(page, true);
  await fixture(page, "bookstack", false, undefined, legacy);
  await page
    .getByRole("button", { name: "Первоначальный вход", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const secret = dialog.getByRole("button", { name: "Пароль", exact: true });
  await expect(secret).toHaveText("••••••••");
  await secret.click();
  await expect(secret).toHaveText(legacy);
  await expect(page.getByRole("alert")).toContainText("Не удалось скопировать");
  await expect(dialog.getByText("Скопировано", { exact: true })).toHaveCount(0);
  await mockClipboard(page);
  await secret.click();
  expect(await copiedValue(page)).toBe(legacy);
  await expect(dialog.getByRole("status")).toHaveText("Скопировано");
  expect(await storedValues(page)).not.toContain(legacy);
});
