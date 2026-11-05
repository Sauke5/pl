import { Outlet, useRouterState } from "@tanstack/react-router";
import {
  CheckSquare,
  ChartNoAxesCombined,
  Folder,
  Mail,
  Settings,
  Search,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PlatformShell } from "@pl/ui/react";
import "@pl/ui/styles.css";
import { useDoskaSession } from "./session";
import { api } from "./api";
import { DoskaPersonalSettings } from "./personal-settings";
import { DoskaNotificationBell } from "./notification-bell";
import { DoskaBreadcrumbs } from "./breadcrumbs";

export const doskaHref = (path: string) =>
  `${import.meta.env.BASE_URL.replace(/\/$/, "")}${path}`;

export function DoskaShell() {
  const { t } = useTranslation("doska");
  const { context } = useDoskaSession();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const [personalSettings, setPersonalSettings] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const [initialCollapsed] = useState(() => {
    try {
      return localStorage.getItem("doska-sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });
  async function logout() {
    setLogoutError(false);
    try {
      await api.logout();
    } catch {
      setLogoutError(true);
    }
  }
  const searching = pathname.includes("/search");
  const overview = pathname.includes("/overview");
  const projects = pathname.includes("/projects");
  const invitations = pathname.includes("/invitations");
  const management = pathname.includes("/management");
  const links = [
    {
      path: "/my-tasks",
      key: "myTasks",
      icon: CheckSquare,
      active:
        !projects && !invitations && !management && !searching && !overview,
    },
    {
      path: "/overview",
      key: "overview",
      icon: ChartNoAxesCombined,
      active: overview,
    },
    { path: "/search", key: "taskSearch", icon: Search, active: searching },
    { path: "/projects", key: "projects", icon: Folder, active: projects },
    {
      path: "/invitations",
      key: "invitations",
      icon: Mail,
      active: invitations,
    },
    {
      path: "/management",
      key: "managedProjects",
      icon: Settings,
      active: management,
    },
  ] as const;
  return (
    <PlatformShell
      branding={{name:"PL",subtitle:"PLATFORM",label:"Platform"}}
      shellClassName="doska-app"
      context=""
      breadcrumbExtra={<DoskaBreadcrumbs embedded pathname={pathname} />}
      user={{ name: context.user.name, subtitle: t("platformUser") }}
      initialCollapsed={initialCollapsed}
      onLogout={logout}
      navigation={links.map(({ path, key, icon: Icon, active }) => (
        <a
          key={path}
          className={active ? "active" : ""}
          href={doskaHref(path)}
          aria-label={t(key)}
          title={t(key)}
          aria-current={active ? "page" : undefined}
        >
          <Icon size={20} />
          <span className="nav-label">{t(key)}</span>
        </a>
      ))}
      actions={
        <>
          <DoskaNotificationBell />
          <button
            className="doska-icon"
            aria-label={t("personalSettings")}
            title={t("personalSettings")}
            onClick={() => setPersonalSettings(true)}
          >
            <Settings size={19} />
          </button>
        </>
      }
      banner={
        logoutError ? (
          <div role="alert" className="doska-notice doska-error">
            {t("logoutError")}
          </div>
        ) : null
      }
      overlays={
        personalSettings ? (
          <DoskaPersonalSettings onClose={() => setPersonalSettings(false)} />
        ) : null
      }
    >
      <Outlet />
    </PlatformShell>
  );
}
