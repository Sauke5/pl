import { api, APIError } from "./api";

export type ResourceSelection = {
  resourceId: string;
  sourceKind: "platform" | "netbox";
};
export type ResourceTaskLink = {
  projectId: string;
  taskId: string;
  title: string;
  href: string;
};
export type ResourceTaskPage = {
  version: 1;
  items: ResourceTaskLink[];
  nextCursor: string | null;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = /^[A-Za-z0-9_-]{1,128}$/;
export function catalogResourceId(hash: string): string | undefined {
  const [page, query] = hash.replace(/^#/, "").split("?");
  if (page !== "catalog" || !query) return;
  const params = new URLSearchParams(query);
  const values = params.getAll("resourceId");
  return values.length === 1 && uuid.test(values[0]) ? values[0] : undefined;
}
export function createResourceTaskHref(selection: ResourceSelection): string {
  return `/doska/projects?${new URLSearchParams(selection)}`;
}
export async function resourceTaskLinks(
  selection: ResourceSelection,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<ResourceTaskPage> {
  const result = await api<ResourceTaskPage>(
    "/doska/api/doska/catalog/task-links",
    "POST",
    { selection, limit: 20, cursor },
    {},
    signal,
  );
  if (
    result.version !== 1 ||
    !Array.isArray(result.items) ||
    result.items.length > 20 ||
    (result.nextCursor !== null && typeof result.nextCursor !== "string") ||
    result.items.some(
      (task) =>
        !id.test(task.projectId) ||
        !id.test(task.taskId) ||
        typeof task.title !== "string" ||
        task.href !== `/doska/projects/${task.projectId}?taskId=${task.taskId}`,
    )
  )
    throw new APIError("Не удалось получить задачи Doska", 502);
  return result;
}
