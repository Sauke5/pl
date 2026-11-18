import { expect, test, type Page } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const instance = "af14ed26-20a9-4f99-8b6d-704f8c86425d";
const workshop = "a".repeat(64),
  office = "b".repeat(64);
const path = "/modules/" + instance + "/f12/";
const partSize = 4 * 1024 * 1024;
const size = partSize + 11;

// WebKit does not expose the body of a sliced File to request.postDataBuffer().
// Receive the upload on the browser's own loopback origin and check its real bytes.
async function uploadPreview(page: Page, baseURL: string) {
  const received: { offset: number; bytes: number; intact: boolean }[] = [];
  const server = createServer(async (req, res) => {
    const match = /\/uploads\/([0-9a-f-]+)\/chunks\/(\d+)$/.exec(req.url ?? "");
    if (req.method !== "PUT" || !match) {
      res.writeHead(404).end();
      return;
    }
    const [, id, start] = match;
    const offset = Number(start);
    let bytes = 0,
      intact = true;
    try {
      for await (const data of req) {
        const chunk: Buffer = data;
        bytes += chunk.length;
        intact &&= chunk.every((byte) => byte === 3);
      }
    } catch {
      res.destroy();
      return;
    }
    received.push({ offset, bytes, intact });
    if (received.length === 1) {
      // An empty socket reset can trigger a private HTTP retry in Chromium.
      // Break the acknowledgement after headers so the F12 client sees the failure.
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": "128",
      });
      res.write("{", () => res.destroy());
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id, offset: offset + bytes }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  try {
    await page.route(
      (url) => url.origin === origin && !url.pathname.startsWith("/api/"),
      async (route) => {
        const url = new URL(route.request().url());
        const response = await route.fetch({
          url: new URL(url.pathname + url.search, baseURL).href,
        });
        await route.fulfill({ response });
      },
    );
    return { origin, received, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function fixture(
  page: Page,
  {
    refuse = false,
    prepared,
    uploadOrigin,
  }: {
    refuse?: boolean;
    prepared?: { name: string; recipe: string; compatibility: string };
    uploadOrigin?: string;
  } = {},
) {
  const image = {
    id: "c".repeat(64),
    name: "rescue.iso",
    size,
    segments: [workshop],
    recipe: "systemrescue-http",
    compatibility: "SystemRescue",
    filesystem: "ISO9660",
    ...prepared,
  };
  const starts: string[] = [],
    chunks: number[] = [];
  let processed = 0,
    finished = !!prepared,
    cancellations = 0;
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      u = new URL(req.url()),
      p = u.pathname.replace("/api/v1", "");
    const ok = (data: unknown, status = 200) =>
      route.fulfill({ status, json: data });
    if (p === path + "library")
      return ok({
        items: finished ? [image] : [],
        segments: { [workshop]: "Мастерская", [office]: "Офис" },
        boot_urls: { [workshop]: "http://192.0.2.10:18080/menu.ipxe" },
      });
    if (p === path + "menu") {
      const segment = u.searchParams.get("segment");
      return ok({
        segment,
        items:
          finished && image.segments.includes(segment || "")
            ? [{ id: image.id, name: image.name, recipe: image.recipe }]
            : [],
      });
    }
    if (p === path + "images/" + image.id + "/networks") {
      expect(req.method()).toBe("PUT");
      expect(Object.keys(req.postDataJSON())).toEqual(["segments"]);
      image.segments = req.postDataJSON().segments;
      return ok(image);
    }
    if (p.startsWith(path + "uploads/")) {
      expect(req.headers()["x-csrf-token"]).toBe("f12-fixture");
      const [id, action, offset] = p
        .slice((path + "uploads/").length)
        .split("/");
      if (req.method() === "DELETE") {
        cancellations++;
        return ok(
          { error: "f12_request_failed", message: "Загрузка не найдена" },
          404,
        );
      }
      if (!action) {
        starts.push(id);
        if (refuse)
          return ok(
            {
              error: "f12_request_failed",
              message: "Другая загрузка уже выполняется.",
            },
            409,
          );
        expect(req.postDataJSON()).toEqual({
          name: "rescue.iso",
          size,
          segments: [workshop],
        });
        return ok({ id, offset: 0 });
      }
      expect(starts).toContain(id);
      if (action === "chunks") {
        expect(u.origin).toBe(uploadOrigin);
        expect(req.headers()["content-type"]).toBe("application/octet-stream");
        chunks.push(Number(offset));
        return route.continue();
      }
      if (action === "complete") {
        if (processed++ === 0)
          return ok({ id, offset: size, status: "processing" }, 202);
        finished = true;
        return ok(image);
      }
    }
    const common: Record<string, unknown> = {
      "/session": {
        authenticated: true,
        user: { id: "fixture-admin", name: "Администратор", admin: true },
        csrf_token: "f12-fixture",
        features: {},
      },
      "/help-state": { disabled: true, seen: [] },
      "/preferences": {
        favorites: [],
        hidden_sections: [],
        section_order: [],
        home_widgets: [],
      },
      "/delivery": { modules: [], core_api: 1 },
      "/modules": {
        items: [
          {
            id: instance,
            module_id: "f12",
            name: "Сетевая загрузка F12",
            mode: "local",
            desired_state: "enabled",
            observed_state: "running",
            revision: 1,
          },
        ],
      },
      "/modules/catalog": {
        local_available: true,
        items: [
          {
            id: "f12",
            name: "Сетевая загрузка F12",
            description: "Библиотека ISO",
            version: "0.1.81",
            modes: ["local"],
          },
        ],
      },
    };
    return ok(common[p] ?? []);
  });
  return { starts, chunks, cancellations: () => cancellations };
}
async function selectISO(page: Page, origin = "") {
  await page.goto(origin + "/#module-catalog");
  await page.getByRole("link", { name: "Открыть библиотеку ISO" }).click();
  await page.getByRole("button", { name: "Добавить ISO" }).click();
  const d = page.getByRole("dialog", { name: "Добавить ISO" });
  await d.getByLabel("Файл образа", { exact: false }).setInputFiles({
    name: "rescue.iso",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(size, 3),
  });
  await d.getByRole("checkbox", { name: "Мастерская" }).check();
  await d.getByRole("button", { name: "Загрузить ISO" }).click();
  return d;
}

test("После обрыва повторяется та же часть ISO, затем загрузочное меню показывает сети публикации", async ({
  page,
  baseURL,
}) => {
  const preview = await uploadPreview(page, baseURL!);
  try {
    const f = await fixture(page, { uploadOrigin: preview.origin });
    await selectISO(page, preview.origin);
    await expect(
      page.getByRole("button", { name: "rescue.iso" }),
    ).toBeVisible();
    expect(preview.received).toEqual([
      { offset: 0, bytes: partSize, intact: true },
      { offset: 0, bytes: partSize, intact: true },
      { offset: partSize, bytes: 11, intact: true },
    ]);
    expect(f.chunks).toEqual([0, 0, partSize]);
    expect(f.starts).toHaveLength(1);
    await page.getByRole("button", { name: "Меню загрузки" }).click();
    const d = page.getByRole("dialog", { name: "Меню загрузки" });
    await d.getByRole("combobox").selectOption(workshop);
    await expect(d.getByRole("listitem")).toHaveText("rescue.iso");
    await d.getByText("Как компьютер получает меню").click();
    await expect(
      d.getByText("http://192.0.2.10:18080/menu.ipxe"),
    ).toBeVisible();
    await d.getByRole("combobox").selectOption(office);
    await expect(d.getByText("В этой сети пока нет образов")).toBeVisible();
  } finally {
    await preview.close();
  }
});

test("После публикации PL показывает готовность PXE по выбранной сети", async ({
  page,
}) => {
  await fixture(page);
  const pxe = { [workshop]: "waiting", [office]: "idle" };
  await page.route("**/f12/library", (route) =>
    route.fulfill({
      json: {
        items: [],
        segments: { [workshop]: "Мастерская", [office]: "Офис" },
        boot_urls: { [workshop]: "http://192.0.2.10:18080/menu.ipxe" },
        pxe,
      },
    }),
  );
  await page.goto("/#module-catalog");
  await page.getByRole("link", { name: "Открыть библиотеку ISO" }).click();
  await page.getByRole("button", { name: "Добавить ISO" }).click();
  const upload = page.getByRole("dialog", { name: "Добавить ISO" });
  await upload.getByRole("checkbox", { name: "Мастерская" }).check();
  await expect(
    upload.getByText(/PL сама включает сетевую загрузку/),
  ).toBeVisible();
  await upload.getByRole("button", { name: "Отмена" }).click();

  await page.getByRole("button", { name: "Меню загрузки" }).click();
  const menu = page.getByRole("dialog", { name: "Меню загрузки" });
  const network = menu.getByRole("combobox");
  await network.selectOption(office);
  await expect(
    menu.getByText(/включится после публикации первого/),
  ).toBeVisible();
  await network.selectOption(workshop);
  await expect(menu.getByText(/PL готовит сетевую загрузку/)).toBeVisible();
  pxe[workshop] = "active";
  pxe[office] = "error";
  await expect(menu.getByText(/Сетевая загрузка PL работает/)).toBeVisible({
    timeout: 8000,
  });
  await expect(menu.getByText("Как компьютер получает меню")).toHaveCount(0);
  await network.selectOption(office);
  await expect(
    menu.getByText(/занятость UDP-портов 67, 69 и 4011/),
  ).toBeVisible();
});

test("Сеть со своей PXE-службой показывает адрес меню и условия публикации", async ({
  page,
}) => {
  await fixture(page);
  const url = "http://198.51.100.10:18080/menu.ipxe";
  await page.route("**/f12/library", (route) =>
    route.fulfill({
      json: {
        items: [],
        segments: { [workshop]: "Мастерская", [office]: "Офис" },
        boot_urls: { [office]: url },
        pxe: { [workshop]: "idle", [office]: "manual" },
      },
    }),
  );
  await page.goto("/#modules?instance=" + instance + "&view=f12");
  await page.getByRole("button", { name: "Добавить ISO" }).click();
  const upload = page.getByRole("dialog", { name: "Добавить ISO" });
  await upload.getByRole("checkbox", { name: /Офис.*Своя PXE-служба/ }).check();
  await expect(
    upload.getByText(/Для запуска через свою PXE-службу/),
  ).toBeVisible();
  await expect(
    upload.getByText(/PL сама включает сетевую загрузку/),
  ).toHaveCount(0);
  await upload.getByRole("checkbox", { name: "Мастерская" }).check();
  await expect(
    upload.getByText(/Для сетей со своей PXE-службой используйте адрес/),
  ).toBeVisible();
  await upload.getByRole("button", { name: "Отмена" }).click();
  await page.getByRole("button", { name: "Меню загрузки" }).click();
  const menu = page.getByRole("dialog", { name: "Меню загрузки" });
  await menu.getByRole("combobox").selectOption(office);
  await expect(
    menu.getByText(/Автоматическая загрузка для этой сети недоступна/),
  ).toBeVisible();
  await expect(menu.getByText(url, { exact: true })).toBeVisible();
});

test("Официальный сайт ISO открывается отдельно и сохраняет выбор в форме", async ({
  page,
  context,
}) => {
  const { starts } = await fixture(page);
  const links = [
    ["WinPE от Сергея Стрельца", "https://sergeistrelec.name/winpe_10_8/"],
    ["Hiren’s BootCD PE", "https://www.hirensbootcd.org/download/"],
    ["SystemRescue", "https://www.system-rescue.org/Download/"],
    ["Ubuntu Server 24.04 LTS", "https://releases.ubuntu.com/24.04/"],
  ];
  const external: string[] = [];
  for (const [, url] of links) {
    await context.route(url, (route) => {
      external.push(route.request().url());
      return route.fulfill({
        contentType: "text/plain",
        body: "Страница загрузки",
      });
    });
  }
  await page.goto("/#module-catalog");
  await page.getByRole("link", { name: "Открыть библиотеку ISO" }).click();
  await page.getByRole("button", { name: "Добавить ISO" }).click();
  const dialog = page.getByRole("dialog", { name: "Добавить ISO" });
  const file = dialog.getByLabel("Файл образа", { exact: false });
  await file.setInputFiles({
    name: "Выбранный образ.iso",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(2048),
  });
  const network = dialog.getByRole("checkbox", { name: "Мастерская" });
  await network.check();
  await dialog.getByText("Где скачать ISO", { exact: true }).click();
  for (const [name, url] of links) {
    const link = dialog.getByRole("link", { name });
    await expect(link).toHaveAttribute("href", url);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
    await expect(link).toHaveAttribute("rel", /noreferrer/);
  }
  expect(external).toEqual([]);
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    dialog.getByRole("link", { name: links[0][0] }).click(),
  ]);
  await expect(popup).toHaveURL(links[0][1]);
  await popup.close();
  expect(external).toEqual([links[0][1]]);
  await expect(dialog).toBeVisible();
  await expect(file).toHaveValue(/Выбранный образ\.iso$/);
  await expect(network).toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "Загрузить ISO" }),
  ).toBeEnabled();
  expect(starts).toHaveLength(0);
});

test("У Hiren’s видна совместимость при выборе ISO и сети публикации", async ({
  page,
}) => {
  const name = "Восстановление офиса.iso";
  await fixture(page, {
    prepared: {
      name,
      recipe: "hirens-winpe-x64",
      compatibility: "Hiren’s BootCD PE · UEFI x64",
    },
  });
  await page.goto("/#module-catalog");
  await page.getByRole("link", { name: "Открыть библиотеку ISO" }).click();
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name, exact: true }) });
  await expect(row.getByText("UEFI x64", { exact: true })).toBeVisible();
  await row.getByRole("button", { name, exact: true }).click();
  const card = page.getByRole("dialog", { name, exact: true });
  await expect(card.getByText(/Для компьютеров с UEFI x64/)).toBeVisible();
  await expect(
    card.getByText(
      /Основные программы доступны на сетевом диске только для чтения/,
    ),
  ).toBeVisible();
  await expect(card.getByRole("textbox")).toHaveCount(0);
  await card.getByRole("checkbox", { name: "Мастерская" }).uncheck();
  await card.getByRole("checkbox", { name: "Офис" }).check();
  await card.getByRole("button", { name: "Сохранить сети" }).click();
  await expect(
    row.getByRole("cell", { name: "Офис", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Меню загрузки" }).click();
  const menu = page.getByRole("dialog", { name: "Меню загрузки" });
  await menu.getByRole("combobox").selectOption(workshop);
  await expect(menu.getByText("В этой сети пока нет образов")).toBeVisible();
  await menu.getByRole("combobox").selectOption(office);
  const item = menu.getByRole("listitem").filter({ hasText: name });
  await expect(item.getByText("UEFI x64", { exact: true })).toBeVisible();
});

test("Карточка Стрельца объясняет выбор версии WinPE в меню компьютера", async ({
  page,
}) => {
  const name = "WinPE11_10_8_Sergei_Strelec_x86_x64_2026.11.06_Russian.iso";
  await fixture(page, {
    prepared: {
      name,
      recipe: "strelec-winpe",
      compatibility: "WinPE Sergei Strelec · BIOS и UEFI x64",
    },
  });
  await page.goto("/#module-catalog");
  await page.getByRole("link", { name: "Открыть библиотеку ISO" }).click();
  const image = page.getByRole("button", { name, exact: true });
  await expect(
    page.getByRole("row").filter({ has: image }).getByText("BIOS и UEFI x64"),
  ).toBeVisible();
  await image.click();
  const card = page.getByRole("dialog", { name });
  await expect(
    card.getByText(/При загрузке выберите версию WinPE из этого образа/),
  ).toBeVisible();
  expect(
    await card.evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);
  await card
    .getByRole("button", { name: "Закрыть", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "Меню загрузки" }).click();
  const menu = page.getByRole("dialog", { name: "Меню загрузки" });
  await menu.getByRole("combobox").selectOption(workshop);
  await expect(
    menu
      .getByRole("listitem")
      .filter({ hasText: name })
      .getByText("BIOS и UEFI x64"),
  ).toBeVisible();
  expect(
    await menu.evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);
});

test("После отказа запуска администратор может закрыть загрузку и вернуться к библиотеке", async ({
  page,
}) => {
  const f = await fixture(page, { refuse: true });
  const d = await selectISO(page);
  await expect(d.getByText("Другая загрузка уже выполняется.")).toBeVisible();
  await d.getByRole("button", { name: "Отменить загрузку" }).click();
  await expect(d).toBeHidden();
  expect(f.cancellations()).toBe(1);
  expect(f.chunks).toEqual([]);
});

test("После повторного входа на страницу можно освободить место даже при ошибке подготовки полного ISO", async ({
  page,
}) => {
  await fixture(page);
  const id = "27df4772-bc5e-4cf8-a72f-9e525f1b3c40";
  let pending = true,
    cancelled = false;
  await page.route("**/f12/library", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "d".repeat(64),
            name: "archive.iso",
            size: 65536,
            recipe: "bios-iso",
            segments: ["f".repeat(64)],
            compatibility: "Legacy BIOS",
            filesystem: "ISO9660",
          },
        ],
        segments: {},
        boot_urls: {},
        pending: pending
          ? { id, name: "rescue.iso", size, offset: size, state: "active" }
          : undefined,
      },
    }),
  );
  await page.route("**/f12/uploads/" + id + "/complete", (route) =>
    route.fulfill({
      status: 507,
      json: {
        error: "f12_request_failed",
        message: "Недостаточно места для подготовки ISO.",
      },
    }),
  );
  await page.route("**/f12/uploads/" + id, (route) => {
    expect(route.request().method()).toBe("DELETE");
    cancelled = true;
    pending = false;
    return route.fulfill({ json: { id, status: "cancelled" } });
  });
  await page.goto("/#modules?instance=" + instance + "&view=f12");
  const row = page.getByRole("row").filter({ hasText: "archive.iso" });
  await expect(row.getByText("Опубликован")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Добавить ISO" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Проверить готовность" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Недостаточно места для подготовки ISO.",
  );
  await page.getByRole("button", { name: "Отменить загрузку" }).click();
  await expect(
    page.getByRole("button", { name: "Добавить ISO" }),
  ).toBeEnabled();
  expect(cancelled).toBe(true);
});
