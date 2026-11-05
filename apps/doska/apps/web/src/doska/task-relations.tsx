import { useEffect, useState } from "react";
import { Link2, Plus, Trash2 } from "lucide-react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, type Relation } from "./api";
import { doskaHref } from "./shell";
import "./task-relations.css";
type Kind = "related" | "blocks" | "duplicate";
export function DoskaTaskRelations({
  projectId,
  taskId,
  revision,
  canWork,
  onDirtyChange,
}: {
  projectId: string;
  taskId: string;
  revision: number;
  canWork: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation("doska");
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Relation | null>(null);
  const [expectedRevision, setExpectedRevision] = useState(revision);
  const [kind, setKind] = useState<Kind>("related");
  const [targetProject, setTargetProject] = useState(projectId);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<{ id: string; title: string } | null>(
    null,
  );
  const [page, setPage] = useState(0);
  const [taskPage, setTaskPage] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  const relations = useQuery({
    queryKey: ["doska", "relations", projectId, taskId, page],
    queryFn: () =>
      api.getRelations(projectId, taskId, { limit: 20, offset: page * 20 }),
  });
  const projects = useInfiniteQuery({
    queryKey: ["doska", "relation-projects"],
    enabled: adding && canWork,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.listProjects({ limit: 100, offset: pageParam }),
    getNextPageParam: (last, pages) =>
      last.length === 100 ? pages.length * 100 : undefined,
  });
  const access = useQuery({
    queryKey: ["doska", "relation-access", targetProject],
    enabled: adding && canWork,
    queryFn: () => api.getAccess(targetProject),
  });
  const results = useQuery({
    queryKey: ["doska", "relation-search", targetProject, query, taskPage],
    enabled: adding && canWork && access.data?.workOnTasks === true,
    queryFn: () =>
      api.searchTasks({
        projectId: targetProject,
        q: query || undefined,
        limit: 20,
        offset: taskPage * 20,
      }),
  });
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setTaskPage(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  async function refresh() {
    await Promise.all(
      ["relations", "history", "task", "tasks", "my-tasks"].map((key) =>
        client.invalidateQueries({ queryKey: ["doska", key] }),
      ),
    );
  }
  function close() {
    setAdding(false);
    setDeleting(null);
    setTarget(null);
    setConflict(false);
    setReloadFailed(false);
  }
  const mutation = useMutation({
    mutationFn: async () => {
      if (deleting)
        return api.deleteRelation(projectId, taskId, deleting.id, {
          expectedRevision,
        });
      if (!target) throw new Error("No target selected");
      return api.createRelation(projectId, taskId, {
        expectedRevision,
        targetTaskId: target.id,
        type: kind,
      });
    },
    onSuccess: async () => {
      close();
      if (deleting && page && relations.data?.length === 1) setPage(page - 1);
      await refresh();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
    },
  });
  useEffect(() => {
    onDirtyChange?.(adding || Boolean(deleting) || mutation.isPending);
  }, [adding, deleting, mutation.isPending, onDirtyChange]);
  useEffect(() => {
    if (!canWork) close();
  }, [canWork]);
  async function reload() {
    setReloading(true);
    setReloadFailed(false);
    try {
      const current = await api.getTask(projectId, taskId);
      setExpectedRevision(current.revision);
      await refresh();
      setConflict(false);
      mutation.reset();
    } catch {
      setReloadFailed(true);
    } finally {
      setReloading(false);
    }
  }
  const blocked = mutation.isPending || conflict || reloading || !canWork;
  const label = (relation: Relation) =>
    relation.type === "blocks"
      ? relation.direction === "incoming"
        ? "relationBlockedBy"
        : "relationBlocks"
      : relation.type === "duplicate"
        ? "relationDuplicate"
        : "relationRelated";
  return (
    <section className="doska-task-relations">
      <header>
        <h3>{t("taskRelations")}</h3>
        {canWork && !adding && !deleting && (
          <button
            type="button"
            onClick={() => {
              mutation.reset();
              setExpectedRevision(revision);
              setTargetProject(projectId);
              setSearch("");
              setQuery("");
              setTaskPage(0);
              setKind("related");
              setAdding(true);
            }}
          >
            <Plus size={15} />
            {t("relationAdd")}
          </button>
        )}
      </header>
      {relations.isPending ? (
        <p role="status">{t("loading")}</p>
      ) : relations.isError ? (
        <div role="alert" className="doska-notice doska-error">
          {t("loadError")}{" "}
          <button type="button" onClick={() => void relations.refetch()}>
            {t("retry")}
          </button>
        </div>
      ) : relations.data.length ? (
        <ul>
          {relations.data.map((relation) => (
            <li key={relation.id}>
              <Link2 size={15} aria-hidden="true" />
              <div>
                <small>{t(label(relation))}</small>
                <a
                  aria-label={`${relation.task.number === null ? "" : `#${relation.task.number} `}${relation.task.title}`}
                  aria-disabled={adding || Boolean(deleting)}
                  onClick={(event) => {
                    if (adding || deleting) event.preventDefault();
                  }}
                  href={doskaHref(
                    `/projects/${encodeURIComponent(relation.task.projectId)}?taskId=${encodeURIComponent(relation.task.id)}`,
                  )}
                >
                  {relation.task.number !== null && (
                    <span>#{relation.task.number} </span>
                  )}
                  {relation.task.title}
                </a>
              </div>
              {canWork && (
                <button
                  type="button"
                  aria-label={t("relationRemoveNamed", {
                    name: relation.task.title,
                  })}
                  disabled={adding || Boolean(deleting) || mutation.isPending}
                  onClick={() => {
                    mutation.reset();
                    setExpectedRevision(revision);
                    setDeleting(relation);
                  }}
                >
                  <Trash2 size={15} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        !adding && <p className="doska-relation-muted">{t("relationsEmpty")}</p>
      )}
      {relations.data && (page > 0 || relations.data.length === 20) && (
        <div className="doska-relation-actions">
          {page > 0 && (
            <button type="button" onClick={() => setPage(page - 1)}>
              {t("previous")}
            </button>
          )}
          {relations.data.length === 20 && (
            <button type="button" onClick={() => setPage(page + 1)}>
              {t("next")}
            </button>
          )}
        </div>
      )}
      {adding && (
        <div className="doska-relation-form">
          <div className="doska-relation-fields">
            <label>
              {t("relationType")}
              <select
                aria-label={t("relationType")}
                value={kind}
                disabled={blocked}
                onChange={(e) => setKind(e.target.value as Kind)}
              >
                <option value="related">{t("relationRelated")}</option>
                <option value="blocks">{t("relationBlocks")}</option>
                <option value="duplicate">{t("relationDuplicate")}</option>
              </select>
            </label>
            <label>
              {t("relationProject")}
              <select
                aria-label={t("relationProject")}
                value={targetProject}
                disabled={blocked || projects.isPending}
                onChange={(e) => {
                  setTargetProject(e.target.value);
                  setTarget(null);
                  setTaskPage(0);
                }}
              >
                <option value={projectId}>
                  {projects.data?.pages.flat().find((p) => p.id === projectId)
                    ?.name ?? t("relationCurrentProject")}
                </option>
                {projects.data?.pages
                  .flat()
                  .filter((p) => p.id !== projectId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          {projects.hasNextPage && (
            <button
              type="button"
              disabled={projects.isFetchingNextPage}
              onClick={() => void projects.fetchNextPage()}
            >
              {t("relationMoreProjects")}
            </button>
          )}
          {projects.isError && (
            <p role="alert">
              {t("loadError")}{" "}
              <button type="button" onClick={() => void projects.refetch()}>
                {t("retry")}
              </button>
            </p>
          )}
          {access.isError ? (
            <p role="alert">
              {t("loadError")}{" "}
              <button type="button" onClick={() => void access.refetch()}>
                {t("retry")}
              </button>
            </p>
          ) : access.data && !access.data.workOnTasks ? (
            <p className="doska-relation-muted">
              {t("relationTargetReadOnly")}
            </p>
          ) : (
            <>
              <label>
                {t("relationFindTask")}
                <input
                  value={search}
                  disabled={blocked}
                  placeholder={t("relationFindPlaceholder")}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setTarget(null);
                  }}
                />
              </label>
              {results.isFetching || access.isPending ? (
                <p role="status">{t("loading")}</p>
              ) : results.isError ? (
                <p role="alert">
                  {t("loadError")}{" "}
                  <button type="button" onClick={() => void results.refetch()}>
                    {t("retry")}
                  </button>
                </p>
              ) : (
                <div
                  className="doska-relation-results"
                  role="group"
                  aria-label={t("relationChooseTask")}
                >
                  {results.data
                    ?.filter((row) => row.id !== taskId)
                    .map((row) => (
                      <button
                        key={row.id}
                        type="button"
                        aria-pressed={target?.id === row.id}
                        disabled={blocked}
                        onClick={() =>
                          setTarget({ id: row.id, title: row.title })
                        }
                      >
                        <span>#{row.number}</span> {row.title}
                      </button>
                    ))}
                  {results.data?.filter((row) => row.id !== taskId).length ===
                    0 && <p>{t("relationNoTasks")}</p>}
                </div>
              )}
              {results.data && (taskPage > 0 || results.data.length === 20) && (
                <div className="doska-relation-actions">
                  {taskPage > 0 && (
                    <button
                      type="button"
                      disabled={blocked}
                      onClick={() => {
                        setTaskPage(taskPage - 1);
                        setTarget(null);
                      }}
                    >
                      {t("previous")}
                    </button>
                  )}
                  {results.data.length === 20 && (
                    <button
                      type="button"
                      disabled={blocked}
                      onClick={() => {
                        setTaskPage(taskPage + 1);
                        setTarget(null);
                      }}
                    >
                      {t("next")}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
          {target && (
            <p className="doska-relation-selected">
              {t("relationSelected", { name: target.title })}
            </p>
          )}
          <div className="doska-relation-actions">
            <button
              type="button"
              disabled={blocked || !target || !access.data?.workOnTasks}
              onClick={() => mutation.mutate()}
            >
              {t("relationLink")}
            </button>
            <button
              type="button"
              disabled={mutation.isPending || reloading}
              onClick={() => {
                mutation.reset();
                close();
              }}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}
      {deleting && (
        <div className="doska-relation-form">
          <p>{t("relationRemoveConfirm", { name: deleting.task.title })}</p>
          <div className="doska-relation-actions">
            <button
              type="button"
              className="doska-danger"
              disabled={blocked}
              onClick={() => mutation.mutate()}
            >
              {t("relationRemove")}
            </button>
            <button
              type="button"
              disabled={mutation.isPending || reloading}
              onClick={() => {
                mutation.reset();
                close();
              }}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}
      {conflict ? (
        <div className="doska-notice" role="alert">
          {t("relationConflict")}{" "}
          <button
            type="button"
            disabled={reloading}
            onClick={() => void reload()}
          >
            {t("relationReload")}
          </button>
        </div>
      ) : (
        mutation.isError && (
          <p role="alert" className="doska-error">
            {t("relationSaveError")}
          </p>
        )
      )}
      {reloadFailed && (
        <p role="alert" className="doska-error">
          {t("loadError")}
        </p>
      )}
    </section>
  );
}
