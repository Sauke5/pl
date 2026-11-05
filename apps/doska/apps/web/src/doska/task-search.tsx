import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, type TaskSearchQuery } from "./api";
import {
  emptyTaskSearch,
  readTaskSearchContext,
  type TaskSearchFilters,
} from "./task-search-context";
import { TaskSearchFilterFields } from "./task-search-filters";
import { TaskSearchResults } from "./task-search-results";
import "./task-search.css";
const pageSize = 40;
export function DoskaTaskSearch() {
  const { t } = useTranslation("doska");
  const navigate = useNavigate();
  const locationState = useRouterState({
    select: (state) => state.location.state,
  });
  const initial = useRef(readTaskSearchContext(locationState));
  const [filters, setFilters] = useState<TaskSearchFilters>(
    initial.current?.filters ?? emptyTaskSearch,
  );
  const [text, setText] = useState(filters.q);
  const [page, setPage] = useState(initial.current?.page ?? 0);
  const update = (patch: Partial<TaskSearchFilters>) => {
    initial.current = null;
    setFilters((current) => ({ ...current, ...patch }));
    setPage(0);
  };
  useEffect(() => {
    if (text === filters.q) return;
    const timeout = window.setTimeout(() => {
      setFilters((current) => ({ ...current, q: text }));
      setPage(0);
      initial.current = null;
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [text, filters.q]);
  const validRange =
    !filters.dueFrom || !filters.dueTo || filters.dueFrom <= filters.dueTo;
  const tasks = useQuery({
    gcTime: filters.resourceId ? 0 : undefined,
    staleTime: filters.resourceId ? 0 : undefined,
    queryKey: ["doska", "task-search", filters, page],
    enabled: validRange && filters.customFieldValue.length <= 2000,
    queryFn: () => {
      const query = Object.fromEntries(
        Object.entries(filters).filter(
          ([, value]) => value !== "" && value !== false,
        ),
      ) as TaskSearchQuery;
      if (!query.labelName?.trim()) delete query.labelName;
      if (!query.customFieldValue?.trim() || query.customFieldValue === "[]") {
        delete query.customFieldId;
        delete query.customFieldValue;
      }
      return api.searchTasks({
        ...query,
        limit: pageSize,
        offset: page * pageSize,
      });
    },
  });
  useLayoutEffect(() => {
    if (!tasks.isSuccess || !initial.current) return;
    window.scrollTo({ top: initial.current.scrollY, behavior: "instant" });
    initial.current = null;
  }, [tasks.isSuccess]);
  return (
    <>
      <div className="doska-page-heading">
        <h1>{t("taskSearch")}</h1>
      </div>
      <div className="doska-search-bar">
        <input
          type="search"
          aria-label={t("taskSearch")}
          placeholder={t("taskSearchPlaceholder")}
          maxLength={200}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        {(text || Object.values(filters).some(Boolean)) && (
          <button
            onClick={() => {
              setText("");
              setFilters(emptyTaskSearch);
              setPage(0);
              initial.current = null;
            }}
          >
            {t("searchClear")}
          </button>
        )}
      </div>
      <TaskSearchFilterFields filters={filters} onChange={update} />
      {filters.customFieldValue.length > 2000 ? (
        <p role="alert" className="doska-notice doska-error">
          {t("searchFieldTooLong")}
        </p>
      ) : !validRange ? (
        <p role="alert" className="doska-notice doska-error">
          {t("searchInvalidDates")}
        </p>
      ) : tasks.isPending || (filters.resourceId && tasks.isFetching) ? (
        <div className="doska-panel" role="status">
          {t("loading")}
        </div>
      ) : tasks.isError ? (
        <div className="doska-panel doska-error" role="alert">
          <p>{t("loadError")}</p>
          <button onClick={() => void tasks.refetch()}>{t("retry")}</button>
        </div>
      ) : !tasks.data.length ? (
        <div className="doska-panel">{t("searchNoResults")}</div>
      ) : (
        <TaskSearchResults
          tasks={tasks.data}
          onOpen={(task) => {
            const state = {
              doskaTaskSearch: { filters, page, scrollY: window.scrollY },
            };
            void (async () => {
              await navigate({
                to: "/search",
                state,
                replace: true,
                resetScroll: false,
              } as never);
              await navigate({
                to: "/projects/$projectId",
                params: { projectId: task.projectId },
                search: { taskId: task.id },
                state,
              } as never);
            })();
          }}
        />
      )}
      {validRange && (page > 0 || tasks.data?.length === pageSize) && (
        <div className="doska-pagination">
          <button
            disabled={page === 0 || tasks.isPending}
            onClick={() => setPage(page - 1)}
          >
            {t("previous")}
          </button>
          <span>{t("page", { page: page + 1 })}</span>
          <button
            disabled={
              !tasks.data || tasks.data.length < pageSize || tasks.isPending
            }
            onClick={() => setPage(page + 1)}
          >
            {t("next")}
          </button>
        </div>
      )}
    </>
  );
}
