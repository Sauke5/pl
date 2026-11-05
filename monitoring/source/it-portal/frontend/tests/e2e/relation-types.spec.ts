import { expect, test } from "@playwright/test";
import { settingsWorkspaceFixture } from "../fixtures/settingsWorkspace";

test("missing relation types get local suggestions and can be explicitly cleared", async ({
  page,
}) => {
  const state = await settingsWorkspaceFixture(page);
  await page.goto("/#settings");
  await page
    .getByRole("navigation", { name: "Разделы настроек" })
    .getByRole("button", { name: "Справочники", exact: true })
    .click();

  const field = page.getByLabel("Типы связей", { exact: true });
  await expect(field).toHaveValue(
    "Размещено на\nИспользует БД\nЗависит от\nРезервируется на",
  );
  await expect(
    page.getByText("Изменения не меняют уже сохранённые связи ресурсов.", {
      exact: false,
    }),
  ).toBeVisible();

  await field.fill("");
  await page.getByRole("heading", { name: "Справочники", exact: true }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();

  const request = state.requests.findLast(
    (entry) =>
      entry.method === "PUT" &&
      entry.path === "/settings-workspace/dictionaries",
  );
  expect(request?.body?.relation_types).toEqual([]);
  expect(state.dictionaries.relation_types).toEqual([]);
});

test("resource relations suggest dictionary values without restricting custom labels", async ({
  page,
}) => {
  await settingsWorkspaceFixture(page);
  await page.goto("/#catalog");
  await page
    .getByRole("button", { name: "Добавить ресурс", exact: true })
    .first()
    .click();

  const dialog = page.getByRole("dialog");
  await dialog
    .getByText("Endpoints, документация и связи", { exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Добавить связь", exact: true })
    .click();

  const label = dialog.getByLabel("Характер связи", { exact: true });
  await expect(label).toHaveAttribute("list", "resource-relation-types");
  await expect(dialog.locator("#resource-relation-types option")).toHaveCount(
    4,
  );
  await label.fill("Старая произвольная связь");
  await expect(label).toHaveValue("Старая произвольная связь");
});
