import { describe, expect, it } from "vite-plus/test";
import type { HistoryItem } from "./api";
import { historyChanges } from "./history-changes";
const t = (key: string) => key;
const event = (before: object, after: object) =>
  ({
    id: "event",
    taskId: "task",
    type: "doska.task.updated",
    userId: "u",
    authorName: "Иван",
    createdAt: "2026-10-23T00:00:00Z",
    eventData: { before, after },
    references: {
      users: [{ id: "u", name: "Иван" }],
      columns: [{ id: "c", name: "В работе" }],
      tasks: [{ id: "p", number: 12, title: "Настройка" }],
    },
  }) as HistoryItem;
describe("readable task history", () => {
  it("resolves people, columns and parent tasks without displaying internal IDs", () => {
    const result = historyChanges(
      event(
        {},
        {
          userId: "u",
          coexecutorIds: ["gone"],
          columnId: "c",
          parentTaskId: "p",
        },
      ),
      t,
    );
    expect(result.map((row) => row.after)).toEqual([
      "В работе",
      "Иван",
      "historyFormerUser",
      "#12 Настройка",
    ]);
  });
  it("retains deleted comment text and ignores internal fields", () => {
    expect(
      historyChanges(
        event(
          { content: "Готово", revision: 1 },
          { content: null, revision: 2, privateToken: "never" },
        ),
        t,
      ),
    ).toEqual([
      {
        key: "content",
        label: "commentNew",
        before: "Готово",
        after: "historyEmptyValue",
      },
    ]);
  });
  it("shows checklist completion and skips unchanged fields", () => {
    expect(
      historyChanges(
        event(
          { done: false, text: "Проверить" },
          { done: true, text: "Проверить" },
        ),
        t,
      ),
    ).toEqual([
      {
        key: "done",
        label: "historyDone",
        before: "historyNo",
        after: "historyYes",
      },
    ]);
  });
});

it("names card colors and represents reset as the default color", () => {
  expect(
    historyChanges(event({ cardColor: "purple" }, { cardColor: null }), t),
  ).toEqual([
    {
      key: "cardColor",
      label: "cardColor",
      before: "cardColor_purple",
      after: "cardColor_default",
    },
  ]);
});

it("renders custom field names and values without exposing employee or field IDs", () => {
  const fields = [
    {
      id: "employee-field",
      name: "Reviewer",
      type: "user" as const,
      required: false,
      defaultValue: null,
      options: null,
      position: 0,
      archivedAt: null,
    },
    {
      id: "bool-field",
      name: "Approved",
      type: "boolean" as const,
      required: false,
      defaultValue: null,
      options: null,
      position: 1,
      archivedAt: null,
    },
  ];
  const changes = historyChanges(
    event(
      { customValues: [] },
      {
        customValues: [
          { fieldId: "employee-field", value: "u" },
          { fieldId: "bool-field", value: "false" },
          { fieldId: "gone-field", value: "private-id" },
        ],
      },
    ),
    t,
    fields,
  );
  expect(changes[0].after).toBe(
    "Reviewer: Иван\nApproved: historyNo\ncustomFieldUnavailable: historyEmptyValue",
  );
});

it("renders labels by name and empty replacement in history", () => {
  expect(
    historyChanges(
      event({ labels: [{ name: "Сеть", color: "blue" }] }, { labels: [] }),
      t,
    ),
  ).toEqual([
    {
      key: "labels",
      label: "taskLabels",
      before: "Сеть",
      after: "historyEmptyValue",
    },
  ]);
});
