import { test, expect } from "@playwright/test";
import type { DashboardLayoutState } from "../../src/DashboardLayout";
import type { WorkspacePreferences } from "../../src/workspaceTypes";

for (const width of [1920])
  for (const theme of ["dark", "light"]) {
    test(`resource icon selection persists ${width} ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({
        width,
        height: width === 1920 ? 1080 : 1440,
      });
      await page.addInitScript(
        (theme) => localStorage.setItem("pl-ui-theme", theme),
        theme,
      );
      const errors: string[] = [];
      const unknownRequests: string[] = [];
      const workspace: WorkspacePreferences = {
        revision: 0,
        system_ids: [],
        groups: [],
      };
      const layout: DashboardLayoutState = {
        revision: 0,
        tiles: [],
        hidden: [],
      };
      page.on("pageerror", (e) => errors.push(e.message));
      let employee = false;
      let employeeIcon = "book";
      let resource: Record<string, unknown> = {
        id: "picker-resource",
        revision: 1,
        name: "Доска",
        description: "Задачи проекта",
        type: "Web-сервис",
        url: "https://example.test/doska/",
        lifecycle: "active",
        endpoints: [],
        links: [],
        operations: [],
        directions: [],
        aliases: [],
        tags: [],
        relations: [],
        external_ids: [],
        check: {},
      };
      const writes: Record<string, unknown>[] = [];
      await page.route("**/api/v1/**", async (route) => {
        const req = route.request();
        const path = new URL(req.url()).pathname.replace("/api/v1", "");
        if (req.method() === "PUT" && path === "/resources/picker-resource") {
          const body = req.postDataJSON();
          if (body.revision !== resource.revision)
            return route.fulfill({
              status: 409,
              json: { message: "Конфликт ревизии ресурса" },
            });
          writes.push(body);
          resource = {
            ...resource,
            ...body,
            revision: Number(resource.revision) + 1,
          };
          if (resource.icon === "auto") delete resource.icon;
          await route.fulfill({ json: resource });
          return;
        }
        const data: Record<string, unknown> = {
          "/session": {
            authenticated: true,
            user: {
              id: "picker-admin",
              name: "Администратор",
              admin: !employee,
            },
            csrf_token: "fixture",
          },
          "/resources": [resource],
          "/resources/picker-resource": resource,
          "/resources/picker-resource/inventory": { sources: [] },
          "/resources/picker-resource/configuration-history": [],
          "/dashboard-layout": layout,
          "/workspace-preferences": workspace,
          "/modules": { items: [] },
          "/systems": [],
          "/collections": [],
          "/candidates": [],
          "/integrations": [],
          "/events": [],
          "/workspace-problems": [],
          "/time": { server_time: "2026-10-26T12:00:00Z" },
          "/preferences": {
            revision: 1,
            favorites: [resource.id],
            hidden_sections: [],
            section_order: [],
            home_widgets: [],
          },
          "/dictionaries": {
            types: ["Web-сервис"],
            directions: [],
            sites: [],
            environments: [],
          },
          "/help-state": { disabled: true, seen: [] },
          "/chart-settings": { revision: 1, charts: [] },
          "/board": {
            title: "Сервисы",
            items: [
              {
                id: resource.id,
                name: resource.name,
                description: "Задачи проекта",
                url: resource.url,
                status: "unknown",
                icon: employeeIcon,
                resource_icon: resource.icon,
              },
            ],
          },
        };
        if (req.method() === "GET" && path in data)
          return route.fulfill({ json: data[path] });
        if (req.method() === "GET" && path === "/wayline")
          return route.fulfill({ json: { sources: [] } });
        if (req.method() === "GET" && path === "/stream")
          return route.fulfill({
            contentType: "text/event-stream",
            body: "retry: 60000\n\n",
          });
        unknownRequests.push(`${req.method()} ${path}`);
        return route.fulfill({
          status: 503,
          json: {
            message: `Unexpected icon fixture request: ${req.method()} ${path}`,
          },
        });
      });
      const rowIcon = () => page.locator(".resource-row [data-system-icon]");
      const openPicker = async () => {
        await page.getByRole("button", { name: "Доска", exact: true }).click();
        await page
          .getByRole("button", { name: "Редактировать", exact: true })
          .click();
        await page.getByRole("button", { name: /^Выбрать иконку:/ }).click();
      };
      await page.goto("/#catalog");
      await expect(rowIcon()).toHaveAttribute("data-system-icon", "doska");
      await openPicker();
      const grid = page.getByRole("group", { name: "Выбор иконки" });
      await expect(grid.getByRole("button")).toHaveCount(39);
      await grid
        .getByRole("button", { name: "База данных", exact: true })
        .click();
      await expect(
        page.locator(".resource-icon-picker-heading [data-system-icon]"),
      ).toHaveAttribute("data-system-icon", "database");
      if (width === 1920 && theme === "dark")
        await page.getByRole("dialog").screenshot({
          path: test.info().outputPath("resource-icon-picker.png"),
        });
      await page
        .getByRole("button", { name: "Сохранить", exact: true })
        .click();
      await expect(rowIcon()).toHaveAttribute("data-system-icon", "database");
      expect(writes.at(-1)?.icon).toBe("database");
      await page.reload();
      await expect(rowIcon()).toHaveAttribute("data-system-icon", "database");
      await page.goto("/");
      await expect(
        page.locator(".workspace-favorite [data-system-icon]"),
      ).toHaveAttribute("data-system-icon", "database");
      await page.goto("/#catalog");
      await openPicker();
      await grid
        .getByRole("button", { name: "Автоматически", exact: true })
        .click();
      await expect(
        page.locator(".resource-icon-picker-heading [data-system-icon]"),
      ).toHaveAttribute("data-system-icon", "doska");
      await page
        .getByRole("button", { name: "Сохранить", exact: true })
        .click();
      expect(writes.at(-1)?.icon).toBe("auto");
      await page.reload();
      await expect(rowIcon()).toHaveAttribute("data-system-icon", "doska");
      resource.icon = "forms";
      employee = true;
      await page.goto("/");
      await page.reload();
      await expect(
        page.locator(".employee-card [data-system-icon]"),
      ).toHaveAttribute("data-system-icon", "forms");
      resource.icon = "auto";
      await page.reload();
      await expect(
        page.locator(".employee-card [data-system-icon]"),
      ).toHaveAttribute("data-system-icon", "wiki");
      employeeIcon = "app";
      await page.reload();
      await expect(
        page.locator(".employee-card [data-system-icon]"),
      ).toHaveAttribute("data-system-icon", "doska");
      expect(errors).toEqual([]);
      expect(unknownRequests).toEqual([]);
    });
  }
