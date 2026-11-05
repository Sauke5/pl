import { useTranslation } from "react-i18next";
import type { TemplatePreview } from "./api";
import "./templates.css";
function keyed<T>(items: readonly T[], label: (item: T) => string) {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const value = label(item);
    const occurrence = occurrences.get(value) ?? 0;
    occurrences.set(value, occurrence + 1);
    return { item, key: `${value}:${occurrence}` };
  });
}
export function TemplateComposition({
  snapshot,
  includeTasks = true,
}: {
  snapshot: TemplatePreview["snapshot"];
  includeTasks?: boolean;
}) {
  const { t } = useTranslation("doska");
  return (
    <section
      className="doska-template-composition"
      aria-label={t("templateComposition")}
    >
      <h3>{t("templateComposition")}</h3>
      <p>{snapshot.columns.map((column) => column.name).join(" · ")}</p>
      {!!snapshot.customFields?.length && (
        <div>
          <h4>{t("templateCustomFields")}</h4>
          <ul>
            {snapshot.customFields.map((field) => (
              <li key={field.key}>
                {field.name} · {t(`templateFieldType_${field.type}`)}
                {field.required ? ` · ${t("templateRequired")}` : ""}
                {field.defaultValue != null
                  ? ` · ${t("templateDefault")}: ${field.defaultValue}`
                  : ""}
                {field.options?.length ? ` (${field.options.join(", ")})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {includeTasks && (
        <ul>
          {snapshot.tasks.map((task) => (
            <li key={task.key}>
              <span>{task.title}</span>
              {task.parentKey && (
                <p className="doska-meta">
                  {t("templateParentTask")}:{" "}
                  {
                    snapshot.tasks.find(
                      (parent) => parent.key === task.parentKey,
                    )?.title
                  }
                </p>
              )}
              {task.description && (
                <details className="doska-template-description">
                  <summary>{t("description")}</summary>
                  <p>{task.description}</p>
                </details>
              )}
              {!!task.labels?.length && (
                <p className="doska-meta">
                  {task.labels.map((label) => label.name).join(" · ")}
                </p>
              )}
              {!!task.customValues?.length && (
                <ul>
                  {task.customValues.map((value) => (
                    <li key={value.fieldKey}>
                      {snapshot.customFields?.find(
                        (field) => field.key === value.fieldKey,
                      )?.name ?? t("templateCustomField")}
                      : {value.value ?? "—"}
                    </li>
                  ))}
                </ul>
              )}
              {task.checklists.length > 0 && (
                <ul>
                  {keyed(task.checklists, (list) => list.title).map(
                    ({ item: list, key }) => (
                      <li key={key}>
                        {list.title}
                        <ul>
                          {keyed(list.items, (item) => item.text).map(
                            ({ item, key }) => (
                              <li key={key}>{item.text}</li>
                            ),
                          )}
                        </ul>
                      </li>
                    ),
                  )}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {includeTasks && snapshot.relations.length > 0 && (
        <details className="doska-template-relations">
          <summary>{t("templateRelations")}</summary>
          <ul>
            {snapshot.relations.map((relation) => (
              <li
                key={`${relation.type}:${relation.sourceKey}:${relation.targetKey}`}
              >
                {
                  snapshot.tasks.find((task) => task.key === relation.sourceKey)
                    ?.title
                }{" "}
                — {t(`templateRelation_${relation.type}`)} —{" "}
                {
                  snapshot.tasks.find((task) => task.key === relation.targetKey)
                    ?.title
                }
              </li>
            ))}
          </ul>
        </details>
      )}
      {includeTasks && !snapshot.tasks.length && (
        <p className="doska-meta">{t("templateStructureOnly")}</p>
      )}
    </section>
  );
}
