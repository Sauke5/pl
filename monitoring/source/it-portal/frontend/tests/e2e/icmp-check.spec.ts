import { test, expect } from "@playwright/test";

for (const [width, theme, received] of [
  [1920, "dark", 2000],
  [3440, "light", 2000],
  [3840, "night", 2000],
  [1920, "dark", 0],
] as const) {
  test(`fixed ICMP and measurement ${width} ${theme} received=${received}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1080 });
    await page.addInitScript(
      (theme) => localStorage.setItem("pl-ui-theme", theme),
      theme,
    );
    let submitted: any;
    let outputReads = 0;
    const raw = received === 0 ? "2000 packets transmitted, 0 packets received, 100% packet loss" : Array.from(
      { length: 2000 },
      (_, n) => `len=46 ip=192.0.2.10 icmp_seq=${n} rtt=0.5 ms`,
    ).join("\n");
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(
        "/api/v1",
        "",
      );
      const job = {
        id: "icmp-job",
        kind: "check",
        status: "succeeded",
        parameters: submitted?.parameters,
        actor: "admin",
        created_at: "2026-11-04T12:00:00Z",
        result: {
          kind: "icmp",
          target: "server.example",
          scanned_address: "192.0.2.10",
          count: 2000,
          interval_us: 2000,
          transmitted: 2000,
          received,
          loss_percent: received === 0 ? 100 : 0,
          rtt_min_ms: received === 0 ? null : 0.2,
          rtt_avg_ms: received === 0 ? null : 0.5,
          rtt_max_ms: received === 0 ? null : 2,
        },
      };
      if (path === "/jobs/icmp-job/output") {
        outputReads++;
        return route.fulfill({ json: { raw_output: raw } });
      }
      if (path === "/jobs" && route.request().method() === "POST") {
        submitted = route.request().postDataJSON();
        return route.fulfill({ json: job });
      }
      const data: Record<string, unknown> = {
        "/session": {
          authenticated: true,
          user: { id: "admin", name: "Admin", admin: true },
          csrf_token: "test",
          demo: true,
        },
        "/help-state": { disabled: true, seen: [] },
        "/preferences": {
          favorites: [],
          hidden_sections: [],
          section_order: [],
          home_widgets: [],
        },
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
        "/jobs/icmp-job": job,
      };
      return route.fulfill({ json: data[path] ?? [] });
    });
    await page.goto("/");
    await page
      .getByRole("button", { name: "Проверить адрес", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "ICMP", exact: true }).click();
    await expect(dialog.locator("input")).toHaveCount(1);
    await expect(dialog.locator("select")).toHaveCount(0);
    await dialog.getByLabel("IP-адрес или hostname").fill("server.example");
    await dialog
      .getByRole("button", { name: "Запустить проверку", exact: true })
      .click();
    await expect(
      dialog.getByRole("heading", { name: received === 0 ? "Ответы ICMP не получены" : "ICMP-проверка завершена" }),
    ).toBeVisible();
    expect(submitted.parameters).toEqual({
      kind: "icmp",
      target: "server.example",
    });
    await expect(dialog.getByLabel("Статистика ICMP")).toContainText(
      "2000 пакетов",
    );
    await expect(dialog.getByLabel("Статистика ICMP")).toContainText(
      `${received} ответов`,
    );
    if (received === 0) {
      await expect(dialog.getByLabel("Статистика ICMP").locator("div").filter({ has: page.getByText("RTT мин. / ср. / макс.", { exact: true }) }).locator("dd")).toHaveText("—");
    }
    const output = dialog.getByLabel("Полный вывод ICMP", { exact: true });
    await expect(output).not.toBeVisible();
    expect(outputReads).toBe(0);
    await dialog.getByText("Технические подробности", { exact: true }).click();
    await expect(output).toBeVisible();
    expect(outputReads).toBe(1);
    expect((await output.textContent())?.split("\n")).toHaveLength(received === 0 ? 1 : 2000);
    await expect(output).toContainText(received === 0 ? "100% packet loss" : "icmp_seq=1999 ");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: `artifacts/icmp-${width}-${theme}.png` });
  });
}
