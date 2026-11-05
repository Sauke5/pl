import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { DoskaProjectManagement } from "./project-management";

export function DoskaManagedProjects() {
  const { t } = useTranslation("doska");
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const projects = useQuery({
    queryKey: ["doska", "managed-projects", archived, search, page],
    queryFn: () =>
      api.listManagedProjects({
        limit: 30,
        offset: page * 30,
        search,
        archived,
      }),
  });
  return (
    <>
      <div className="doska-page-heading">
        <h1>{t("managedProjects")}</h1>
      </div>
      <div className="doska-filters">
        <input
          type="search"
          placeholder={t("searchProjects")}
          aria-label={t("searchProjects")}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
        <label>
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => {
              setArchived(e.target.checked);
              setPage(0);
            }}
          />
          {t("archived")}
        </label>
      </div>
      {projects.isPending ? (
        <p role="status">{t("loading")}</p>
      ) : projects.isError ? (
        <div role="alert">
          <p>{t("loadError")}</p>
          <button onClick={() => void projects.refetch()}>{t("retry")}</button>
        </div>
      ) : !projects.data.length ? (
        <p>{t("noProjects")}</p>
      ) : (
        <div className="doska-panel">
          <table>
            <thead>
              <tr>
                <th>{t("project")}</th>
                <th>
                  <span className="doska-sr-only">{t("actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {projects.data.map((project) => (
                <tr key={project.id}>
                  <td>{project.name}</td>
                  <td>
                    <button onClick={() => setSelected(project.id)}>
                      {t("manageProject")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="doska-pagination">
        <button
          disabled={!page || projects.isFetching}
          onClick={() => setPage(page - 1)}
        >
          {t("previous")}
        </button>
        <button
          disabled={
            !projects.data || projects.data.length < 30 || projects.isFetching
          }
          onClick={() => setPage(page + 1)}
        >
          {t("next")}
        </button>
      </div>
      {selected && (
        <DoskaProjectManagement
          projectId={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
