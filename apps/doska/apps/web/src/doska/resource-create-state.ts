import { ApiError, type CreateTaskInput } from "./api";
import type { ResourceSelection } from "./resource-links-types";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function resourceCreateSearch(search: Record<string, unknown>) {
  if (search.resourceId === undefined && search.sourceKind === undefined)
    return {};
  if (
    typeof search.resourceId !== "string" ||
    !uuid.test(search.resourceId) ||
    (search.sourceKind !== "platform" && search.sourceKind !== "netbox")
  )
    return { resourceInvalid: true as const };
  return {
    resourceId: search.resourceId,
    sourceKind: search.sourceKind as ResourceSelection["sourceKind"],
  };
}
export type ResourceCreateAttempt = {
  expectedRevision: 0;
  clientRequestId: string;
  selection: ResourceSelection;
  task: CreateTaskInput;
};
export function newResourceCreateAttempt(
  selection: ResourceSelection,
  task: CreateTaskInput,
): ResourceCreateAttempt {
  return structuredClone({
    expectedRevision: 0,
    clientRequestId: crypto.randomUUID(),
    selection,
    task,
  });
}
export function knownResourceCreateRejection(error: unknown) {
  return (
    error instanceof ApiError &&
    [400, 401, 403, 404, 413, 422, 429].includes(error.status)
  );
}
