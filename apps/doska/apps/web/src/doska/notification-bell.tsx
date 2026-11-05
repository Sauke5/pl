import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Bell } from "lucide-react";
import { api } from "./api";
import { usePageVisibility } from "./page-visibility";
import { DoskaNotificationCenter } from "./notification-center";
export function DoskaNotificationBell() {
  const { t } = useTranslation("doska");
  const visible = usePageVisibility();
  const [open, setOpen] = useState(false);
  const unread = useQuery({
    queryKey: ["doska", "notifications", "unread"],
    queryFn: api.notificationUnreadCount,
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const count = unread.isError ? null : unread.data?.count;
  return (
    <>
      <button
        className="doska-icon doska-notification-bell"
        aria-label={
          count ? t("notificationsUnread", { count }) : t("notifications")
        }
        title={t(unread.isError ? "notificationsLoadError" : "notifications")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
          if (unread.isError) void unread.refetch();
        }}
      >
        <Bell size={19} />
        {count != null && count > 0 && (
          <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
        )}
      </button>
      {open && <DoskaNotificationCenter onClose={() => setOpen(false)} />}
    </>
  );
}
