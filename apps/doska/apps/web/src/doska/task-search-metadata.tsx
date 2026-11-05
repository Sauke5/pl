import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { DoskaCustomFieldInput } from "./custom-field-input";
import type { FieldPerson } from "./custom-fields";
import type { TaskSearchFilters } from "./task-search-context";
export function TaskSearchMetadata({
  filters,
  onChange,
  people,
}: {
  filters: TaskSearchFilters;
  onChange: (patch: Partial<TaskSearchFilters>) => void;
  people: FieldPerson[];
}) {
  const { t } = useTranslation("doska");
  const labelListId = useId();
  const fields = useQuery({
    queryKey: ["doska", "project-fields", filters.projectId],
    queryFn: () => api.getProjectFields(filters.projectId),
    enabled: Boolean(filters.projectId),
  });
  const labels = useQuery({
    queryKey: [
      "doska",
      "labels",
      filters.projectId,
      "search",
      filters.labelName,
    ],
    queryFn: () =>
      api.listProjectLabels(filters.projectId, {
        q: filters.labelName,
        limit: 30,
      }),
    enabled: Boolean(filters.projectId),
  });
  const available = fields.isError
    ? []
    : (fields.data?.fields ?? []).filter((field) => !field.archivedAt);
  const selected = available.find(
    (field) => field.id === filters.customFieldId,
  );
  return (
    <>
      <label className="doska-field">
        {t("searchLabel")}
        <input
          value={filters.labelName}
          maxLength={100}
          list={labelListId}
          placeholder={t("searchLabelPlaceholder")}
          onChange={(event) => onChange({ labelName: event.target.value })}
        />
        <datalist id={labelListId}>
          {!labels.isError &&
            labels.data?.map((label) => (
              <option key={label.name} value={label.name} />
            ))}
        </datalist>
      </label>
      <label className="doska-field">
        {t("searchCustomField")}
        <select
          value={filters.customFieldId}
          disabled={!filters.projectId || fields.isPending || fields.isError}
          onChange={(event) =>
            onChange({
              customFieldId: event.target.value,
              customFieldValue: "",
            })
          }
        >
          <option value="">
            {t(filters.projectId ? "searchAnyField" : "searchChooseProject")}
          </option>
          {filters.customFieldId && !selected && (
            <option value={filters.customFieldId}>
              {t("customFieldUnavailable")}
            </option>
          )}
          {available.map((field) => (
            <option key={field.id} value={field.id}>
              {field.name}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <div>
          {selected.type === "text" ? (
            <label className="doska-field">
              {selected.name}
              <input
                maxLength={2000}
                value={filters.customFieldValue}
                onChange={(event) =>
                  onChange({ customFieldValue: event.target.value })
                }
              />
            </label>
          ) : (
            <DoskaCustomFieldInput
              field={{ ...selected, required: false }}
              value={filters.customFieldValue || null}
              onChange={(value) => onChange({ customFieldValue: value ?? "" })}
              people={people}
            />
          )}
          {(selected.type === "text" || selected.type === "multiselect") && (
            <small className="doska-meta">
              {t(
                selected.type === "text"
                  ? "searchFieldContains"
                  : "searchFieldContainsAll",
              )}
            </small>
          )}
        </div>
      )}
      {filters.projectId && fields.isError && (
        <p role="alert" className="doska-error">
          {t("searchFieldsError")}{" "}
          <button onClick={() => void fields.refetch()}>{t("retry")}</button>
        </p>
      )}
    </>
  );
}
