import { useEffect, useRef } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Check, X } from "lucide-react";
import { api, type DoskaNotification } from "./api";
import { doskaHref } from "./shell";
import { usePageVisibility } from "./page-visibility";
import "./notifications.css";
const labels: Record<string, string> = {
  "doska.task_due_reminder": "notificationDueReminder",
  "doska.task_overdue": "notificationOverdue",
  "doska.task_assigned": "notificationAssigned",
  "doska.task_unassigned": "notificationUnassigned",
  "doska.task_role_changed": "notificationRoleChanged",
  "doska.task_comment": "notificationComment",
  "doska.task_mention": "notificationMention",
  "doska.invitation_created": "notificationInvitation",
  "doska.invitation_accepted": "notificationInvitationAccepted",
  "doska.invitation_declined": "notificationInvitationDeclined",
  "doska.join_requested": "notificationJoinRequested",
  "doska.join_approved": "notificationJoinApproved",
  "doska.join_rejected": "notificationJoinRejected",
  "doska.member_department_changed": "notificationDepartmentChanged",
};
function notificationHref(item: DoskaNotification) {
  if (item.destination === "invitations") return doskaHref("/invitations");
  const project = `/projects/${encodeURIComponent(item.projectId)}`;
  if (item.destination === "members")
    return doskaHref(`${project}?panel=members`);
  if (item.destination === "task" && item.taskId)
    return doskaHref(`${project}?taskId=${encodeURIComponent(item.taskId)}`);
  return doskaHref(project);
}
export function DoskaNotificationCenter({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("doska"),
    navigate = useNavigate(),
    cache = useQueryClient();
  const visible = usePageVisibility();
  const ref = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const opening = useRef(false);
  const list = useInfiniteQuery({
    queryKey: ["doska", "notifications", "list"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listNotifications({ limit: 30, cursor: pageParam }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const preferences = useQuery({
    queryKey: ["doska", "notification-preferences"],
    queryFn: () => api.notificationPreferences(),
    enabled: visible,
    retry: false,
  });
  const savePreferences = useMutation({
    onMutate: () =>
      cache.cancelQueries({ queryKey: ["doska", "notification-preferences"] }),
    mutationFn: (dueDateReminderEnabled: boolean) =>
      api.updateNotificationPreferences({ dueDateReminderEnabled }),
    onSuccess: (data) =>
      cache.setQueryData(["doska", "notification-preferences"], data),
  });
  const change = useMutation({
    mutationFn: async (id: string | null) => {
      if (id) await api.markNotificationRead(id);
      else await api.readAllNotifications();
    },
    onSettled: async () => {
      await cache.invalidateQueries({ queryKey: ["doska", "notifications"] });
    },
  });
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      mounted.current = false;
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  const open = async (item: DoskaNotification) => {
    if (opening.current) return;
    opening.current = true;
    if (!item.isRead) {
      try {
        await change.mutateAsync(item.id);
      } catch {
        /* Task navigation remains available when the read marker fails. */
      }
    }
    if (!mounted.current) return;
    onClose();
    if (item.destination === "invitations") {
      void navigate({ to: "/invitations" } as never);
    } else {
      void navigate({
        to: "/projects/$projectId",
        params: { projectId: item.projectId },
        search:
          item.destination === "members"
            ? { panel: "members" }
            : item.destination === "task" && item.taskId
              ? { taskId: item.taskId }
              : {},
      } as never);
    }
  };
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <dialog
      ref={ref}
      className="doska-dialog doska-notifications"
      aria-labelledby="doska-notifications-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
    >
      <header>
        <h2 id="doska-notifications-heading">{t("notifications")}</h2>
        <button
          className="doska-icon"
          aria-label={t("close")}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="doska-notification-preferences">
        {preferences.isError ? (
          <div role="alert">
            {t("notificationPreferencesError")}{" "}
            <button onClick={() => void preferences.refetch()}>
              {t("retry")}
            </button>
          </div>
        ) : preferences.isPending ? (
          <span role="status">{t("loading")}</span>
        ) : (
          <label>
            <input
              type="checkbox"
              checked={
                savePreferences.isPending
                  ? savePreferences.variables
                  : preferences.data.dueDateReminderEnabled
              }
              disabled={savePreferences.isPending}
              onChange={(event) => savePreferences.mutate(event.target.checked)}
            />
            {t("notificationReminders")}
          </label>
        )}
        {savePreferences.isPending && <span role="status">{t("saving")}</span>}
        {savePreferences.isError && (
          <div role="alert">
            {t("saveError")}{" "}
            <button
              onClick={() => savePreferences.mutate(savePreferences.variables)}
            >
              {t("retry")}
            </button>
          </div>
        )}
      </div>
      {list.isError ? (
        <div role="alert" className="doska-notice doska-error">
          <p>{t("loadError")}</p>
          <button onClick={() => void list.refetch()}>{t("retry")}</button>
        </div>
      ) : list.isPending ? (
        <p role="status">{t("loading")}</p>
      ) : (
        <>
          {items.length > 0 && (
            <button
              className="doska-notification-read-all"
              disabled={change.isPending}
              onClick={() => change.mutate(null)}
            >
              {t("notificationsReadAll")}
            </button>
          )}
          {!items.length ? (
            <p className="doska-notification-empty">
              {t("notificationsEmpty")}
            </p>
          ) : (
            <ul className="doska-notification-list">
              {items.map((item) => (
                <li key={item.id} className={item.isRead ? "" : "is-unread"}>
                  <a
                    href={notificationHref(item)}
                    onClick={(event) => {
                      if (
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      event.preventDefault();
                      void open(item);
                    }}
                  >
                    <span className="doska-notification-kind">
                      {t(labels[item.type] ?? "notificationUpdated")}
                    </span>
                    <strong>
                      {item.type === "doska.member_department_changed"
                        ? (item.affectedUserName ?? t("notificationEmployee"))
                        : (item.taskTitle ?? item.projectName)}
                    </strong>
                    <span className="doska-notification-meta">
                      {(item.destination === "task" ||
                        item.type === "doska.member_department_changed") && (
                        <>
                          {item.projectName}
                          {item.taskNumber != null
                            ? ` · #${item.taskNumber}`
                            : ""}{" "}
                          ·{" "}
                        </>
                      )}
                      <time dateTime={item.createdAt}>
                        {new Date(item.createdAt).toLocaleString("ru-RU", {
                          timeZone: "Europe/Moscow",
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </span>
                  </a>
                  {!item.isRead && (
                    <button
                      className="doska-icon"
                      disabled={change.isPending}
                      aria-label={t("notificationMarkRead", {
                        title: item.taskTitle ?? item.projectName,
                      })}
                      title={t("notificationMarkRead", {
                        title: item.taskTitle ?? item.projectName,
                      })}
                      onClick={() => change.mutate(item.id)}
                    >
                      <Check size={17} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {list.hasNextPage && (
            <button
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {t(list.isFetchingNextPage ? "loading" : "loadMore")}
            </button>
          )}
        </>
      )}
      {change.isError && (
        <p role="alert" className="doska-error">
          {t("notificationReadError")}
        </p>
      )}
    </dialog>
  );
}
