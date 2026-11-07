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
  {
    external = false,
    conflict = false,
    failApply = false,
    initialDraft = initial(),
    initialApplied = initial(),
  }: {
    external?: boolean;
    conflict?: boolean;
    failApply?: boolean;
    initialDraft?: ReturnType<typeof initial>;
    initialApplied?: ReturnType<typeof initial>;
  } = {},
) {
  let draft = initialDraft;
  let applied = initialApplied;
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
    await expect(
      page.getByRole("heading", { name: "Черновик конфигурации" }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Добавить задание", exact: true })
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
    await expect(job).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Черновик конфигурации" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "YAML после проверки" }),
    ).toHaveCount(0);
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
  const writes = await fixture(page, { conflict: true });
  await page
    .getByRole("button", { name: "Добавить задание", exact: true })
    .click();
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
  const writes = await fixture(page, { external: true });
  await expect(
    page.getByText("HTTP API Prometheus позволяет читать данные", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Добавить задание", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Применить", exact: true }),
  ).toHaveCount(0);
  expect(writes).toHaveLength(0);
});

test("applied jobs stay visible while one draft job is edited", async ({
  page,
}) => {
  const linux = {
    name: "Linux",
    enabled: true,
    scrape_interval: "15s",
    scrape_timeout: "10s",
    metrics_path: "/metrics",
    scheme: "http",
    targets: [{ address: "node.example:9100", labels: {} }],
  };
  const windows = { ...linux, name: "Windows", enabled: false };
  const initialApplied = { ...initial(), revision: 7, jobs: [linux, windows] };
  const initialDraft = {
    ...initialApplied,
    revision: 8,
    jobs: [{ ...linux, scrape_interval: "1m" }, windows],
  };
  const writes = await fixture(page, { initialApplied, initialDraft });
  const appliedJobs = page.getByRole("region", { name: "Применённые задания" });
  const linuxRow = appliedJobs
    .getByRole("listitem")
    .filter({ hasText: "Linux" });
  const edit = linuxRow.getByRole("button", {
    name: "Редактировать задание Linux",
  });
  await expect(linuxRow).toContainText("интервал 15s");
  await expect(
    appliedJobs.getByRole("listitem").filter({ hasText: "Windows" }),
  ).toContainText("Отключено");
  await expect(page.getByRole("region", { name: /^Job \d+$/ })).toHaveCount(0);

  await edit.click();
  const editor = page.getByRole("region", { name: "Job 1", exact: true });
  await expect(page.getByRole("region", { name: /^Job \d+$/ })).toHaveCount(1);
  const interval = editor.getByLabel("Интервал сбора", { exact: true });
  await expect(interval).toHaveValue("1m");
  await interval.fill("2m");
  await editor.getByRole("button", { name: "Добавить метку" }).click();
  await editor.getByLabel("Имя метки 1").fill("__invalid");
  await page
    .getByRole("button", { name: "К действующей конфигурации" })
    .click();
  await expect(linuxRow).toContainText("интервал 15s");
  await expect(page.getByRole("region", { name: /^Job \d+$/ })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Сохранить черновик" }),
  ).toBeDisabled();

  await edit.click();
  await expect(interval).toHaveValue("2m");
  await expect(editor.getByLabel("Имя метки 1")).toHaveValue("__invalid");
  await expect(editor.getByRole("alert")).toBeVisible();
  expect(writes).toHaveLength(0);
});

test("Prometheus targets keep their order through polling and a failed refresh", async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page);
  const addresses = ["192.0.2.22:19100", "192.0.2.25:19100", "127.0.0.1:9090"];
  const targets = addresses.map((address, index) => {
    const job = index < 2 ? "Linux" : "prometheus";
    return {
      scrapePool: job,
      labels: { job, instance: address },
      scrapeUrl: `http://${address}/metrics`,
      health: "up",
    };
  });
  const path = `/api/v1/modules/${instanceID}/prometheus/api/v1/targets`;
  const releasePoll = Promise.withResolvers<void>();
  let phase: "initial" | "reorder" | "fail" = "initial";
  let polls = 0;
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      if (phase === "fail")
        return route.fulfill({
          status: 503,
          json: { message: "Prometheus недоступен" },
        });
      const reorder = phase === "reorder";
      if (reorder) {
        polls++;
        await releasePoll.promise;
      }
      const activeTargets = reorder
        ? [{ ...targets[2], health: "down" }, targets[1], targets[0]]
        : targets;
      return route.fulfill({
        json: { status: "success", data: { activeTargets } },
      });
    },
  );
  await page.goto(`/#monitoring?instance=${instanceID}`);
  const card = page.locator(".prom-targets-card");
  const targetAddresses = card.locator("tbody tr td:first-child strong");
  const refresh = card.getByRole("button", { name: "Обновить цели" });
  await expect(targetAddresses).toHaveText(addresses);

  phase = "reorder";
  const polling = page.waitForRequest(
    (request) => new URL(request.url()).pathname === path,
  );
  await page.clock.fastForward(30_000);
  await polling;
  try {
    await expect(card.getByText("Получаем данные…")).toBeVisible();
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(refresh).toBeDisabled();
    expect(polls).toBe(1);
  } finally {
    releasePoll.resolve();
  }
  const self = card.getByRole("row").filter({ hasText: addresses[2] });
  await expect(self).toContainText("Ошибка сбора");
  await expect(targetAddresses).toHaveText(addresses);
  phase = "fail";
  await refresh.click();
  await expect(card.getByRole("alert")).toContainText("Prometheus недоступен");
  await expect(targetAddresses).toHaveText(addresses);
  await expect(self).toContainText("Последний статус: Ошибка сбора");
});

test("Prometheus waits for configuration readback and keeps newer edits", async ({
  page,
}) => {
  const writes = await fixture(page);
  const releaseReadback = Promise.withResolvers<void>();
  await page.route(
    (url) => url.pathname === `/api/v1${configPath}`,
    async (route) => {
      if (
        route.request().method() === "GET" &&
        writes.some(({ path }) => path.endsWith("/apply"))
      )
        await releaseReadback.promise;
      return route.fallback();
    },
  );
  await page
    .getByRole("button", { name: "Редактировать общие параметры" })
    .click();
  const interval = page.getByLabel("Общий интервал сбора", { exact: false });
  await interval.fill("30s");
  await page
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Проверить конфигурацию", exact: true })
    .click();
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Применить конфигурацию", exact: true })
    .click();
  try {
    await expect(page.getByText("Применено", { exact: true })).toBeVisible();
    await expect(interval).toHaveValue("30s");
    await interval.fill("45s");
  } finally {
    releaseReadback.resolve();
  }
  await expect(
    page.getByText("Применена версия 1", { exact: true }),
  ).toBeVisible();
  await expect(interval).toHaveValue("45s");
  await expect(
    page.getByText("Черновик · версия 1 · Есть изменения", { exact: true }),
  ).toBeVisible();
});

test("failed application retries the same frozen operation when rollback is unconfirmed", async ({
  page,
}) => {
  const writes = await fixture(page, { failApply: true });
  await page
    .getByRole("button", { name: "Редактировать общие параметры" })
    .click();
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
  await expect(
    page.getByRole("button", { name: "Сохранить черновик", exact: true }),
  ).toHaveCount(0);
  expect(writes.filter((write) => write.path.endsWith("/apply"))).toHaveLength(
    1,
  );
  expect(writes.find((write) => write.path.endsWith("/retry"))?.data).toEqual({
    job_id: "configuration-job",
  });
});
