import { test, expect, type Page } from "@playwright/test";

const instanceID = "11111111-1111-4111-8111-111111111111";
const configPath = `/modules/${instanceID}/configuration`;
const initial = () => ({
  revision: 0,
  global: { scrape_interval: "15s", scrape_timeout: "10s" },
  jobs: [] as Record<string, unknown>[],
});

async function fixture(
  page: Page,
  external = false,
  conflict = false,
  failApply = false,
) {
  let draft = initial();
  let applied = initial();
  let retried = false;
  const writes: { path: string; data: Record<string, unknown> }[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (path.startsWith(configPath) && request.method() !== "GET") {
      expect(request.headers()["x-csrf-token"]).toBe("test-csrf");
      const data = request.postDataJSON();
      writes.push({ path, data });
      if (request.method() === "PUT") {
        if (conflict)
          return route.fulfill({
            status: 409,
            json: {
              code: "revision_conflict",
              message: "Черновик изменён другим администратором",
            },
          });
        draft = { ...data.configuration, revision: draft.revision + 1 };
      } else if (path.endsWith("/validate")) {
        return route.fulfill({
          json: {
            valid: true,
            yaml: "global:\n  scrape_interval: 15s\nscrape_configs: []\n",
            hash: "verified",
          },
        });
      } else if (path.endsWith("/apply")) {
        if (!failApply) applied = structuredClone(draft);
        return route.fulfill({
          status: 202,
          json: {
            instance: { id: instanceID },
            job: { id: "configuration-job" },
          },
        });
      } else if (path.endsWith("/retry")) {
        retried = true;
        applied = structuredClone(draft);
        return route.fulfill({
          status: 202,
          json: { job: { id: "configuration-job" } },
        });
      }
    }
    const response: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "admin", name: "Admin", admin: true },
        csrf_token: "test-csrf",
        timezone: "Europe/Moscow",
      },
      "/help-state": { disabled: true, seen: [] },
      "/preferences": {
        favorites: [],
        hidden_sections: [],
        section_order: [],
        home_widgets: [],
      },
      "/chart-settings": { revision: 1, charts: [] },
      "/wayline": { sources: [] },
      "/modules/catalog": { items: [], local_available: true },
      "/modules": {
        items: [
          {
            id: instanceID,
            module_id: "prometheus",
            name: "Lab Prometheus",
            mode: external ? "external" : "local",
            desired_state: "enabled",
            observed_state: "running",
          },
        ],
      },
      [configPath]: {
        editable: !external,
        reason: external ? "Внешний экземпляр доступен только для чтения." : "",
        draft: external ? null : draft,
        applied: external ? null : applied,
        last_job_id: "",
        last_error:
          failApply && !retried ? "Загрузка конфигурации не подтверждена" : "",
        rolled_back: false,
      },
      "/jobs/configuration-job": {
        id: "configuration-job",
        status: failApply && !retried ? "failed" : "succeeded",
        finished_at: "2026-10-17T12:00:00Z",
        result: {},
        error:
          failApply && !retried ? "Загрузка конфигурации не подтверждена" : "",
      },
    };
    await route.fulfill({ json: response[path] ?? [] });
  });
  await page.goto(`/#modules?instance=${instanceID}&view=configuration`);
  await expect(
    page.getByRole("heading", { name: "Настройки Prometheus", exact: true }),
  ).toBeVisible();
  return writes;
}

for (const theme of ["dark", "light"]) {
  test(`Prometheus jobs: save, validate and apply (${theme})`, async ({
    page,
  }) => {
    const writes = await fixture(page);
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await expect(
      page.getByText("Защищённый job", { exact: false }),
    ).toBeVisible();
    await expect(page.getByLabel("Системный job", { exact: true })).toHaveValue(
      "prometheus",
    );
    await expect(
      page.getByLabel("Системный job", { exact: true }),
    ).toHaveAttribute("readonly", "");
    await expect(
      page.getByLabel("Системный target", { exact: true }),
    ).toHaveValue("127.0.0.1:9090");
    await expect(
      page.getByLabel("Системный target", { exact: true }),
    ).toHaveAttribute("readonly", "");
    await page
      .getByRole("button", { name: "Добавить job", exact: true })
      .click();
    const job = page.getByRole("region", { name: "Job 1", exact: true });
    await job.getByLabel("Имя job", { exact: true }).fill("linux_nodes");
    await job.getByLabel(/^Адрес target 1/).fill("node.example:9100");
    await job
      .getByRole("button", { name: "Добавить метку", exact: true })
      .click();
    await job.getByLabel("Имя метки 1", { exact: true }).fill("site");
    await job.getByLabel("Значение метки 1", { exact: true }).fill("lab");
    await expect(
      page.getByRole("button", { name: "Применить", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Сохранить черновик", exact: true })
      .click();
    await expect(
      page.getByText("Черновик · версия 1 · Без изменений", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Проверить конфигурацию", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "YAML после проверки" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Применить", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Применить конфигурацию", exact: true })
      .click();
    await expect(
      page.getByText("Применена версия 1", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Применено", { exact: true })).toBeVisible();
    const save = writes.find((write) => write.path === configPath)!;
    expect(save.data.configuration).toMatchObject({
      jobs: [
        {
          name: "linux_nodes",
          targets: [{ address: "node.example:9100", labels: { site: "lab" } }],
        },
      ],
    });
    expect(
      writes.find((write) => write.path.endsWith("/apply"))?.data,
    ).toMatchObject({ revision: 1 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("invalid label cannot silently disappear into saved draft; revision conflict preserves edits", async ({
  page,
}) => {
  const writes = await fixture(page, false, true);
  await page.getByRole("button", { name: "Добавить job", exact: true }).click();
  const job = page.getByRole("region", { name: "Job 1", exact: true });
  await job.getByLabel("Имя job", { exact: true }).fill("nodes");
  await job.getByLabel(/^Адрес target 1/).fill("node.example:9100");
  await job
    .getByRole("button", { name: "Добавить метку", exact: true })
    .click();
  await job.getByLabel("Имя метки 1", { exact: true }).fill("__invalid");
  await expect(
    page.getByRole("button", { name: "Сохранить черновик", exact: true }),
  ).toBeDisabled();
  expect(writes).toHaveLength(0);
  await job
    .getByRole("button", { name: "Удалить метку 1", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(job.getByLabel("Имя job", { exact: true })).toHaveValue("nodes");
  await page.getByRole("link", { name: "К модулю", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Есть несохранённые изменения" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Продолжить редактирование", exact: true })
    .click();
  await expect(job.getByLabel("Имя job", { exact: true })).toHaveValue("nodes");
});

test("external Prometheus does not offer configuration writes or fabricated jobs", async ({
  page,
}) => {
  const writes = await fixture(page, true);
  await expect(
    page.getByText("HTTP API Prometheus позволяет читать данные", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Добавить job", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toHaveCount(0);
  expect(writes).toHaveLength(0);
});

test("failed application retries the same frozen operation when rollback is unconfirmed", async ({
  page,
}) => {
  const writes = await fixture(page, false, false, true);
  await page.getByLabel("Общий интервал сбора", { exact: false }).fill("30s");
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await expect(
    page.getByText("Черновик · версия 1 · Без изменений", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Проверить конфигурацию", exact: true })
    .click();
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Применить конфигурацию", exact: true })
    .click();
  await expect(
    page.getByText("Восстановление предыдущей конфигурации не подтверждено", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Повторить применение", exact: true })
    .click();
  await expect(
    page.getByText("Применена версия 1", { exact: true }),
  ).toBeVisible();
  expect(writes.filter((write) => write.path.endsWith("/apply"))).toHaveLength(
    1,
  );
  expect(writes.find((write) => write.path.endsWith("/retry"))?.data).toEqual({
    job_id: "configuration-job",
  });
});
