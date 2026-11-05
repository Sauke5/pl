import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import { api, ApiError } from "./api";
import { useDoskaSession } from "./session";
import "./task-details.css";
import "./task-comments.css";

const authorHues = [210, 270, 155, 325, 25, 185, 245, 95];
function authorHue(id: string) {
  let hash = 0;
  for (const character of id)
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return authorHues[hash % authorHues.length];
}

type Draft = {
  id?: string;
  revision?: number;
  content: string;
  mentionIds: string[];
};
const emptyDraft = (): Draft => ({ content: "", mentionIds: [] });
export function DoskaTaskComments({
  projectId,
  taskId,
  canWork,
  onDirtyChange,
  canModerate,
}: {
  projectId: string;
  taskId: string;
  canWork: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  canModerate: boolean;
}) {
  const { t } = useTranslation("doska");
  const { context } = useDoskaSession();
  const client = useQueryClient();
  const composer = useRef<HTMLTextAreaElement>(null);
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [deleting, setDeleting] = useState<{
    id: string;
    revision: number;
  } | null>(null);
  useEffect(() => {
    if (draft.id) composer.current?.focus();
  }, [draft.id]);
  useLayoutEffect(() => {
    const field = composer.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 180)}px`;
  }, [draft.content]);
  const comments = useQuery({
    queryKey: ["doska", "comments", projectId, taskId, page],
    queryFn: () =>
      api.listComments(projectId, taskId, { limit: 20, offset: page * 20 }),
  });
  const roster = useQuery({
    queryKey: ["doska", "members", projectId],
    queryFn: () => api.listMembers(projectId),
    enabled: canWork,
  });
  const people = roster.data ? [roster.data.owner, ...roster.data.members] : [];
  const mutation = useMutation({
    mutationFn: async (action: "save" | "delete") => {
      if (action === "delete" && deleting)
        return api.deleteComment(projectId, taskId, deleting.id, {
          expectedRevision: deleting.revision,
        });
      const body = {
        content: draft.content.trim(),
        mentionIds: draft.mentionIds,
      };
      return draft.id
        ? api.updateComment(projectId, taskId, draft.id, {
            ...body,
            expectedRevision: draft.revision!,
          })
        : api.createComment(projectId, taskId, body);
    },
    onSuccess: async (_, action) => {
      if (action === "save") setDraft(emptyDraft());
      setDeleting(null);
      await Promise.all(
        ["comments", "history", "task", "checklists"].map((key) =>
          client.invalidateQueries({
            queryKey: ["doska", key, projectId, taskId],
          }),
        ),
      );
    },
  });
  useEffect(() => {
    onDirtyChange?.(
      Boolean(draft.content.trim()) ||
        draft.mentionIds.length > 0 ||
        mutation.isPending,
    );
  }, [draft, mutation.isPending, onDirtyChange]);
  const conflict =
    mutation.error instanceof ApiError && mutation.error.status === 409;
  return (
    <section className="doska-task-details" aria-label={t("commentsTitle")}>
      <h3>{t("commentsTitle")}</h3>
      {comments.isPending ? (
        <p role="status">{t("loading")}</p>
      ) : comments.isError ? (
        <p role="alert">
          {t("loadError")}{" "}
          <button type="button" onClick={() => void comments.refetch()}>
            {t("retry")}
          </button>
        </p>
      ) : (
        <ol className="doska-comments doska-comment-thread">
          {comments.data.map((comment) => (
            <li
              key={comment.id}
              className={`doska-comment-bubble${comment.userId === context.user.id ? " doska-comment-own" : ""}${comment.deletedAt ? " doska-comment-deleted" : ""}`}
              style={
                { "--comment-hue": authorHue(comment.userId) } as CSSProperties
              }
            >
              <header>
                <strong className="doska-comment-author">
                  <span className="doska-comment-avatar" aria-hidden="true">
                    {(comment.authorName ?? "?")
                      .trim()
                      .split(/\s+/)
                      .slice(0, 2)
                      .map((part) => part[0])
                      .join("")
                      .toUpperCase()}
                  </span>
                  <span>{comment.authorName ?? t("unavailableMember")}</span>
                </strong>
                <time dateTime={comment.createdAt}>
                  {new Date(comment.createdAt).toLocaleString("ru-RU", {
                    timeZone: "Europe/Moscow",
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </time>
              </header>
              {comment.deletedAt ? (
                <p className="doska-meta">{t("commentDeleted")}</p>
              ) : (
                <>
                  <div className="doska-comment-content">
                    <ReactMarkdown
                      skipHtml
                      disallowedElements={["img"]}
                      urlTransform={(url) =>
                        /^(https?:|mailto:)/i.test(url) ? url : ""
                      }
                      components={{
                        a: ({ href, children }) =>
                          href ? (
                            <a
                              href={href}
                              rel="noreferrer noopener"
                              target="_blank"
                            >
                              {children}
                            </a>
                          ) : (
                            <span>{children}</span>
                          ),
                      }}
                    >
                      {comment.content}
                    </ReactMarkdown>
                  </div>
                  {!!comment.mentions.length && (
                    <p className="doska-meta">
                      {comment.mentions
                        .map(
                          (person) =>
                            `@${person.name ?? t("unavailableMember")}`,
                        )
                        .join(", ")}
                    </p>
                  )}
                  {canWork && (
                    <div className="doska-detail-actions">
                      {comment.userId === context.user.id && (
                        <button
                          type="button"
                          disabled={
                            mutation.isPending ||
                            (Boolean(draft.content.trim()) &&
                              !(conflict && draft.id === comment.id))
                          }
                          onClick={() => {
                            setDraft({
                              id: comment.id,
                              revision: comment.revision,
                              content: comment.content ?? "",
                              mentionIds: comment.mentionIds,
                            });
                            mutation.reset();
                            setDeleting(null);
                          }}
                        >
                          {t(
                            draft.id === comment.id
                              ? "commentRestartEdit"
                              : "edit",
                          )}
                        </button>
                      )}
                      {(comment.userId === context.user.id || canModerate) && (
                        <button
                          type="button"
                          disabled={mutation.isPending}
                          onClick={() => {
                            setDeleting({
                              id: comment.id,
                              revision: comment.revision,
                            });
                            mutation.reset();
                          }}
                        >
                          {t("delete")}
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      {comments.data?.length === 0 && (
        <p className="doska-meta">{t("noComments")}</p>
      )}
      {(page > 0 || comments.data?.length === 20) && (
        <div className="doska-pagination">
          <button
            type="button"
            disabled={!page || comments.isFetching}
            onClick={() => setPage(page - 1)}
          >
            {t("previous")}
          </button>
          <button
            type="button"
            disabled={comments.data?.length !== 20 || comments.isFetching}
            onClick={() => setPage(page + 1)}
          >
            {t("next")}
          </button>
        </div>
      )}
      {canWork && deleting && (
        <div className="doska-notice">
          <p>{t("commentDeleteConfirm")}</p>
          <button
            type="button"
            disabled={mutation.isPending || conflict}
            onClick={() => mutation.mutate("delete")}
          >
            {t("delete")}
          </button>
          <button
            type="button"
            disabled={mutation.isPending}
            onClick={() => {
              setDeleting(null);
              mutation.reset();
            }}
          >
            {t("cancel")}
          </button>
        </div>
      )}
      {mutation.isError && (
        <div className="doska-notice doska-error" role="alert">
          <p>{t(conflict ? "commentConflict" : "saveError")}</p>
          {conflict && (
            <button type="button" onClick={() => void comments.refetch()}>
              {t("detailsRefresh")}
            </button>
          )}
        </div>
      )}
      {canWork && (
        <form
          className="doska-comment-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (!conflict) mutation.mutate("save");
          }}
        >
          <fieldset className="doska-task-fields" disabled={mutation.isPending}>
            <label className="doska-field doska-comment-input">
              <span className="doska-sr-only">
                {t(draft.id ? "commentEdit" : "commentNew")}
              </span>
              <textarea
                ref={composer}
                rows={2}
                placeholder={t(draft.id ? "commentEdit" : "commentNew")}
                required
                maxLength={20000}
                value={draft.content}
                onChange={(event) =>
                  setDraft({ ...draft, content: event.target.value })
                }
              />
            </label>
            <label className="doska-field doska-mention-select">
              {t("commentMention")}
              <select
                value=""
                disabled={!roster.data}
                onChange={(event) => {
                  const id = event.target.value;
                  if (id && !draft.mentionIds.includes(id))
                    setDraft({
                      ...draft,
                      mentionIds: [...draft.mentionIds, id],
                    });
                }}
              >
                <option value="">{t("commentChoosePerson")}</option>
                {people
                  .filter((person) => !draft.mentionIds.includes(person.userId))
                  .map((person) => (
                    <option key={person.userId} value={person.userId}>
                      {person.name}
                    </option>
                  ))}
              </select>
            </label>
            <div className="doska-detail-actions doska-comment-mentions">
              {draft.mentionIds.map((id) => (
                <button
                  type="button"
                  key={id}
                  aria-label={t("commentRemoveMention", {
                    name:
                      people.find((person) => person.userId === id)?.name ??
                      t("unavailableMember"),
                  })}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      mentionIds: draft.mentionIds.filter(
                        (value) => value !== id,
                      ),
                    })
                  }
                >
                  @
                  {people.find((person) => person.userId === id)?.name ??
                    t("unavailableMember")}{" "}
                  ×
                </button>
              ))}
            </div>
            {roster.isError && (
              <p role="alert">
                {t("membersLoadError")}{" "}
                <button type="button" onClick={() => void roster.refetch()}>
                  {t("retry")}
                </button>
              </p>
            )}
            <div className="doska-detail-actions doska-comment-send">
              <button
                type="submit"
                className="doska-primary"
                disabled={!draft.content.trim() || conflict}
              >
                {t(draft.id ? "save" : "commentSend")}
              </button>
              {draft.id && (
                <button
                  type="button"
                  onClick={() => {
                    setDraft(emptyDraft());
                    mutation.reset();
                  }}
                >
                  {t("cancel")}
                </button>
              )}
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}
