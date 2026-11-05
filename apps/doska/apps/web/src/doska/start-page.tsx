import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { DoskaMyTasks } from "./my-tasks";
export const startPages = {
  "my-tasks": "myTasks",
  projects: "projects",
  search: "taskSearch",
  invitations: "invitations",
  management: "managedProjects",
} as const;
export type StartPage = keyof typeof startPages;
export function startPagePath(page: string): string {
  return Object.hasOwn(startPages, page) ? `/${page}` : "/my-tasks";
}
export function DoskaStartPage() {
  const { t } = useTranslation("doska");
  const navigate = useNavigate();
  const preferences = useQuery({
    queryKey: ["doska", "preferences"],
    queryFn: () => api.preferences(),
    retry: false,
  });
  useEffect(() => {
    if (preferences.isSuccess)
      void navigate({
        to: startPagePath(preferences.data.startPage),
        replace: true,
      } as never);
  }, [preferences.isSuccess, preferences.data, navigate]);
  if (preferences.isError)
    return (
      <>
        <div className="doska-notice" role="status">
          {t("startPageLoadError")}{" "}
          <button onClick={() => void preferences.refetch()}>
            {t("retry")}
          </button>
        </div>
        <DoskaMyTasks />
      </>
    );
  return <div role="status">{t("loading")}</div>;
}
