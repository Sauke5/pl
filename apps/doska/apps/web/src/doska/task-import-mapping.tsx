import { useTranslation } from "react-i18next";
import type { Column } from "./api";
export function TaskImportMapping({
  statuses,
  assignees,
  columns,
  people,
  columnMapping,
  userMapping,
  onColumn,
  onUser,
}: {
  statuses: string[];
  assignees: string[];
  columns: Column[];
  people: { userId: string; name: string }[];
  columnMapping: Record<string, string>;
  userMapping: Record<string, string | null>;
  onColumn: (status: string, id: string) => void;
  onUser: (source: string, id: string | null) => void;
}) {
  const { t } = useTranslation("doska");
  return (
    <div className="doska-import-mapping">
      <section>
        <h3>{t("importColumns")}</h3>
        {statuses.map((status) => (
          <label className="doska-field" key={status}>
            {status}
            <select
              aria-label={t("importColumnFor", { status })}
              value={columnMapping[status] ?? ""}
              onChange={(event) => onColumn(status, event.target.value)}
            >
              <option value="">{t("importChooseColumn")}</option>
              {columns.map((column) => (
                <option key={column.id} value={column.id}>
                  {column.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </section>
      {assignees.length > 0 && (
        <section>
          <h3>{t("importAssignees")}</h3>
          <p className="doska-meta">{t("importAssigneesHint")}</p>
          {assignees.map((source) => (
            <label className="doska-field" key={source}>
              {source}
              <select
                aria-label={t("importAssigneeFor", { source })}
                value={userMapping[source] ?? ""}
                onChange={(event) => onUser(source, event.target.value || null)}
              >
                {userMapping[source] &&
                  !people.some(
                    (person) => person.userId === userMapping[source],
                  ) && (
                    <option value={userMapping[source] ?? ""}>
                      {t("importUnmapped")}: {source}
                    </option>
                  )}
                <option value="">{t("unassigned")}</option>
                {people.map((person) => (
                  <option key={person.userId} value={person.userId}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </section>
      )}
    </div>
  );
}
