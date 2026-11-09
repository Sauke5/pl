import { DetailsMenu } from "./details-menu";
import { useEffect, useState } from "react";
import {
  Pencil,
  Trash2,
  ChevronUp,
  ChevronDown,
  MoreHorizontal,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "./api";
import "./task-details.css";

type Draft = {
  kind: "list" | "item";
  listId?: string;
  itemId?: string;
  text: string;
  revision: number;
};
export function DoskaTaskChecklists({
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
  const [collapsedLists, setCollapsedLists] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<{
    listId: string;
    revision: number;
  } | null>(null);
  const lists = useQuery({
    queryKey: ["doska", "checklists", projectId, taskId],
    queryFn: () => api.getChecklists(projectId, taskId),
  });
  useEffect(() => {
    if (!lists.data) return;
    const completed = new Set(
      lists.data.checklists
        .filter(
          (list) =>
            list.items.length > 0 && list.items.every((item) => item.done),
        )
        .map((list) => `${taskId}:${list.id}`),
    );
    setCollapsedLists((previous) => {
      const next = new Set([...previous].filter((id) => completed.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [lists.data, taskId]);
  const mutation = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      setDraft(null);
      setDeleting(null);
      await Promise.all(
        ["checklists", "history", "task", "tasks", "my-tasks"].map((key) =>
          client.invalidateQueries({
            queryKey:
              key === "my-tasks" ? ["doska", key] : ["doska", key, projectId],
          }),
        ),
      );
    },
  });
  useEffect(() => {
    onDirtyChange?.(Boolean(draft?.text.trim()) || mutation.isPending);
  }, [draft, mutation.isPending, onDirtyChange]);
  const conflict =
    mutation.error instanceof ApiError && mutation.error.status === 409;
  const blocked = mutation.isPending || conflict;
  const revision = lists.data?.taskRevision ?? 0;
  const move = (ids: string[], index: number, direction: number) => {
    const result = [...ids];
    [result[index], result[index + direction]] = [
      result[index + direction]!,
      result[index]!,
    ];
    return result;
  };
  const begin = (value: Draft) => {
    setDraft(value);
    setDeleting(null);
    mutation.reset();
  };
  const save = () => {
    if (!draft || blocked) return;
    const expectedRevision = draft.revision;
    if (draft.kind === "list")
      mutation.mutate(() =>
        draft.listId
          ? api.updateChecklist(projectId, taskId, draft.listId, {
              expectedRevision,
              title: draft.text.trim(),
            })
          : api.createChecklist(projectId, taskId, {
              expectedRevision,
              title: draft.text.trim(),
            }),
      );
    else
      mutation.mutate(() =>
        draft.itemId
          ? api.updateChecklistItem(
              projectId,
              taskId,
              draft.listId!,
              draft.itemId,
              { expectedRevision, text: draft.text.trim() },
            )
          : api.createChecklistItem(projectId, taskId, draft.listId!, {
              expectedRevision,
              text: draft.text.trim(),
            }),
      );
  };
  const draftForm = () => {
    if (!draft || !canWork) return null;
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <fieldset className="doska-task-fields" disabled={mutation.isPending}>
          <label className="doska-field">
            {t(draft.kind === "list" ? "checklistName" : "checklistItemText")}
            <input
              autoFocus
              required
              maxLength={draft.kind === "list" ? 200 : 2000}
              value={draft.text}
              onChange={(event) =>
                setDraft({ ...draft, text: event.target.value })
              }
            />
          </label>
          <div className="doska-detail-actions">
            <button type="submit" disabled={blocked || !draft.text.trim()}>
              {t("save")}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                mutation.reset();
              }}
            >
              {t("cancel")}
            </button>
          </div>
        </fieldset>
      </form>
    );
  };
  return (
    <section className="doska-task-details" aria-label={t("checklistsTitle")}>
      <h3>{t("checklistsTitle")}</h3>
      {lists.isPending ? (
        <p role="status">{t("loading")}</p>
      ) : lists.isError ? (
        <p role="alert">
          {t("loadError")}{" "}
          <button type="button" onClick={() => void lists.refetch()}>
            {t("retry")}
          </button>
        </p>
      ) : (
        <>
          {!lists.data.checklists.length && (
            <p className="doska-meta">{t("noChecklists")}</p>
          )}
          {lists.data.checklists.map((list, listIndex) => {
            const doneCount = list.items.filter((item) => item.done).length;
            const completed =
              list.items.length > 0 && doneCount === list.items.length;
            const listKey = `${taskId}:${list.id}`;
            const collapsed =
              completed &&
              collapsedLists.has(listKey) &&
              draft?.listId !== list.id;
            return (
              <section
                className={`doska-checklist${completed ? " doska-checklist-complete" : ""}`}
                key={list.id}
              >
                <header>
                  <h4>{list.title}</h4>
                  <span className="doska-meta">
                    {doneCount}/{list.items.length}
                  </span>
                  {canWork && (
                    <div className="doska-detail-actions doska-checklist-controls">
                      <button
                        type="button"
                        className="doska-icon"
                        disabled={mutation.isPending || (!!draft && !conflict)}
                        onClick={() =>
                          begin({
                            kind: "list",
                            listId: list.id,
                            text: list.title,
                            revision,
                          })
                        }
                        aria-label={t("checklistRename")}
                        title={t("checklistRename")}
                      >
                        <Pencil size={15} />
                      </button>

                      <button
                        type="button"
                        className="doska-icon"
                        aria-label={t("checklistUp", { name: list.title })}
                        disabled={blocked || !!draft || listIndex === 0}
                        onClick={() =>
                          mutation.mutate(() =>
                            api.reorderChecklists(projectId, taskId, {
                              expectedRevision: revision,
                              ids: move(
                                lists.data.checklists.map((value) => value.id),
                                listIndex,
                                -1,
                              ),
                            }),
                          )
                        }
                      >
                        <ChevronUp size={14} />
                      </button>
                      <button
                        type="button"
                        className="doska-icon"
                        aria-label={t("checklistDown", { name: list.title })}
                        disabled={
                          blocked ||
                          !!draft ||
                          listIndex === lists.data.checklists.length - 1
                        }
                        onClick={() =>
                          mutation.mutate(() =>
                            api.reorderChecklists(projectId, taskId, {
                              expectedRevision: revision,
                              ids: move(
                                lists.data.checklists.map((value) => value.id),
                                listIndex,
                                1,
                              ),
                            }),
                          )
                        }
                      >
                        <ChevronDown size={14} />
                      </button>
                      <DetailsMenu
                        className="doska-checklist-menu"
                        onClick={(event) => {
                          if ((event.target as Element).closest("button"))
                            event.currentTarget.open = false;
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            event.currentTarget.open = false;
                            event.currentTarget
                              .querySelector("summary")
                              ?.focus();
                          }
                        }}
                      >
                        <summary
                          aria-label={t("checklistActions", {
                            name: list.title,
                          })}
                          title={t("checklistActions", { name: list.title })}
                        >
                          <MoreHorizontal size={16} />
                        </summary>
                        <div className="doska-checklist-menu-popup">
                          <button
                            type="button"
                            disabled={blocked || !!draft}
                            onClick={(event) => {
                              event.currentTarget.closest("details")!.open =
                                false;
                              setDeleting({ listId: list.id, revision });
                              mutation.reset();
                            }}
                            aria-label={t("checklistDelete")}
                            title={t("checklistDelete")}
                          >
                            <Trash2 size={15} /> {t("delete")}
                          </button>
                        </div>
                      </DetailsMenu>
                    </div>
                  )}
                </header>
                {list.items.length > 0 && (
                  <progress
                    className="doska-checklist-progress"
                    aria-label={list.title}
                    value={doneCount}
                    max={list.items.length}
                  />
                )}
                {draft?.kind === "list" &&
                  draft.listId === list.id &&
                  draftForm()}
                {completed && (
                  <button
                    type="button"
                    className="doska-checklist-expand"
                    aria-expanded={!collapsed}
                    aria-controls={`checklist-items-${list.id}`}
                    disabled={draft?.listId === list.id}
                    onClick={() =>
                      setCollapsedLists((previous) => {
                        const next = new Set(previous);
                        if (collapsed) next.delete(listKey);
                        else next.add(listKey);
                        return next;
                      })
                    }
                  >
                    {collapsed ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronUp size={14} />
                    )}
                    {t(collapsed ? "checklistExpand" : "checklistCollapse")}
                  </button>
                )}
                <ul
                  id={`checklist-items-${list.id}`}
                  className="doska-checklist-items"
                  hidden={collapsed}
                >
                  {list.items.map((item, itemIndex) => (
                    <li key={item.id}>
                      <div className="doska-checklist-item-text">
                        <label>
                          <input
                            type="checkbox"
                            checked={item.done}
                            disabled={!canWork || blocked || !!draft}
                            onChange={(event) => {
                              const done = event.target.checked;
                              mutation.mutate(() =>
                                api.updateChecklistItem(
                                  projectId,
                                  taskId,
                                  list.id,
                                  item.id,
                                  { expectedRevision: revision, done },
                                ),
                              );
                            }}
                          />
                          <span
                            className={
                              item.done ? "doska-checklist-done" : undefined
                            }
                          >
                            {item.text}
                          </span>
                        </label>
                      </div>
                      {canWork && (
                        <div className="doska-detail-actions doska-checklist-controls">
                          <button
                            type="button"
                            className="doska-icon"
                            aria-label={t("checklistEditItem", {
                              name: item.text,
                            })}
                            disabled={
                              mutation.isPending || (!!draft && !conflict)
                            }
                            onClick={() =>
                              begin({
                                kind: "item",
                                listId: list.id,
                                itemId: item.id,
                                text: item.text,
                                revision,
                              })
                            }
                          >
                            <Pencil size={14} />
                          </button>

                          <button
                            type="button"
                            className="doska-icon"
                            aria-label={t("checklistUp", { name: item.text })}
                            disabled={blocked || !!draft || itemIndex === 0}
                            onClick={() =>
                              mutation.mutate(() =>
                                api.reorderChecklistItems(
                                  projectId,
                                  taskId,
                                  list.id,
                                  {
                                    expectedRevision: revision,
                                    ids: move(
                                      list.items.map((value) => value.id),
                                      itemIndex,
                                      -1,
                                    ),
                                  },
                                ),
                              )
                            }
                          >
                            <ChevronUp size={14} />
                          </button>
                          <button
                            type="button"
                            className="doska-icon"
                            aria-label={t("checklistDown", { name: item.text })}
                            disabled={
                              blocked ||
                              !!draft ||
                              itemIndex === list.items.length - 1
                            }
                            onClick={() =>
                              mutation.mutate(() =>
                                api.reorderChecklistItems(
                                  projectId,
                                  taskId,
                                  list.id,
                                  {
                                    expectedRevision: revision,
                                    ids: move(
                                      list.items.map((value) => value.id),
                                      itemIndex,
                                      1,
                                    ),
                                  },
                                ),
                              )
                            }
                          >
                            <ChevronDown size={14} />
                          </button>
                          <DetailsMenu
                            className="doska-checklist-menu"
                            onClick={(event) => {
                              if ((event.target as Element).closest("button"))
                                event.currentTarget.open = false;
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                event.stopPropagation();
                                event.currentTarget.open = false;
                                event.currentTarget
                                  .querySelector("summary")
                                  ?.focus();
                              }
                            }}
                          >
                            <summary
                              aria-label={t("checklistActions", {
                                name: item.text,
                              })}
                              title={t("checklistActions", { name: item.text })}
                            >
                              <MoreHorizontal size={16} />
                            </summary>
                            <div className="doska-checklist-menu-popup">
                              <button
                                type="button"
                                aria-label={t("checklistDeleteItem", {
                                  name: item.text,
                                })}
                                disabled={blocked || !!draft}
                                onClick={() =>
                                  mutation.mutate(() =>
                                    api.deleteChecklistItem(
                                      projectId,
                                      taskId,
                                      list.id,
                                      item.id,
                                      { expectedRevision: revision },
                                    ),
                                  )
                                }
                              >
                                <Trash2 size={14} /> {t("delete")}
                              </button>
                            </div>
                          </DetailsMenu>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                {draft?.kind === "item" &&
                  draft.listId === list.id &&
                  draftForm()}
                {canWork && (
                  <div className="doska-checklist-add-row">
                    <button
                      type="button"
                      className="doska-add-item"
                      disabled={mutation.isPending || !!draft}
                      onClick={() =>
                        begin({
                          kind: "item",
                          listId: list.id,
                          text: "",
                          revision,
                        })
                      }
                    >
                      {t("checklistAddItem")}
                    </button>
                    {listIndex === lists.data.checklists.length - 1 && (
                      <button
                        type="button"
                        className="doska-add-list"
                        disabled={mutation.isPending || !!draft}
                        onClick={() =>
                          begin({ kind: "list", text: "", revision })
                        }
                      >
                        {t("checklistAdd")}
                      </button>
                    )}
                  </div>
                )}
              </section>
            );
          })}
          {draft?.kind === "list" && !draft.listId && draftForm()}
          {canWork && !lists.data.checklists.length && (
            <button
              type="button"
              className="doska-add-list"
              disabled={mutation.isPending || !!draft}
              onClick={() => begin({ kind: "list", text: "", revision })}
            >
              {t("checklistAdd")}
            </button>
          )}
        </>
      )}
      {canWork && deleting && (
        <div className="doska-notice">
          <p>{t("checklistDeleteConfirm")}</p>
          <button
            type="button"
            disabled={blocked}
            onClick={() =>
              mutation.mutate(() =>
                api.deleteChecklist(projectId, taskId, deleting.listId, {
                  expectedRevision: deleting.revision,
                }),
              )
            }
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
          <p>{t(conflict ? "checklistConflict" : "saveError")}</p>
          {conflict && (
            <button
              type="button"
              onClick={async () => {
                const result = await lists.refetch();
                if (result.isSuccess && !draft) {
                  setDeleting(null);
                  mutation.reset();
                }
              }}
            >
              {t("detailsRefresh")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
