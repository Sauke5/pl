import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "./api";

export function DoskaBreadcrumbs({
  pathname,
  embedded = false,
}: {
  pathname: string;
  embedded?: boolean;
}) {
  const { t } = useTranslation("doska");
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const path = pathname.replace(/\/$/, "");
  const projectId = path.match(/\/projects\/([A-Za-z0-9_-]+)$/)?.[1];
  const project = useQuery({
    queryKey: ["doska", "project", projectId],
    queryFn: () => api.getProject(projectId!),
    enabled: Boolean(projectId),
  });
  const section = path.split("/").at(-1);
  const labels = {
    "my-tasks": "myTasks",
    projects: "projects",
    overview: "overview",
    search: "taskSearch",
    invitations: "invitations",
    management: "managedProjects",
  } as const;
  const current = projectId
    ? project.isError
      ? t("project")
      : project.data?.name || t(project.isPending ? "loading" : "project")
    : t(labels[section as keyof typeof labels] ?? "app");
  return (
    <nav className="doska-breadcrumb" aria-label={t("breadcrumbs")}>
      {!embedded && <a href="/">{t("platform")}</a>}
      <ChevronRight size={14} aria-hidden="true" />
      {projectId && (
        <>
          <a href={`${base}/projects`}>{t("projects")}</a>
          <ChevronRight size={14} aria-hidden="true" />
        </>
      )}
      <span aria-current="page" title={current}>
        {current}
      </span>
    </nav>
  );
}
