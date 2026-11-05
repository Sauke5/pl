import { test, expect } from "@playwright/test";
for (const width of [1920])
  for (const theme of ["dark", "light"]) {
    test(`home header ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1080 });
      await page.addInitScript(
        (theme) => localStorage.setItem("pl-ui-theme", theme),
        theme,
      );
      await page.clock.setFixedTime(new Date("2000-01-01T00:00:00Z"));
      await page.route("**/api/v1/**", async (route) => {
        const path = new URL(route.request().url()).pathname.replace(
          "/api/v1",
          "",
        );
        const data: Record<string, unknown> = {
          "/session": {
            authenticated: true,
            user: { id: "kirill", name: "Кирилл", admin: true },
            csrf_token: "test",
            timezone: "Europe/Moscow",
          },
          "/time": { server_time: "2026-09-29T01:21:32Z" },
          "/preferences": {
            favorites: ["grafana"],
            hidden_sections: [],
            section_order: [],
            home_widgets: [],
          },
          "/dashboard-layout": { revision: 0, tiles: [], hidden: [] },
          "/workspace-preferences": { revision: 0, system_ids: [], groups: [] },
          "/help-state": { disabled: true, seen: [] },
          "/chart-settings": { revision: 1, charts: [] },
          "/wayline": { sources: [] },
          "/resources": [
            {
              id: "grafana",
              name: "Grafana",
              url: "https://grafana.example",
              description: "Панели мониторинга",
              type: "Web",
              lifecycle: "active",
              operations: [],
              directions: [],
              tags: [],
              endpoints: [],
              check: {},
            },
          ],
        };
        await route.fulfill({ json: data[path] ?? [] });
      });
      await page.goto("/");
      await expect(page.locator(".greeting h1")).toHaveText(
        "Моё рабочее пространство",
      );
      await expect(page.locator(".home-server-clock time")).toHaveText(
        "04:21:32",
      );
      await expect(page.locator(".home-server-clock time")).not.toHaveText(
        "04:21:32",
        { timeout: 3000 },
      );
      await expect(page.locator(".home-intro .eyebrow")).toHaveCount(0);
      await expect(page.locator(".global-search kbd")).toHaveCount(0);
      const heading = page.locator(
        '[data-layout-tile="favorites"] .section-heading',
      );
      await expect(
        page.getByRole("button", { name: "Настроить главную", exact: true }),
      ).toBeVisible();
      const geometry = await page.evaluate(() => {
        const rect = (s: string) =>
          document.querySelector(s)!.getBoundingClientRect();
        const intro = rect(".home-intro"),
          greeting = rect(".greeting"),
          toolbar = rect(".dashboard-layout-toolbar"),
          heading = rect('[data-layout-tile="favorites"] .section-heading'),
          cards = rect(".workspace-favorites-grid");
        return {
          center: Math.abs(
            greeting.y + greeting.height / 2 - intro.y - intro.height / 2,
          ),
          gap: toolbar.y - intro.bottom,
          cardsGap: cards.y - heading.bottom,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      expect(geometry.center).toBeLessThan(3);
      expect(geometry.gap).toBeLessThanOrEqual(30);
      expect(geometry.cardsGap).toBeLessThanOrEqual(16);
      expect(geometry.overflow).toBe(false);
      await page.screenshot({
        path: `artifacts/home-header-${width}-${theme}.png`,
      });
      await page.keyboard.press("Control+k");
      await expect(page.getByRole("dialog")).toBeVisible();
    });
  }
