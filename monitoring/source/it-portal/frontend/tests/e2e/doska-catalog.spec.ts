import { test, expect } from "@playwright/test";

const resourceId = "11111111-1111-4111-8111-111111111111";
for (const theme of ["dark", "light"]) {
  test(`catalog permalink and Doska backrefs ${theme}`, async ({ page }) => {
    await page.addInitScript(
      (theme) => localStorage.setItem("pl-ui-theme", theme),
      theme,
    );
    const resource = {
      id: resourceId,
      revision: 1,
      name: "Сервис документов",
      description: "Рабочие документы",
      type: "Web-сервис",
      lifecycle: "active",
      icon: "wiki",
      url: "/wiki/",
      directions: [],
      aliases: [],
      tags: [],
      relations: [],
      external_ids: [],
      endpoints: [],
      links: [],
      operations: [],
      check: {},
    };
    await page.clock.install();
    let inventorySources: Record<string, unknown>[] = [
      {
        candidate_id: "c",
        integration_id: "i",
        kind: "netbox",
        inventory: { kind: "device", addresses: [] },
      },
    ];
    let denied = false;
    const reads: Record<string, unknown>[] = [];
    let resourceReads = 0;
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(
        "/api/v1",
        "",
      );
      if (path === `/resources/${resourceId}`) resourceReads++;
      const data: Record<string, unknown> = {
        "/session": {
          authenticated: true,
          features: { doska: true },
          user: { id: "catalog-admin", name: "Администратор", admin: true },
          csrf_token: "fixture",
        },
        "/resources": [resource],
        [`/resources/${resourceId}`]: resource,
        [`/resources/${resourceId}/inventory`]: { sources: inventorySources },
        "/dashboard-layout": { revision: 0, tiles: [], hidden: [] },
        "/preferences": {
          revision: 1,
          favorites: [],
          hidden_sections: [],
          section_order: [],
        },
        "/dictionaries": {
          types: [],
          directions: [],
          sites: [],
          environments: [],
        },
        "/help-state": { disabled: true, seen: [] },
        "/chart-settings": { revision: 1, charts: [] },
      };
      await route.fulfill({ json: data[path] ?? [] });
    });
    await page.route("**/doska/api/doska/catalog/task-links", async (route) => {
      const request = route.request();
      expect(request.method()).toBe("POST");
      expect(request.headers()["x-csrf-token"]).toBe("fixture");
      expect(request.headers()["idempotency-key"]).toBeUndefined();
      reads.push(request.postDataJSON());
      if (denied)
        return route.fulfill({
          status: 404,
          json: { error: { code: "unavailable" } },
        });
      const second = request.postDataJSON().cursor === "next-page";
      await route.fulfill({
        json: {
          version: 1,
          items: [
            {
              projectId: "p",
              taskId: second ? "t2" : "t1",
              title: second ? "Вторая задача" : "Проверить сервис",
              href: `/doska/projects/p?taskId=${second ? "t2" : "t1"}`,
            },
          ],
          nextCursor: second ? null : "next-page",
        },
      });
    });
    await page.goto(`/#catalog?resourceId=${resourceId}`);
    const drawer = page.getByRole("dialog");
    await expect(
      drawer.getByRole("heading", { name: "Сервис документов", exact: true }),
    ).toBeVisible();
    await expect(
      drawer.locator("[data-system-icon='wiki']").first(),
    ).toBeVisible();
    const tasks = drawer.getByRole("region", { name: "Задачи Doska" });
    await expect(
      tasks.getByRole("link", { name: "Проверить сервис" }),
    ).toHaveAttribute("href", "/doska/projects/p?taskId=t1");
    await expect(
      tasks.getByRole("link", { name: "Создать задачу" }),
    ).toHaveAttribute(
      "href",
      `/doska/projects?resourceId=${resourceId}&sourceKind=platform`,
    );
    expect(resourceReads).toBeGreaterThan(0);
    expect(reads[0]).toEqual({
      selection: { resourceId, sourceKind: "platform" },
      limit: 20,
      cursor: null,
    });
    await tasks.getByRole("button", { name: "Следующие задачи" }).click();
    await expect(
      tasks.getByRole("link", { name: "Вторая задача" }),
    ).toBeVisible();
    await expect(
      tasks.getByRole("link", { name: "Проверить сервис" }),
    ).toHaveCount(0);
    await tasks.getByRole("button", { name: "К началу" }).click();
    await expect(
      tasks.getByRole("link", { name: "Проверить сервис" }),
    ).toBeVisible();
    await tasks
      .getByRole("combobox", { name: "Объект связи" })
      .selectOption("netbox");
    await expect(
      tasks.getByRole("link", { name: "Создать задачу" }),
    ).toHaveAttribute(
      "href",
      `/doska/projects?resourceId=${resourceId}&sourceKind=netbox`,
    );
    inventorySources = [];
    await page.clock.fastForward(61000);
    await expect(
      tasks.getByRole("combobox", { name: "Объект связи" }),
    ).toHaveCount(0);
    await expect(
      tasks.getByRole("link", { name: "Создать задачу" }),
    ).toHaveAttribute(
      "href",
      `/doska/projects?resourceId=${resourceId}&sourceKind=platform`,
    );
    await drawer.screenshot({
      path: test.info().outputPath(`catalog-doska-${theme}.png`),
    });
    denied = true;
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    // Reopening owns a fresh query: a revoked resource must not show cached tasks.
    await page.keyboard.press("Escape");
    await page.goto(`/#catalog?resourceId=${resourceId}`);
    await expect(tasks.getByText("Связи с задачами недоступны.")).toBeVisible();
    await expect(
      tasks.getByRole("link", { name: "Проверить сервис" }),
    ).toHaveCount(0);
    await expect(
      tasks.getByRole("button", { name: "Повторить" }),
    ).toBeVisible();
  });
}

test("employee permalink never loads the admin resource API", async ({
  page,
}) => {
  let adminReads = 0;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path.startsWith("/resources")) adminReads++;
    await route.fulfill({
      json:
        path === "/session"
          ? {
              authenticated: true,
              features: { doska: true },
              user: { id: "employee", name: "Сотрудник", admin: false },
              csrf_token: "fixture",
            }
          : path === "/board"
            ? { title: "Сервисы", items: [] }
            : [],
    });
  });
  await page.goto(`/#catalog?resourceId=${resourceId}`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Создать задачу" })).toHaveCount(
    0,
  );
  expect(adminReads).toBe(0);
});
