import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { emptyTaskSearch, type TaskSearchFilters } from "./task-search-context";
import "./overview.css";
export function DoskaOverview() {
  const { t } = useTranslation("doska");
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const overview = useQuery({
    queryKey: ["doska", "overview", page],
    queryFn: () => api.overview({ limit: 20, offset: page * 20 }),
    refetchInterval: 60_000,
  });
  const open = (filters: Partial<TaskSearchFilters>) =>
    void navigate({
      to: "/search",
      state: {
        doskaTaskSearch: {
          filters: { ...emptyTaskSearch, open: true, ...filters },
          page: 0,
          scrollY: 0,
        },
      },
    } as never);
  return (
    <>
      <div className="doska-page-heading">
        <h1>{t("overview")}</h1>
      </div>
      {overview.isPending ? (
        <div role="status" className="doska-panel">
          {t("loading")}
        </div>
      ) : overview.isError ? (
        <div role="alert" className="doska-panel doska-error">
          <p>{t("loadError")}</p>
          <button onClick={() => void overview.refetch()}>{t("retry")}</button>
        </div>
      ) : (
        <>
          <div className="doska-overview-metrics">
            {(
              [
                ["active", "overviewActive", { state: "active" }],
                ["overdue", "overviewOverdue", { overdue: true }],
                ["unassigned", "overviewUnassigned", { unassigned: true }],
                ["upcoming", "overviewUpcoming", { upcoming: true }],
              ] as const
            ).map(([key, label, filters]) => (
              <button
                key={key}
                className={`doska-overview-metric${key === "overdue" && overview.data.totals.overdue ? " doska-overview-overdue" : ""}`}
                onClick={() => open(filters)}
              >
                <span>{t(label)}</span>
                <strong>
                  {overview.data.totals[key].toLocaleString("ru-RU")}
                </strong>
              </button>
            ))}
          </div>
          <section
            className="doska-panel doska-overview-assignees"
            aria-labelledby="overview-assignees"
          >
            <h2 id="overview-assignees">{t("overviewAssignees")}</h2>
            {overview.data.assignees.length ? (
              <ul>
                {overview.data.assignees.map((person) => (
                  <li key={person.userId}>
                    <button onClick={() => open({ assigneeId: person.userId })}>
                      <span>{person.name}</span>
                      <strong>{person.count.toLocaleString("ru-RU")}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t("overviewNoAssigned")}</p>
            )}
            {(page > 0 || overview.data.hasMore) && (
              <div className="doska-pagination">
                <button disabled={!page} onClick={() => setPage(page - 1)}>
                  {t("previous")}
                </button>
                <span>{t("page", { page: page + 1 })}</span>
                <button
                  disabled={!overview.data.hasMore}
                  onClick={() => setPage(page + 1)}
                >
                  {t("next")}
                </button>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
