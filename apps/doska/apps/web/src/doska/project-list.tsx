import { DoskaResourceCreate } from "./resource-create";
import type { resourceCreateSearch } from "./resource-create-state";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Folder } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { DoskaProjectCreateForm } from "./project-create-form";
import { useDoskaSession } from "./session";
import { doskaHref } from "./shell";
const pageSize = 30;
export function DoskaProjects({
  resourceSearch = {},
}: {
  resourceSearch?: ReturnType<typeof resourceCreateSearch>;
}) {
  const { t } = useTranslation("doska");
  if (resourceSearch.resourceInvalid)
    return (
      <p role="alert" className="doska-panel">
        {t("resourceLinksUnavailable")}
      </p>
    );
  if (resourceSearch.resourceId && resourceSearch.sourceKind)
    return (
      <DoskaResourceCreate
        key={`${resourceSearch.sourceKind}:${resourceSearch.resourceId}`}
        selection={{
          resourceId: resourceSearch.resourceId,
          sourceKind: resourceSearch.sourceKind,
        }}
      />
    );
  return <DoskaProjectList />;
}
function DoskaProjectList() {
  const { t } = useTranslation("doska");
  const { context } = useDoskaSession();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const projects = useQuery({
    queryKey: ["doska", "projects", page, archived, search],
    queryFn: () =>
      api.listProjects({
        limit: pageSize,
        offset: page * pageSize,
        archived,
        search,
      }),
  });
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else {
      dialog.current?.close();
      trigger.current?.focus();
    }
  }, [open]);
  const visible = projects.data;
  return (
    <>
      <div className="doska-page-heading">
        <h1>{t("projects")}</h1>
        {context.canCreateProject && (
          <button
            ref={trigger}
            className="doska-primary"
            onClick={() => {
              setOpen(true);
            }}
          >
            <Plus size={17} />
            {t("newProject")}
          </button>
        )}
      </div>
      <div className="doska-filters">
        <input
          type="search"
          aria-label={t("searchProjects")}
          placeholder={t("searchProjects")}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
        />
        <label>
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => {
              setArchived(event.target.checked);
              setPage(0);
            }}
          />
          {t("archived")}
        </label>
      </div>
      {projects.isPending ? (
        <div className="doska-panel" role="status">
          {t("loading")}
        </div>
      ) : projects.isError ? (
        <div className="doska-panel doska-error" role="alert">
          <p>{t("loadError")}</p>
          <button onClick={() => void projects.refetch()}>{t("retry")}</button>
        </div>
      ) : visible?.length ? (
        <div className="doska-project-grid">
          {visible.map((project) => (
            <a
              className="doska-panel"
              href={doskaHref(`/projects/${encodeURIComponent(project.id)}`)}
              key={project.id}
            >
              <Folder size={22} />
              <h2>{project.name}</h2>
              <p>{project.description}</p>
              <span className="doska-meta">
                {project.slug} ·{" "}
                {t(project.visibility === "private" ? "private" : "department")}
              </span>
            </a>
          ))}
        </div>
      ) : (
        <div className="doska-panel">
          {t(search ? "noMatches" : "noProjects")}
        </div>
      )}
      <div className="doska-pagination">
        <button
          disabled={page === 0 || projects.isPending}
          onClick={() => setPage(page - 1)}
        >
          {t("previous")}
        </button>
        <span>{t("page", { page: page + 1 })}</span>
        <button
          disabled={
            !projects.data ||
            projects.data.length < pageSize ||
            projects.isPending
          }
          onClick={() => setPage(page + 1)}
        >
          {t("next")}
        </button>
      </div>
      <dialog
        ref={dialog}
        className="doska-dialog"
        aria-labelledby="new-project-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!creating) setOpen(false);
        }}
        onClose={() => setOpen(false)}
      >
        {open && (
          <DoskaProjectCreateForm
            onClose={() => setOpen(false)}
            onPendingChange={setCreating}
          />
        )}
      </dialog>
    </>
  );
}
