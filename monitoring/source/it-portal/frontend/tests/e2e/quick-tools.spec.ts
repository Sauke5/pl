import { test, expect } from "@playwright/test";

for (const viewport of [{ width: 1920, height: 1080 }])
  for (const theme of ["dark", "light"]) {
    test(`quick checks readable results ${viewport.width} ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(
        (theme) => localStorage.setItem("pl-ui-theme", theme),
        theme,
      );
      let submitted: any;
      const jobs = new Map<string, unknown>();
      await page.route("**/api/v1/**", async (route) => {
        const path = new URL(route.request().url()).pathname.replace(
          "/api/v1",
          "",
        );
        const makeJob = (parameters: Record<string, any>, id: string) => ({
          id,
          kind: "check",
          parameters,
          status: "succeeded",
          actor: "Admin",
          created_at: "2026-09-28T01:15:35Z",
          result: {
            kind: parameters.kind,
            target: parameters.target,
            addresses: ["203.0.113.10"],
            http_status: 403,
            scanned_address: "93.186.225.208",
            ports: [
              { port: 80, state: "open" },
              { port: 443, state: "filtered" },
            ],
            duration_ms: 36,
          },
        });
        const data: Record<string, unknown> = {
          "/session": {
            authenticated: true,
            user: { id: "admin", name: "Admin", admin: true },
            csrf_token: "test",
            demo: true,
          },
          "/time": { server_time: "2026-09-28T01:15:35Z" },
          "/help-state": { disabled: true, seen: [] },
          "/preferences": {
            favorites: [],
            hidden_sections: [],
            section_order: [],
            home_widgets: [],
          },
          "/modules": { items: [] },
          "/resources": [],
          "/candidates": [],
          "/integrations": [],
          "/workspace-problems": [],
          "/events": [],
          "/systems": [],
          "/workspace-preferences": { revision: 0, system_ids: [], groups: [] },
          "/dashboard-layout": { revision: 0, tiles: [], hidden: [] },
          "/chart-settings": { revision: 1, charts: [] },
          "/wayline": { sources: [] },
          "/dictionaries": {
            types: [],
            sites: [],
            environments: [],
            directions: [],
          },
        };
        if (path === "/jobs" && route.request().method() === "POST") {
          expect(route.request().headers()["x-csrf-token"]).toBe("test");
          submitted = route.request().postDataJSON();
          expect(submitted.kind).toBe("check");
          const id = `j${jobs.size + 1}`;
          const job = makeJob(submitted.parameters, id);
          jobs.set(id, job);
          await route.fulfill({ json: job });
          return;
        }
        if (route.request().method() === "GET" && path === "/stream")
          return route.fulfill({
            contentType: "text/event-stream",
            body: "retry: 60000\n\n",
          });
        expect(route.request().method()).toBe("GET");
        if (path.startsWith("/jobs/")) {
          const id = path.slice("/jobs/".length);
          expect(jobs.has(id), `Unknown job poll: ${path}`).toBe(true);
          await route.fulfill({ json: jobs.get(id) });
          return;
        }
        expect(Object.hasOwn(data, path), `Unmocked API: ${path}`).toBe(true);
        await route.fulfill({ json: data[path] });
      });
      await page.goto("/");
      await page
        .getByRole("button", { name: "Проверить адрес", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Проверка адреса",
        exact: true,
      });
      await dialog
        .getByLabel("Имя сервера, IP или адрес сайта")
        .fill("server-a.example.invalid");
      await dialog
        .getByRole("button", { name: "Запустить проверку", exact: true })
        .click();
      await expect(
        dialog.getByText("Имя найдено", { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByText("203.0.113.10", { exact: true }),
      ).toBeVisible();
      await expect(dialog.getByText("36 мс", { exact: true })).toBeVisible();
      await expect(dialog.locator(".json-view")).not.toBeVisible();
      await dialog
        .getByText("Технические подробности", { exact: true })
        .click();
      await expect(dialog.locator(".json-view")).toBeVisible();
      await dialog
        .getByText("Технические подробности", { exact: true })
        .click();
      await page.screenshot({
        path: `artifacts/quick-tools-${viewport.width}-${theme}.png`,
      });
      await dialog.getByRole("button", { name: "Новая проверка" }).click();
      await dialog.getByRole("button", { name: "HTTP", exact: true }).click();
      await dialog
        .getByLabel("Адрес сайта", { exact: true })
        .fill("https://vk.com");
      await dialog
        .getByRole("button", { name: "Запустить проверку", exact: true })
        .click();
      await expect(
        dialog.getByText("Сайт ответил, доступ ограничен"),
      ).toBeVisible();
      await expect(
        dialog.getByText("HTTP 403 · Доступ запрещён"),
      ).toBeVisible();
      await dialog.getByRole("button", { name: "Новая проверка" }).click();
      for (const [host, endpoint] of [
        ["10.73.10.22", "10.73.10.22:19100"],
        ["fd00::22", "[fd00::22]:19100"],
      ]) {
        await dialog.getByRole("button", { name: "TCP", exact: true }).click();
        await dialog.getByLabel("Адрес сервера", { exact: true }).fill(host);
        await dialog.getByLabel("TCP-порт", { exact: true }).fill("");
        const before = submitted;
        await dialog
          .getByRole("button", { name: "Запустить проверку", exact: true })
          .click();
        expect(submitted).toBe(before);
        await expect(
          dialog.getByLabel("TCP-порт", { exact: true }),
        ).toBeFocused();
        await dialog.getByLabel("TCP-порт", { exact: true }).fill("19100");
        await dialog
          .getByRole("button", { name: "Запустить проверку", exact: true })
          .click();
        await expect(
          dialog.getByText("Порт принимает соединения", { exact: true }),
        ).toBeVisible();
        expect(submitted.parameters).toEqual({ kind: "tcp", target: endpoint });
        await dialog.getByRole("button", { name: "Новая проверка" }).click();
      }
      await dialog.getByRole("button", { name: "Порты", exact: true }).click();
      await dialog.locator("input").fill("vk.com:80,443");
      await dialog
        .getByRole("button", { name: "Запустить проверку", exact: true })
        .click();
      await expect(
        dialog.getByText("80 — открыт", { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByText("443 — фильтруется", { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByText("93.186.225.208", { exact: true }),
      ).toBeVisible();
      await expect(dialog.locator(".json-view")).not.toBeVisible();
      await page.keyboard.press("Escape");
      await page.screenshot({
        path: `artifacts/quick-tools-home-${viewport.width}-${theme}.png`,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
  }
