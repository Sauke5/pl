import { expect, test, type Page } from "@playwright/test";

const id = "a1111111-1111-4111-8111-111111111111";
const prefix = `/modules/${id}/sftpgo`;
const limits = {
  quota_size: 0,
  quota_files: 0,
  max_sessions: 0,
  upload_bandwidth: 0,
  download_bandwidth: 0,
};
const publicKey =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA fixture";
type Write = {
  path: string;
  query: string;
  method: string;
  body: any;
  headers: Record<string, string>;
};

async function fixture(
  page: Page,
  options: {
    admin?: boolean;
    authenticated?: boolean;
    deniedUpload?: boolean;
    failedSettings?: boolean;
    nativeAuthFailure?: "list" | "upload" | "download";
    nativeAuthCode?:
      "sftpgo_authentication_required" | "sftpgo_authentication_expired";
  } = {},
) {
  const admin = options.admin !== false;
  let authenticated = !!options.authenticated;
  let nativeExpired = false;
  let clientUsername = "file-reader";
  const writes: Write[] = [];
  const reads: string[] = [];
  const users: any[] = [];
  const groups: any[] = [];
  const entries = [
    {
      name: "report.txt",
      type: "file",
      size: 8,
      modified_at: "2026-10-26T12:00:00Z",
    },
    {
      name: "archive",
      type: "dir",
      size: 0,
      modified_at: "2026-10-26T12:00:00Z",
    },
  ];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/v1", "");
    const method = request.method();
    if (method !== "GET") {
      expect(request.headers()["x-csrf-token"]).toBe("sftpgo-fixture-csrf");
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      const body = path.endsWith("/files/content")
        ? request.postData()
        : request.postData()
          ? request.postDataJSON()
          : undefined;
      writes.push({
        path,
        query: url.search,
        method,
        body,
        headers: request.headers(),
      });
      if (path === prefix + "/client/login") {
        if (nativeExpired)
          entries.splice(0, entries.length, {
            name: "fresh.txt",
            type: "file",
            size: 3,
            modified_at: "2026-10-26T12:00:00Z",
          });
        nativeExpired = false;
        clientUsername = body.username;
        authenticated = true;
        return route.fulfill({
          json: { authenticated: true, username: body.username },
        });
      }
      if (path === prefix + "/client/logout") {
        authenticated = false;
        return route.fulfill({ status: 204 });
      }
      if (path.endsWith("/users") || path.includes("/users/")) {
        const user = body?.user;
        if (user) {
          const { password, ...safe } = user;
          const saved = {
            ...safe,
            has_password:
              !!password ||
              users.some(
                (old) => old.username === safe.username && old.has_password,
              ),
          };
          const old = users.findIndex(
            (item) => item.username === saved.username,
          );
          if (old < 0) users.push(saved);
          else users[old] = saved;
        }
        return route.fulfill({ status: 204 });
      }
      if (path === prefix + "/groups") {
        groups.push(body.group);
        return route.fulfill({ status: 204 });
      }
      if (path === prefix + "/settings")
        return route.fulfill({
          status: 202,
          json: {
            instance: module,
            job: { id: "sftp-settings-job", status: "pending" },
          },
        });
      if (path === prefix + "/files/content") {
        if (nativeExpired && options.nativeAuthFailure === "upload")
          return route.fulfill({
            status: 403,
            json: {
              error: {
                code:
                  options.nativeAuthCode || "sftpgo_authentication_required",
                message: "Сессия файлового сервера истекла",
              },
            },
          });
        expect(url.searchParams.has("overwrite")).toBe(false);
        if (options.deniedUpload)
          return route.fulfill({
            status: 403,
            json: { error: "file_forbidden", message: "Недостаточно прав" },
          });
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({ status: 204 });
    }
    reads.push(path);
    if (path === prefix + "/status")
      return route.fulfill({
        json: {
          state: "running",
          version: "2.7.1",
          client_authenticated: authenticated,
          client_username: authenticated ? clientUsername : undefined,
          configuration: { listen_ip: "127.0.0.1", port: 2022, revision: 5 },
        },
      });
    if (path === prefix + "/users")
      return route.fulfill({ json: { items: users } });
    if (path === prefix + "/groups")
      return route.fulfill({ json: { items: groups } });
    if (path === prefix + "/folders")
      return route.fulfill({
        json: {
          items: [
            {
              name: "team",
              description: "Общая папка",
              used_quota_size: 0,
              used_quota_files: 0,
              users: [],
            },
          ],
        },
      });
    if (
      nativeExpired &&
      ((path === prefix + "/files" && options.nativeAuthFailure === "list") ||
        (path === prefix + "/files/content" &&
          options.nativeAuthFailure === "download"))
    )
      return route.fulfill({
        status: 403,
        json: {
          error: {
            code: options.nativeAuthCode || "sftpgo_authentication_required",
            message: "Сессия файлового сервера истекла",
          },
        },
      });
    if (path === prefix + "/files")
      return route.fulfill({
        json: { path: url.searchParams.get("path"), entries },
      });
    if (path === prefix + "/settings")
      return route.fulfill({
        json: { listen_ip: "127.0.0.1", port: 2022, revision: 5 },
      });
    if (path === "/jobs/sftp-settings-job")
      return route.fulfill({
        json: {
          id: "sftp-settings-job",
          status: options.failedSettings ? "failed" : "succeeded",
          error: options.failedSettings ? "Выбранный порт уже занят" : "",
        },
      });
    const responses: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "fixture-local", name: "Пользователь", admin },
        csrf_token: "sftpgo-fixture-csrf",
        features: {},
        local_users_enabled: true,
      },
      "/sftpgo": { instance_id: id, name: module.name, state: "running" },
      "/modules": { items: [module] },
      "/modules/catalog": {
        items: [
          {
            id: "sftpgo",
            name: "SFTPGo",
            modes: ["local"],
            description: "Файловый сервер",
          },
        ],
        local_available: true,
      },
      "/help-state": { disabled: true, seen: [] },
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
  const module = {
    id,
    module_id: "sftpgo",
    name: "Файловый сервер",
    mode: "local",
    desired_state: "enabled",
    observed_state: "running",
    revision: 5,
    version: "2.7.1",
  };
  return {
    writes,
    reads,
    users,
    groups,
    expireNative: () => {
      nativeExpired = true;
    },
  };
}

async function openAdmin(page: Page) {
  await page.goto(`/#modules?instance=${id}&view=sftpgo`);
  await expect(
    page.getByRole("heading", { name: "Файловый сервер", exact: true }),
  ).toBeVisible();
}

test("SFTP accounts support password and SSH keys independently; an empty edit password is omitted", async ({
  page,
}) => {
  const state = await fixture(page);
  await openAdmin(page);
  await page
    .getByRole("button", { name: "Учётные записи", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Добавить учётную запись", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Новая файловая учётная запись",
  });
  await dialog.getByLabel("Логин SFTP", { exact: true }).fill("office-user");
  await dialog
    .getByLabel("Пароль", { exact: true })
    .fill("synthetic-fixture-password");
  await dialog
    .getByRole("button", { name: "Сохранить учётную запись", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(state.writes[0].body.user).toMatchObject({
    username: "office-user",
    password_enabled: true,
    public_key_enabled: false,
    public_keys: [],
  });
  const row = page.getByRole("row").filter({ hasText: "office-user" });
  await row.getByRole("button", { name: "Изменить", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Учётная запись office-user" });
  await expect(dialog.getByLabel("Новый пароль", { exact: true })).toHaveValue(
    "",
  );
  await dialog.getByLabel("Разрешить вход по SSH-ключу").check();
  await dialog.getByLabel("Публичные SSH-ключи").fill(publicKey);
  await dialog
    .getByRole("button", { name: "Сохранить учётную запись", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const updated = state.writes.filter((write) => write.method === "PUT").at(-1)!
    .body.user;
  expect(updated).not.toHaveProperty("password");
  expect(updated).not.toHaveProperty("has_password");
  expect(updated).toMatchObject({
    password_enabled: true,
    public_key_enabled: true,
    public_keys: [publicKey],
  });
});

test("shared folder permissions and quota are configured through the group without exposing host paths", async ({
  page,
}) => {
  const state = await fixture(page);
  await openAdmin(page);
  await page.getByRole("button", { name: "Группы", exact: true }).click();
  await page
    .getByRole("button", { name: "Создать группу", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Новая группа" });
  await dialog.getByLabel("Название группы").fill("engineering");
  await dialog
    .getByRole("button", { name: "Подключить общую папку", exact: true })
    .click();
  await dialog.getByLabel("Квота папки, байт").fill("-1");
  await dialog
    .getByRole("group", { name: "Права: /team", exact: true })
    .getByLabel("Загрузка", { exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Сохранить группу", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(state.groups[0]).toMatchObject({
    permissions: {
      "/": ["list", "download"],
      "/team": ["list", "download", "upload"],
    },
    virtual_folders: [
      { name: "team", virtual_path: "/team", quota_size: -1, quota_files: 0 },
    ],
  });
  expect(JSON.stringify(state.groups[0])).not.toMatch(
    /home_dir|mapped_path|\/srv\//,
  );
});

test("ordinary users authenticate with their file account and confirm replacement; native permission denial remains visible", async ({
  page,
}) => {
  const state = await fixture(page, { admin: false, deniedUpload: true });
  await page.goto(`/sftpgo/?instance=${id}`);
  await page.getByLabel("Логин файловой учётной записи").fill("file-reader");
  await page
    .getByLabel("Пароль файловой учётной записи")
    .fill("synthetic-file-password");
  await page
    .getByRole("button", { name: "Открыть файлы", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Выйти из файлов", exact: true }),
  ).toBeVisible();
  expect(state.writes[0].body).toEqual({
    username: "file-reader",
    password: "synthetic-file-password",
  });
  await page.getByLabel("Загрузить файл", { exact: true }).setInputFiles({
    name: "report.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("new content"),
  });
  const confirmation = page.getByRole("dialog", {
    name: "Заменить файл «report.txt»?",
  });
  await expect(confirmation).toBeVisible();
  expect(
    state.writes.filter((write) => write.path.endsWith("/files/content")),
  ).toHaveLength(0);
  await confirmation
    .getByRole("button", { name: "Заменить файл", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Файловая учётная запись не разрешает это действие",
  );
  expect(state.writes.at(-1)!.body).toBe("new content");
  expect(
    state.reads.some(
      (path) =>
        /\/(users|groups|folders|settings)$/.test(path) &&
        path.startsWith(prefix),
    ),
  ).toBe(false);
  await expect(
    page.getByRole("button", { name: "Учётные записи", exact: true }),
  ).not.toBeVisible();
});

test("a queued SFTP bind change is never shown as applied when the module job fails", async ({
  page,
}) => {
  const state = await fixture(page, { failedSettings: true });
  await openAdmin(page);
  await page
    .getByRole("button", { name: "Подключение SFTP", exact: true })
    .click();
  await page.getByLabel("Порт SFTP", { exact: true }).fill("2222");
  await page
    .getByRole("button", {
      name: "Применить настройки подключения",
      exact: true,
    })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Выбранный порт уже занят",
  );
  expect(state.writes.at(-1)!.body).toEqual({
    configuration: { listen_ip: "127.0.0.1", port: 2222 },
    expected_revision: 5,
  });
  await expect(
    page.getByText("Настройки подключения применены.", { exact: true }),
  ).not.toBeVisible();
});

test("directory removal requires explicit recursive confirmation and carries its directory flag", async ({
  page,
}) => {
  const state = await fixture(page, { admin: false, authenticated: true });
  await page.goto(`/sftpgo/?instance=${id}`);
  await page
    .getByRole("button", { name: "Удалить archive", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", { name: "Удалить «archive»?" });
  await expect(confirmation).toContainText(
    "Каталог и всё его содержимое будут удалены.",
  );
  expect(
    state.writes.filter((write) => write.method === "DELETE"),
  ).toHaveLength(0);
  await confirmation
    .getByRole("button", { name: "Удалить", exact: true })
    .click();
  await expect(confirmation).not.toBeVisible();
  const removal = state.writes.find((write) => write.method === "DELETE")!;
  expect(removal.path).toBe(prefix + "/files");
  const query = new URLSearchParams(removal.query);
  expect(query.get("path")).toBe("/archive");
  expect(query.get("directory")).toBe("true");
});

for (const [failure, code] of [
  ["list", "sftpgo_authentication_required"],
  ["upload", "sftpgo_authentication_expired"],
  ["download", "sftpgo_authentication_required"],
] as const) {
  test(`expired native ${failure} clears private files while retaining the PL session`, async ({
    page,
  }) => {
    const state = await fixture(page, {
      admin: false,
      authenticated: true,
      nativeAuthFailure: failure,
      nativeAuthCode: code,
    });
    await page.goto(`/sftpgo/?instance=${id}`);
    await expect(page.getByText("report.txt", { exact: true })).toBeVisible();
    const sessions = state.reads.filter((path) => path === "/session").length;
    state.expireNative();
    if (failure === "list")
      await page.getByRole("button", { name: "Обновить", exact: true }).click();
    else if (failure === "upload")
      await page
        .getByLabel("Загрузить файл", { exact: true })
        .setInputFiles({
          name: "new.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("new"),
        });
    else
      await page
        .getByRole("button", { name: "Скачать report.txt", exact: true })
        .click();
    await expect(
      page.getByRole("button", { name: "Открыть файлы", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("report.txt", { exact: true }),
    ).not.toBeVisible();
    await expect(page.getByRole("alert")).toContainText(
      "Войдите в файловый сервер заново",
    );
    expect(state.reads.filter((path) => path === "/session")).toHaveLength(
      sessions,
    );
    await page
      .getByLabel("Логин файловой учётной записи")
      .fill("fresh-account");
    await page
      .getByLabel("Пароль файловой учётной записи")
      .fill("synthetic-new-password");
    await page
      .getByRole("button", { name: "Открыть файлы", exact: true })
      .click();
    await expect(page.getByText("fresh.txt", { exact: true })).toBeVisible();
    await expect(
      page.getByText("report.txt", { exact: true }),
    ).not.toBeVisible();
    expect(state.writes.at(-1)!.headers["x-csrf-token"]).toBe(
      "sftpgo-fixture-csrf",
    );
  });
}
