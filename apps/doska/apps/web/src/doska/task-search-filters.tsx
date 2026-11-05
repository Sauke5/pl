import { TaskSearchResource } from "./task-search-resource";
import { TaskSearchMetadata } from "./task-search-metadata";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { useDoskaSession } from "./session";
import type { TaskSearchFilters } from "./task-search-context";
export function TaskSearchFilterFields({
  filters,
  onChange,
}: {
  filters: TaskSearchFilters;
  onChange: (patch: Partial<TaskSearchFilters>) => void;
}) {
  const { t } = useTranslation("doska");
  const { context } = useDoskaSession();
  const projects = useQuery({
    queryKey: ["doska", "search-project-options", filters.archived],
    queryFn: async () => {
      const load = async (archived: boolean) => {
        const all = await api.listProjects({ limit: 100, archived });
        for (let offset = 100; all.length === offset; offset += 100) {
          all.push(
            ...(await api.listProjects({ limit: 100, offset, archived })),
          );
        }
        return all;
      };
      const groups = await Promise.all(
        (filters.archived ? [false, true] : [false]).map(load),
      );
      return Array.from(
        new Map(groups.flat().map((project) => [project.id, project])).values(),
      );
    },
  });
  const roster = useQuery({
    queryKey: ["doska", "members", filters.projectId],
    queryFn: () => api.listMembers(filters.projectId),
    enabled: Boolean(filters.projectId),
  });
  const people = filters.projectId
    ? roster.data && !roster.isError
      ? [roster.data.owner, ...roster.data.members]
      : []
    : [{ userId: context.user.id, name: context.user.name }];
  const uniquePeople = Array.from(
    new Map(people.map((person) => [person.userId, person])).values(),
  );
  return (
    <details
      className="doska-search-filters"
      open={
        Object.entries(filters).some(
          ([key, value]) => key !== "q" && Boolean(value),
        ) || undefined
      }
    >
      <summary>{t("searchFilters")}</summary>
      <div className="doska-search-filter-grid">
        <label className="doska-field">
          {t("project")}
          <select
            value={filters.projectId}
            disabled={projects.isPending || projects.isError}
            onChange={(event) =>
              onChange({
                projectId: event.target.value,
                assigneeId: "",
                coexecutorId: "",
                resourceId: "",
                sourceKind: "",
                customFieldId: "",
                customFieldValue: "",
                unassigned: false,
              })
            }
          >
            <option value="">{t("searchAllProjects")}</option>
            {filters.projectId &&
              projects.isSuccess &&
              !projects.data.some(
                (project) => project.id === filters.projectId,
              ) && (
                <option value={filters.projectId}>
                  {t("searchUnavailableProject")}
                </option>
              )}
            {projects.data?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="doska-field">
          {t("responsible")}
          <select
            value={filters.unassigned ? "__unassigned" : filters.assigneeId}
            disabled={
              Boolean(filters.projectId) && (roster.isPending || roster.isError)
            }
            onChange={(event) =>
              onChange({
                unassigned: event.target.value === "__unassigned",
                assigneeId:
                  event.target.value === "__unassigned"
                    ? ""
                    : event.target.value,
              })
            }
          >
            <option value="">{t("searchAnyone")}</option>
            <option value="__unassigned">{t("unassigned")}</option>
            {filters.assigneeId &&
              !uniquePeople.some(
                (person) => person.userId === filters.assigneeId,
              ) && (
                <option value={filters.assigneeId}>
                  {t(
                    filters.projectId
                      ? "unavailableMember"
                      : "searchSelectedEmployee",
                  )}
                </option>
              )}
            {uniquePeople.map((person) => (
              <option key={person.userId} value={person.userId}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
        <label className="doska-field">
          {t("searchCoexecutor")}
          <select
            value={filters.coexecutorId}
            disabled={
              Boolean(filters.projectId) && (roster.isPending || roster.isError)
            }
            onChange={(event) => onChange({ coexecutorId: event.target.value })}
          >
            <option value="">{t("searchAnyone")}</option>
            {filters.coexecutorId &&
              !uniquePeople.some(
                (person) => person.userId === filters.coexecutorId,
              ) && (
                <option value={filters.coexecutorId}>
                  {t("unavailableMember")}
                </option>
              )}
            {uniquePeople.map((person) => (
              <option key={person.userId} value={person.userId}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
        <label className="doska-field">
          {t("status")}
          <select
            value={filters.state}
            onChange={(event) =>
              onChange({
                state: event.target.value as TaskSearchFilters["state"],
              })
            }
          >
            <option value="">{t("searchAnyState")}</option>
            {(["planned", "active", "completed"] as const).map((value) => (
              <option key={value} value={value}>
                {t(`searchState_${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="doska-field">
          {t("priority")}
          <select
            value={filters.priority}
            onChange={(event) =>
              onChange({
                priority: event.target.value as TaskSearchFilters["priority"],
              })
            }
          >
            <option value="">{t("searchAnyPriority")}</option>
            {(["no-priority", "low", "medium", "high", "urgent"] as const).map(
              (value) => (
                <option key={value} value={value}>
                  {t(`priority_${value}`)}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="doska-field">
          {t("searchDueFrom")}
          <input
            type="date"
            value={filters.dueFrom}
            max={filters.dueTo || undefined}
            onChange={(event) => onChange({ dueFrom: event.target.value })}
          />
        </label>
        <label className="doska-field">
          {t("searchDueTo")}
          <input
            type="date"
            value={filters.dueTo}
            min={filters.dueFrom || undefined}
            onChange={(event) => onChange({ dueTo: event.target.value })}
          />
        </label>
        <TaskSearchResource
          key={filters.projectId}
          filters={filters}
          onChange={onChange}
        />
        <TaskSearchMetadata
          filters={filters}
          onChange={onChange}
          people={uniquePeople}
        />
      </div>
      {!filters.projectId && (
        <p className="doska-meta">{t("searchChooseProjectForPeople")}</p>
      )}
      <div className="doska-filters">
        <label>
          <input
            type="checkbox"
            checked={filters.open}
            onChange={(event) => onChange({ open: event.target.checked })}
          />
          {t("searchOpenOnly")}
        </label>
        <label>
          <input
            type="checkbox"
            checked={filters.upcoming}
            onChange={(event) => onChange({ upcoming: event.target.checked })}
          />
          {t("overviewUpcoming")}
        </label>
        <label>
          <input
            type="checkbox"
            checked={filters.overdue}
            onChange={(event) => onChange({ overdue: event.target.checked })}
          />
          {t("searchOverdueOnly")}
        </label>
        <label>
          <input
            type="checkbox"
            checked={filters.archived}
            onChange={(event) => onChange({ archived: event.target.checked })}
          />
          {t("searchIncludeArchived")}
        </label>
      </div>
      {projects.isError && (
        <p role="alert" className="doska-error">
          {t("loadError")}{" "}
          <button onClick={() => void projects.refetch()}>{t("retry")}</button>
        </p>
      )}
      {filters.projectId && roster.isError && (
        <p role="alert" className="doska-error">
          {t("membersLoadError")}{" "}
          <button onClick={() => void roster.refetch()}>{t("retry")}</button>
        </p>
      )}
    </details>
  );
}
