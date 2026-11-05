export type TaskSearchFilters = {
  q: string;
  resourceId: string;
  sourceKind: "" | "platform" | "netbox";
  labelName: string;
  customFieldId: string;
  customFieldValue: string;
  projectId: string;
  assigneeId: string;
  coexecutorId: string;
  state: "" | "planned" | "active" | "completed";
  priority: "" | "no-priority" | "low" | "medium" | "high" | "urgent";
  dueFrom: string;
  dueTo: string;
  open: boolean;
  upcoming: boolean;
  unassigned: boolean;
  overdue: boolean;
  archived: boolean;
};
export const emptyTaskSearch: TaskSearchFilters = {
  q: "",
  resourceId: "",
  sourceKind: "",
  labelName: "",
  customFieldId: "",
  customFieldValue: "",
  projectId: "",
  assigneeId: "",
  coexecutorId: "",
  state: "",
  priority: "",
  dueFrom: "",
  dueTo: "",
  open: false,
  upcoming: false,
  unassigned: false,
  overdue: false,
  archived: false,
};
export type TaskSearchContext = {
  filters: TaskSearchFilters;
  page: number;
  scrollY: number;
};
export function readTaskSearchContext(
  state: unknown,
): TaskSearchContext | null {
  const value = (state as { doskaTaskSearch?: TaskSearchContext } | null)
    ?.doskaTaskSearch;
  if (
    !value ||
    !Number.isSafeInteger(value.page) ||
    value.page < 0 ||
    !Number.isFinite(value.scrollY) ||
    value.scrollY < 0 ||
    !value.filters
  )
    return null;
  const f = {
    ...value.filters,
    resourceId: value.filters.resourceId ?? "",
    sourceKind: value.filters.sourceKind ?? "",
    open: value.filters.open ?? false,
    upcoming: value.filters.upcoming ?? false,
  };
  if (
    Object.entries(emptyTaskSearch).some(
      ([key, defaultValue]) =>
        typeof f[key as keyof TaskSearchFilters] !== typeof defaultValue,
    ) ||
    f.q.length > 200
  )
    return null;
  if (
    Boolean(f.resourceId) !== Boolean(f.sourceKind) ||
    (f.resourceId &&
      (!f.projectId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          f.resourceId,
        ))) ||
    !["", "platform", "netbox"].includes(f.sourceKind)
  )
    return null;
  if (
    !["", "planned", "active", "completed"].includes(f.state) ||
    !["", "no-priority", "low", "medium", "high", "urgent"].includes(f.priority)
  )
    return null;
  if (
    [f.dueFrom, f.dueTo].some(
      (date) => date && !/^\d{4}-\d{2}-\d{2}$/.test(date),
    )
  )
    return null;
  return { ...value, filters: f };
}
