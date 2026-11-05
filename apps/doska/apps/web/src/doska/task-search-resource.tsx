import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { resourceLinksApi } from "./resource-links-api";
import type { TaskSearchFilters } from "./task-search-context";
export function TaskSearchResource({
  filters,
  onChange,
}: {
  filters: TaskSearchFilters;
  onChange: (patch: Partial<TaskSearchFilters>) => void;
}) {
  const { t } = useTranslation("doska");
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string>();
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(text.trim());
      setCursor(undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [text]);
  const selected = Boolean(filters.resourceId && filters.sourceKind);
  const search = useQuery({
    queryKey: ["doska", "resource-search", filters.projectId, query, cursor],
    queryFn: ({ signal }) =>
      resourceLinksApi.search(filters.projectId, query, cursor, signal),
    enabled: Boolean(filters.projectId && query && !selected),
    gcTime: 0,
    staleTime: 0,
  });
  const resolved = useQuery({
    queryKey: [
      "doska",
      "resource-search-selection",
      filters.projectId,
      filters.resourceId,
      filters.sourceKind,
    ],
    queryFn: ({ signal }) =>
      resourceLinksApi.resolve(
        filters.projectId,
        {
          resourceId: filters.resourceId,
          sourceKind: filters.sourceKind as "platform" | "netbox",
        },
        signal,
      ),
    enabled: Boolean(filters.projectId && selected),
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  return (
    <div className="doska-field doska-search-resource">
      <label>
        {t("searchResource")}
        {!selected && (
          <input
            type="text"
            aria-label={t("searchResource")}
            disabled={!filters.projectId}
            maxLength={128}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t(
              filters.projectId
                ? "resourceLinksSearch"
                : "searchChooseProjectForResource",
            )}
          />
        )}
      </label>
      {selected ? (
        <div className="doska-filters">
          <span>
            {resolved.isFetching || resolved.isPending
              ? t("loading")
              : resolved.isError || !resolved.data.available
                ? t("resourceLinksUnavailable")
                : resolved.data.descriptor.displayName}
          </span>
          <button
            type="button"
            onClick={() => {
              onChange({ resourceId: "", sourceKind: "" });
              setText("");
            }}
          >
            {t("searchResourceClear")}
          </button>
          {resolved.isError && (
            <button type="button" onClick={() => void resolved.refetch()}>
              {t("retry")}
            </button>
          )}
        </div>
      ) : filters.projectId && query ? (
        search.isPending || search.isFetching ? (
          <span role="status">{t("loading")}</span>
        ) : search.isError ? (
          <div role="alert">
            {t("loadError")}{" "}
            <button type="button" onClick={() => void search.refetch()}>
              {t("retry")}
            </button>
          </div>
        ) : (
          <>
            <ul className="doska-search-resource-options">
              {search.data.items.map((item) => (
                <li
                  key={`${item.selection.sourceKind}:${item.selection.resourceId}`}
                >
                  <button
                    type="button"
                    onClick={() => onChange(item.selection)}
                  >
                    {item.displayName}{" "}
                    <span className="doska-meta">
                      {t(`resourceKind_${item.objectKind}`)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {!search.data.items.length && <span>{t("searchNoResults")}</span>}
            {(cursor || search.data.nextCursor) && (
              <div className="doska-pagination">
                {cursor && (
                  <button type="button" onClick={() => setCursor(undefined)}>
                    {t("searchResourceFirstPage")}
                  </button>
                )}
                {search.data.nextCursor && (
                  <button
                    type="button"
                    onClick={() =>
                      setCursor(search.data.nextCursor ?? undefined)
                    }
                  >
                    {t("next")}
                  </button>
                )}
              </div>
            )}
          </>
        )
      ) : null}
    </div>
  );
}
