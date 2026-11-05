import { test, expect } from "@playwright/test";

// Management interfaces are applications; the physical host/VM records remain
// infrastructure even when the two kinds share the same work direction.
for (const [width, theme] of [
  [1920, "dark"],
  [1920, "light"],
] as const) {
  test(`management interfaces appear through catalog navigation ${width} ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 1920 ? 1080 : 1440 });
    await page.addInitScript(
      (theme) => localStorage.setItem("pl-ui-theme", theme),
      theme,
    );
    const base = {
      revision: 1,
      description: "",
      hostname: "",
      ip: "",
      aliases: [],
      tags: [],
      endpoints: [],
      links: [],
      relations: [],
      external_ids: [],
      operations: [],
      check: { kind: "", target: "", interval_seconds: 0 },
      source: "manual",
      lifecycle: "active",
    };
    const resources = [
      {
        ...base,
        id: "vm",
        name: "Inventory VM",
        type: "Виртуальная машина",
        url: "",
        directions: ["Виртуализация"],
      },
      ...[
        ["203.0.113.14", "Устройство"],
        ["203.0.113.30", "Устройство"],
        ["203.0.113.100", "Устройство"],
        ["198.51.100.27", "Сервер"],
      ].flatMap(([ip, type], index) => [
        {
          ...base,
          id: `host-${index}`,
          name: `Inventory host ${index}`,
          type,
          ip,
          url: "",
          directions: ["Виртуализация"],
        },
        {
          ...base,
          id: `esxi-${index}`,
          name: `ESXi · host${index}`,
          type: "Web-сервис",
          ip,
          url: `https://${ip}/ui/`,
          directions: ["Виртуализация"],
          relations: [{ resource_id: `host-${index}`, label: "Размещено на" }],
        },
      ]),
      {
        ...base,
        id: "cloud",
        name: "MTC cloud portal",
        type: "Web-сервис",
        url: "https://cloud.example.test/tenant/lab/vdcs/dashboard",
        directions: ["Виртуализация"],
      },
      {
        ...base,
        id: "bmc",
        name: "BMC web interface",
        type: "Management",
        url: "https://192.0.2.40/",
        directions: ["Управление"],
      },
    ];
    // Exercise real new-tab navigation without contacting equipment or cloud.
    await page.context().route(
      (url) => resources.some((resource) => resource.url === url.href),
      (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<title>Management interface</title>",
        }),
    );
    const resourceQueries: URLSearchParams[] = [];
    await page.route("**/api/v1/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace("/api/v1", "");
      const data: Record<string, unknown> = {
        "/session": {
          authenticated: true,
          user: { id: "admin", name: "Admin", admin: true },
          csrf_token: "test",
          timezone: "Europe/Moscow",
        },
        "/preferences": {
          favorites: [],
          hidden_sections: [],
          section_order: [],
          home_widgets: [],
        },
        "/help-state": { disabled: true, seen: [] },
        "/workspace-preferences": {
          revision: 1,
          system_ids: [],
          groups: [],
        },
        "/dashboard-layout": { revision: 0, tiles: [], hidden: [] },
        "/chart-settings": { revision: 1, charts: [] },
        "/wayline": { sources: [] },
        "/dictionaries": {
          types: ["Web-сервис", "Виртуальная машина"],
          sites: [],
          environments: [],
          directions: ["Виртуализация", "Управление"],
        },
      };
      if (path === "/resources") {
        resourceQueries.push(url.searchParams);
        const direction = url.searchParams.get("direction");
        data[path] = resources.filter(
          (resource) => !direction || resource.directions.includes(direction),
        );
      }
      if (/^\/resources\/[^/]+\/inventory$/.test(path))
        data[path] = { sources: [] };
      await route.fulfill({ json: data[path] ?? [] });
    });
    await page.goto('/');
    await page.locator('.sidebar').getByRole('link', { name: 'Каталог', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Приложения 6', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.catalog-nav').getByRole('button', { name: 'Виртуализация 5', exact: true }).click();
    await expect(page.getByRole('button', { name: 'ESXi · host0', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'MTC cloud portal', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Inventory VM', exact: true })).toHaveCount(0);
    expect(resourceQueries.some(query => query.get('direction') === 'Виртуализация')).toBe(true);
    expect(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('kind')).toBe('applications');
    for (const resource of resources.filter(resource => resource.directions.includes('Виртуализация') && resource.url)) {
      await page.getByRole('button', { name: resource.name, exact: true }).click();
      const link = page.getByRole('dialog').getByRole('link', { name: `Открыть ${resource.name}`, exact: true });
      await expect(link).toHaveAttribute('href', resource.url);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      const popupPromise = page.waitForEvent('popup');
      await link.click();
      const popup = await popupPromise;
      await expect(popup).toHaveURL(resource.url);
      await popup.close();
      await page.keyboard.press("Escape");
    }
    await page.locator('.catalog-nav').getByRole('button', { name: 'Управление 1', exact: true }).click();
    await page.getByRole('button', { name: 'BMC web interface', exact: true }).click();
    const bmcLink = page.getByRole('dialog').getByRole('link', { name: 'Открыть BMC web interface', exact: true });
    await expect(bmcLink).toHaveAttribute('href', 'https://192.0.2.40/');
    const bmcPopupPromise = page.waitForEvent('popup');
    await bmcLink.click();
    const bmcPopup = await bmcPopupPromise;
    await expect(bmcPopup).toHaveURL("https://192.0.2.40/");
    await bmcPopup.close();
    await page.keyboard.press("Escape");
    await page
      .locator(".catalog-nav")
      .getByRole("button", { name: "Виртуализация 5", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Инфраструктура 5", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Inventory VM", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "ESXi · host0", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath(`catalog-management-${width}-${theme}.png`),
    });
  });
}
