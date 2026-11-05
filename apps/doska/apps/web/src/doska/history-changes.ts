import type { HistoryItem } from "./api";
import { type CustomField, selectedOptions } from "./custom-fields";

type Translate = (key: string) => string;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const labels: Record<string, string> = {
  title: "taskTitle",
  description: "description",
  priority: "priority",
  cardColor: "cardColor",
  labels: "taskLabels",
  customValues: "customFields",
  columnId: "column",
  userId: "responsible",
  coexecutorIds: "coexecutors",
  startDate: "startDate",
  dueDate: "dueDate",
  dueDateHasTime: "historyDueTime",
  parentTaskId: "historyParent",
  semanticState: "historySemanticState",
  content: "commentNew",
  mentionIds: "commentMention",
  text: "checklistItemText",
  done: "historyDone",
  items: "historyChecklistItems",
};

export function historyChanges(
  item: HistoryItem,
  t: Translate,
  fields: CustomField[] = [],
) {
  const data = object(item.eventData);
  const before = object(data.before),
    after = object(data.after);
  const format = (key: string, value: unknown): string => {
    if (key === "labels" && Array.isArray(value))
      return (
        value
          .map((item) => object(item).name)
          .filter((name) => typeof name === "string")
          .join(", ") || t("historyEmptyValue")
      );
    if (key === "cardColor") return t(`cardColor_${value ?? "default"}`);
    if (key === "customValues" && Array.isArray(value) && !value.length)
      return t("historyEmptyValue");
    if (key === "customValues" && Array.isArray(value))
      return value
        .map((raw) => {
          const entry = object(raw);
          const field = fields.find(
            (definition) => definition.id === entry.fieldId,
          );
          const label = field?.name ?? t("customFieldUnavailable");
          if (
            !field ||
            entry.value === null ||
            entry.value === undefined ||
            entry.value === ""
          )
            return `${label}: ${t("historyEmptyValue")}`;
          const rawValue = String(entry.value);
          const text =
            field.type === "user"
              ? format("userId", rawValue)
              : field.type === "boolean"
                ? t(rawValue === "true" ? "historyYes" : "historyNo")
                : field.type === "multiselect"
                  ? selectedOptions(rawValue).join(", ")
                  : rawValue;
          return `${label}: ${text}`;
        })
        .join("\n");
    if (
      value === null ||
      value === undefined ||
      value === "" ||
      (Array.isArray(value) && !value.length)
    )
      return t("historyEmptyValue");
    if (key === "userId" && typeof value === "string")
      return (
        item.references?.users.find((user) => user.id === value)?.name ??
        t("historyFormerUser")
      );
    if (
      (key === "coexecutorIds" || key === "mentionIds") &&
      Array.isArray(value)
    )
      return value.map((id) => format("userId", id)).join(", ");
    if (key === "columnId" && typeof value === "string")
      return (
        item.references?.columns.find((column) => column.id === value)?.name ??
        t("historyDeletedColumn")
      );
    if (key === "parentTaskId" && typeof value === "string") {
      const task = item.references?.tasks.find((task) => task.id === value);
      return task
        ? `${task.number === null ? "" : `#${task.number} `}${task.title}`
        : t("historyDeletedTask");
    }
    if (key === "priority" && typeof value === "string")
      return t(`priority_${value}`);
    if (key === "semanticState" && typeof value === "string")
      return t(`columnState_${value}`);
    if (typeof value === "boolean")
      return t(value ? "historyYes" : "historyNo");
    if (
      (key === "startDate" || key === "dueDate") &&
      typeof value === "string"
    ) {
      const date = new Date(value);
      return Number.isNaN(date.getTime())
        ? t("historyEmptyValue")
        : date.toLocaleString("ru-RU", {
            timeZone: "Europe/Moscow",
            dateStyle: "short",
            ...(key === "dueDate" ? { timeStyle: "short" as const } : {}),
          });
    }
    if (key === "items" && Array.isArray(value))
      return value
        .map((raw) => {
          const row = object(raw);
          return `${row.done ? "✓" : "○"} ${typeof row.text === "string" ? row.text : ""}`;
        })
        .join("\n");
    return typeof value === "string" || typeof value === "number"
      ? String(value)
      : t("historyEmptyValue");
  };
  return Object.entries(labels)
    .filter(
      ([key]) =>
        (key in before || key in after) &&
        JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    )
    .map(([key, label]) => ({
      key,
      label: t(
        key === "userId" && item.type?.startsWith("doska.task.comment.")
          ? "historyCommentAuthor"
          : key === "title" && item.type?.startsWith("doska.task.checklist.")
            ? "checklistName"
            : label,
      ),
      before: format(key, before[key]),
      after: format(key, after[key]),
    }));
}
