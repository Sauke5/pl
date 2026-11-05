import { expect, it } from "vite-plus/test";
import {
  buildTaskImport,
  importFileLimit,
  parseTaskImport,
} from "./task-import-parser";
const sample = {
  title: "Серверная",
  description: "План\n- Проверить\n**Готово**",
  status: "to-do",
  priority: "high",
  startDate: "2026-10-26T00:00:00.000Z",
  dueDate: "2026-10-28T00:00:00.000Z",
  userId: "user@example.com",
};
it("preserves descriptions and written calendar dates while explicitly mapping status and placeholder user", () => {
  const parsed = parseTaskImport(
    JSON.stringify({
      tasks: Array.from({ length: 23 }, (_, i) => ({
        ...sample,
        title: `${i + 1}. Серверная`,
      })),
    }),
  );
  expect(parsed.tasks).toHaveLength(23);
  expect(parsed.statuses).toEqual(["to-do"]);
  expect(parsed.assignees).toEqual(["user@example.com"]);
  const result = buildTaskImport(
    parsed.tasks,
    { "to-do": "planned" },
    { "user@example.com": null },
  );
  expect(result[0]).toMatchObject({
    title: "1. Серверная",
    description: sample.description,
    columnId: "planned",
    priority: "high",
    startDate: "2026-10-26",
    due: { date: "2026-10-28" },
    userId: null,
  });
  expect(result[0]?.due).not.toHaveProperty("time");
  expect(result[0]).not.toHaveProperty("status");
  expect(result[22]?.title).toBe("23. Серверная");
});
it("validates limits before parsing and accepts 500 tasks", () => {
  expect(() => parseTaskImport("x".repeat(importFileLimit + 1))).toThrowError(
    "file_too_large",
  );
  expect(
    parseTaskImport(
      JSON.stringify({ tasks: Array.from({ length: 500 }, () => sample) }),
    ).tasks,
  ).toHaveLength(500);
  for (const count of [0, 501])
    expect(() =>
      parseTaskImport(
        JSON.stringify({ tasks: Array.from({ length: count }, () => sample) }),
      ),
    ).toThrowError("task_count");
});
it.each([
  [{ title: "" }, "invalid_title", "title"],
  [{ priority: ["high"] }, "invalid_priority", "priority"],
  [{ dueDate: "2026-02-30T00:00:00.000Z" }, "invalid_date", "dueDate"],
  [{ dueDate: "2026-10-20" }, "date_order", "dueDate"],
  [{ description: 42 }, "invalid_description", "description"],
  [{ checklists: [] }, "unknown_field", "checklists"],
  [{ userId: 42 }, "invalid_assignee", "userId"],
])(
  "preserves recoverable values and reports their original location: %j",
  (patch, code, field) => {
    const result = parseTaskImport(
      JSON.stringify({ tasks: [sample, { ...sample, ...patch }] }),
    );
    expect(result.tasks).toHaveLength(2);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code, row: 2, field }),
      ]),
    );
  },
);

it("rejects malformed root and JSON and supports UTF8 BOM", () => {
  expect(() => parseTaskImport("{")).toThrowError("invalid_json");
  expect(() => parseTaskImport(JSON.stringify([sample]))).toThrowError(
    "invalid_root",
  );
  expect(
    parseTaskImport("\uFEFF" + JSON.stringify({ tasks: [{ title: "One" }] }))
      .tasks[0],
  ).toMatchObject({ status: "to-do", priority: "no-priority" });
});
it("preserves unresolved mappings and handles prototype-named statuses", () => {
  const tasks = parseTaskImport(JSON.stringify({ tasks: [sample] })).tasks;
  expect(buildTaskImport(tasks, {}, {})[0]).toMatchObject({
    columnId: "",
    userId: "user@example.com",
  });
  const proto = parseTaskImport(
    '{"tasks":[{"title":"X","status":"__proto__"}]}',
  ).tasks;
  expect(buildTaskImport(proto, {}, {})[0]?.columnId).toBe("");
  expect(
    buildTaskImport(
      proto,
      Object.fromEntries([["__proto__", "planned"]]),
      {},
    )[0]?.columnId,
  ).toBe("planned");
});
it("keeps invalid dates, priorities and source values visible for editing", () => {
  const parsed = parseTaskImport(
    JSON.stringify({
      tasks: [
        {
          title: 42,
          dueDate: "bad date",
          priority: "Critical",
          extra: { value: 1 },
        },
        42,
      ],
    }),
  );
  expect(parsed.tasks[0]).toMatchObject({
    title: "42",
    dueDate: "bad date",
    priority: "Critical",
  });
  expect(parsed.tasks[1]).toMatchObject({ title: "", description: "42" });
  expect(parsed.issues).toContainEqual({
    row: 1,
    field: "extra",
    code: "unknown_field",
    value: '{"value":1}',
  });
});
