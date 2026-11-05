import { useEffect, useState } from "react";
import { Link2, Trash2, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError } from "./api";
import { resourceLinksApi } from "./resource-links-api";
import type {
  ResourceMutation,
  ResourceSelection,
} from "./resource-links-types";
import "./task-resource-links.css";
export function DoskaTaskResourceLinks({
  projectId,
  taskId,
  canWork,
  onDirtyChange,
}: {
  projectId: string;
  taskId: string;
  canWork: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation("doska");
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [attempt, setAttempt] = useState<ResourceMutation | null>(null);
  const [error, setError] = useState("");
  const key = ["doska", "resource-links", projectId, taskId];
  const links = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => resourceLinksApi.list(projectId, taskId, signal),
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setQuery(text.trim());
      setCursor(undefined);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [text]);
  const search = useQuery({
    queryKey: ["doska", "resource-search", projectId, query, cursor],
    queryFn: ({ signal }) =>
      resourceLinksApi.search(projectId, query, cursor, signal),
    enabled: canWork && adding && Boolean(query),
    gcTime: 0,
    staleTime: 0,
  });
  const mutation = useMutation({
    mutationFn: (value: ResourceMutation) =>
      resourceLinksApi.mutate(projectId, taskId, value),
    retry: false,
    onSuccess: async () => {
      setAttempt(null);
      setError("");
      setAdding(false);
      setText("");
      await Promise.all([
        client.invalidateQueries({ queryKey: key }),
        client.invalidateQueries({
          queryKey: ["doska", "history", projectId, taskId],
        }),
      ]);
    },
    onError: async (cause) => {
      if (
        cause instanceof ApiError &&
        [400, 403, 404, 409].includes(cause.status)
      ) {
        setAttempt(null);
        setError(
          cause.status === 409
            ? "resourceLinksConflict"
            : "resourceLinksUnavailable",
        );
        await client.invalidateQueries({ queryKey: key });
      } else setError("resourceLinksSaveError");
    },
  });
  useEffect(() => {
    onDirtyChange?.(mutation.isPending || Boolean(attempt));
  }, [mutation.isPending, attempt, onDirtyChange]);
  useEffect(() => {
    if (!canWork) {
      setAdding(false);
      setAttempt(null);
      setText("");
    }
  }, [canWork]);
  const save = (value: ResourceMutation) => {
    if (!canWork || mutation.isPending) return;
    setAttempt(value);
    setError("");
    mutation.mutate(value);
  };
  const attach = (selection: ResourceSelection) => {
    if (links.data && !links.isFetching)
      save({
        operation: "attach",
        selection,
        expectedRevision: links.data.revision,
        clientRequestId: crypto.randomUUID(),
      });
  };
  return (
    <section className="doska-resource-links" aria-label={t("resourceLinks")}>
      <div className="doska-resource-links-heading">
        <h3>
          <Link2 size={17} />
          {t("resourceLinks")}
        </h3>
        {canWork && !adding && (
          <button
            disabled={
              !links.isSuccess ||
              links.isFetching ||
              mutation.isPending ||
              Boolean(attempt) ||
              links.data.links.length >= 32
            }
            onClick={() => setAdding(true)}
          >
            {t("resourceLinksAdd")}
          </button>
        )}
      </div>
      {links.isPending || links.isFetching ? (
        <p role="status">{t("loading")}</p>
      ) : links.isError ? (
        <div role="alert">
          <p>{t("loadError")}</p>
          <button onClick={() => void links.refetch()}>{t("retry")}</button>
        </div>
      ) : (
        <ul className="doska-resource-links-list">
          {links.data.links.map((link) => (
            <li key={link.linkId}>
              <div>
                <strong>
                  {link.available ? (
                    link.descriptor.platformHref ? (
                      <a href={link.descriptor.platformHref}>
                        {link.descriptor.displayName}
                      </a>
                    ) : (
                      link.descriptor.displayName
                    )
                  ) : (
                    t("resourceLinksUnavailable")
                  )}
                </strong>
                {link.available && (
                  <small>
                    {t(`resourceKind_${link.descriptor.objectKind}`)}
                    {link.descriptor.site ? ` · ${link.descriptor.site}` : ""}
                  </small>
                )}
              </div>
              {canWork && (
                <button
                  className="doska-icon"
                  aria-label={t("resourceLinksRemove")}
                  title={t("resourceLinksRemove")}
                  disabled={
                    mutation.isPending || links.isFetching || Boolean(attempt)
                  }
                  onClick={() =>
                    save({
                      operation: "detach",
                      linkId: link.linkId,
                      expectedRevision: links.data.revision,
                      clientRequestId: crypto.randomUUID(),
                    })
                  }
                >
                  <Trash2 size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <div role="alert" className="doska-error">
          <p>{t(error)}</p>
          {attempt && canWork && (
            <div className="doska-resource-links-actions">
              <button
                disabled={mutation.isPending}
                onClick={() => save(attempt)}
              >
                {t("retry")}
              </button>
              <button
                disabled={mutation.isPending}
                onClick={() => {
                  setAttempt(null);
                  setError("");
                  void links.refetch();
                }}
              >
                {t("resourceLinksReconcile")}
              </button>
            </div>
          )}
        </div>
      )}
      {adding && canWork && (
        <div className="doska-resource-search">
          <div className="doska-resource-links-actions">
            <input
              type="search"
              maxLength={128}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={t("resourceLinksSearch")}
              aria-label={t("resourceLinksSearch")}
            />
            <button
              className="doska-icon"
              aria-label={t("close")}
              disabled={mutation.isPending}
              onClick={() => setAdding(false)}
            >
              <X size={17} />
            </button>
          </div>
          {query &&
            query === text.trim() &&
            (search.isPending || search.isFetching ? (
              <p role="status">{t("loading")}</p>
            ) : search.isError ? (
              <div role="alert">
                {t("loadError")}{" "}
                <button onClick={() => void search.refetch()}>
                  {t("retry")}
                </button>
              </div>
            ) : (
              search.data && (
                <>
                  <ul className="doska-resource-search-results">
                    {search.data.items.map((item) => (
                      <li
                        key={`${item.selection.sourceKind}:${item.selection.resourceId}`}
                      >
                        <button
                          disabled={
                            mutation.isPending ||
                            Boolean(attempt) ||
                            links.isFetching ||
                            !links.isSuccess
                          }
                          onClick={() => attach(item.selection)}
                        >
                          <span>{item.displayName}</span>
                          <small>{t(`resourceKind_${item.objectKind}`)}</small>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {!search.data.items.length && (
                    <p>{t("resourceLinksNoResults")}</p>
                  )}
                  {search.data.nextCursor && (
                    <button
                      onClick={() =>
                        setCursor(search.data!.nextCursor ?? undefined)
                      }
                    >
                      {t("next")}
                    </button>
                  )}
                </>
              )
            ))}
        </div>
      )}
    </section>
  );
}
