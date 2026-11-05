import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import type { ResourceSelection } from "./resource-links-types";
import { ResourceCreateForm } from "./resource-create-form";
export function DoskaResourceCreate({
  selection,
}: {
  selection: ResourceSelection;
}) {
  const { t } = useTranslation("doska");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(
    null,
  );
  const projects = useQuery({
    queryKey: ["doska", "projects", "resource-create", page],
    queryFn: async ({ signal }) => {
      const rows = await api.listProjects({
        limit: 20,
        offset: page * 20,
        archived: false,
      });
      const writable = [];
      for (let index = 0; index < rows.length; index += 4) {
        const batch = await Promise.all(
          rows.slice(index, index + 4).map(async (project) => ({
            project,
            access: await api.getAccess(project.id, { signal }),
          })),
        );
        writable.push(
          ...batch
            .filter(
              ({ project, access }) =>
                !project.archivedAt && access.workOnTasks,
            )
            .map(({ project }) => project),
        );
      }
      return { rows: writable, hasMore: rows.length === 20 };
    },
    enabled: !selected,
  });
  if (selected)
    return (
      <ResourceCreateForm
        key={selected.id}
        projectId={selected.id}
        projectName={selected.name}
        selection={selection}
        onBack={() => setSelected(null)}
      />
    );
  return (
    <>
      <div className="doska-page-heading">
        <h1>{t("resourceCreateTask")}</h1>
      </div>
      <p>{t("resourceChooseProject")}</p>
      {projects.isPending ? (
        <p role="status">{t("loading")}</p>
      ) : projects.isError ? (
        <p role="alert">
          {t("loadError")}{" "}
          <button onClick={() => void projects.refetch()}>{t("retry")}</button>
        </p>
      ) : (
        <>
          <div className="doska-project-grid">
            {projects.data.rows.map((project) => (
              <button
                className="doska-panel"
                key={project.id}
                onClick={() => setSelected(project)}
              >
                {project.name}
              </button>
            ))}
          </div>
          {!projects.data.rows.length && (
            <p>{t("resourceNoWritableProjects")}</p>
          )}
          {(page > 0 || projects.data.hasMore) && (
            <div className="doska-pagination">
              <button disabled={page === 0} onClick={() => setPage(page - 1)}>
                {t("previous")}
              </button>
              <button
                disabled={!projects.data.hasMore}
                onClick={() => setPage(page + 1)}
              >
                {t("next")}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
