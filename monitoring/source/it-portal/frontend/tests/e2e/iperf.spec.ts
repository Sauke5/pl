import { test, expect } from "@playwright/test";

for (const viewport of [{ width: 1920, height: 1080 }])
  for (const theme of ["dark", "light"]) {
    test(`iperf direction, duration and readable result ${viewport.width} ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(
        (theme) => localStorage.setItem("pl-ui-theme", theme),
        theme,
      );
      let submitted: any;
      const jobs = new Map<string, unknown>();
      let rejectNext = true;
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
            origin: "monitoring",
            direction: parameters.direction,
            throughput_mbps: 942.56,
            bytes_received: 1178200000,
            test_seconds: parameters.duration_seconds,
            kind: parameters.kind,
            target: parameters.target,
            addresses: ["203.0.113.10"],
            http_status: 403,
            scanned_address: "203.0.113.10",
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
          if (rejectNext) {
            rejectNext = false;
            await route.fulfill({
              status: 400,
              json: {
                error: "invalid_iperf",
                message: "Проверьте параметры iperf3",
              },
            });
            return;
          }
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
      await dialog.getByRole("button", { name: "iperf3", exact: true }).click();
      await expect(dialog.getByLabel("Направление")).toHaveValue("upload");
      await expect(dialog.getByLabel("Длительность")).toHaveValue("10");
      await dialog
        .getByLabel("Сервер iperf3 и порт", { exact: true })
        .fill("203.0.113.10:5201");
      await expect(dialog.getByText(/Тест создаёт нагрузку/)).toBeVisible();
      await expect(dialog).toHaveCSS("opacity", "1");
      await page.screenshot({
        path: `artifacts/iperf-form-${viewport.width}-${theme}.png`,
      });
      await dialog
        .getByRole("button", { name: "Запустить проверку", exact: true })
        .click();
      await expect(
        dialog.getByText("Проверьте параметры iperf3"),
      ).toBeVisible();
      await expect(
        dialog.getByLabel("Сервер iperf3 и порт", { exact: true }),
      ).toHaveValue("203.0.113.10:5201");
      await expect(dialog.getByLabel("Направление")).toHaveValue("upload");
      await expect(dialog.getByLabel("Длительность")).toHaveValue("10");
      await expect(dialog.getByLabel("Скорость передачи")).not.toBeVisible();
      for (const [direction, duration] of [
        ["upload", "10"],
        ["download", "5"],
        ["upload", "15"],
      ]) {
        await dialog.getByLabel("Направление").selectOption(direction);
        await dialog.getByLabel("Длительность").selectOption(duration);
        await dialog
          .getByRole("button", { name: "Запустить проверку", exact: true })
          .click();
        await expect(
          dialog.getByText("Скорость канала измерена"),
        ).toBeVisible();
        expect(submitted.kind).toBe("check");
        expect(submitted.parameters).toEqual({
          kind: "iperf",
          target: "203.0.113.10:5201",
          direction,
          duration_seconds: Number(duration),
        });
        await expect(dialog.getByLabel("Скорость передачи")).toContainText(
          "942,56",
        );
        await expect(
          dialog.getByText(direction === "upload" ? "Прямое" : "Реверсивное", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          dialog.getByText(duration + " с", { exact: true }),
        ).toBeVisible();
        await expect(dialog.locator(".json-view")).not.toBeVisible();
        if (direction === "download")
          await page.screenshot({
            path: `artifacts/iperf-result-${viewport.width}-${theme}.png`,
          });
        await dialog.getByRole("button", { name: "Новая проверка" }).click();
      }
      await dialog.getByRole("button", { name: "DNS", exact: true }).click();
      await expect(dialog.getByLabel("Направление")).not.toBeVisible();
      await dialog
        .getByLabel("Имя сервера, IP или адрес сайта")
        .fill("server.example.ru");
      await dialog
        .getByRole("button", { name: "Запустить проверку", exact: true })
        .click();
      await expect(
        dialog.getByText("Имя найдено", { exact: true }),
      ).toBeVisible();
      expect(submitted.parameters).toEqual({
        kind: "dns",
        target: "server.example.ru",
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
  }
