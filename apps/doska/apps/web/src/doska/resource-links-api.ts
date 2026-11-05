import { z } from "zod";
import type { ResourceCreateAttempt } from "./resource-create-state";
import { descriptor, type ResourceSelection } from "./resource-links-types";
import { resolveApiBaseUrl } from "@kaneo/libs";
import { ApiError, mutationOptions } from "./api";
import {
  resourceLinksSchema,
  resourceMutationSchema,
  resourceSearchSchema,
  type ResourceMutation,
} from "./resource-links-types";
function base() {
  return (
    resolveApiBaseUrl(
      import.meta.env.VITE_API_URL,
      import.meta.env.BASE_URL,
      import.meta.env.VITE_DOSKA_MODE,
    ) + "/doska"
  );
}
function path(projectId: string, taskId: string) {
  return `${base()}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/resource-links`;
}
async function response(request: Promise<Response>) {
  const result = await request;
  if (!result.ok)
    throw new ApiError(result.status, `Request failed (${result.status})`);
  return result.json() as Promise<unknown>;
}
const createResponse = resourceMutationSchema.extend({
  taskId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  href: z.string(),
});
const resolveResponse = z.strictObject({
  version: z.literal(1),
  items: z
    .array(
      z.discriminatedUnion("available", [
        z.strictObject({
          index: z.literal(0),
          available: z.literal(true),
          descriptor,
        }),
        z.strictObject({ index: z.literal(0), available: z.literal(false) }),
      ]),
    )
    .length(1),
});
export const resourceLinksApi = {
  async resolve(
    projectId: string,
    selection: ResourceSelection,
    signal?: AbortSignal,
  ) {
    const { headers } = await mutationOptions();
    return resolveResponse.parse(
      await response(
        fetch(`${base()}/catalog/resolve`, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          signal,
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, selections: [selection] }),
        }),
      ),
    ).items[0]!;
  },
  async create(projectId: string, attempt: ResourceCreateAttempt) {
    const { headers } = await mutationOptions();
    const result = createResponse.parse(
      await response(
        fetch(
          `${base()}/projects/${encodeURIComponent(projectId)}/tasks/from-resource`,
          {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            signal: AbortSignal.timeout(30_000),
            headers: {
              ...headers,
              "Content-Type": "application/json",
              "Idempotency-Key": attempt.clientRequestId,
            },
            body: JSON.stringify(attempt),
          },
        ),
      ),
    );
    if (
      result.projectId !== projectId ||
      result.href !==
        `/doska/projects/${encodeURIComponent(projectId)}?taskId=${encodeURIComponent(result.taskId)}`
    )
      throw new Error("Invalid created task response");
    return result;
  },
  async list(projectId: string, taskId: string, signal?: AbortSignal) {
    return resourceLinksSchema.parse(
      await response(
        fetch(path(projectId, taskId), {
          credentials: "same-origin",
          cache: "no-store",
          signal,
        }),
      ),
    );
  },
  async search(
    projectId: string,
    q: string,
    cursor?: string,
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({
      projectId,
      q,
      limit: "20",
      ...(cursor ? { cursor } : {}),
    });
    return resourceSearchSchema.parse(
      await response(
        fetch(`${base()}/catalog/search?${query}`, {
          credentials: "same-origin",
          cache: "no-store",
          signal,
        }),
      ),
    );
  },
  async mutate(
    projectId: string,
    taskId: string,
    attempt: ResourceMutation,
    signal?: AbortSignal,
  ) {
    const { headers } = await mutationOptions();
    const body = {
      expectedRevision: attempt.expectedRevision,
      clientRequestId: attempt.clientRequestId,
      ...(attempt.operation === "attach"
        ? { selection: attempt.selection }
        : {}),
    };
    return resourceMutationSchema.parse(
      await response(
        fetch(
          path(projectId, taskId) +
            (attempt.operation === "detach"
              ? `/${encodeURIComponent(attempt.linkId)}`
              : ""),
          {
            method: attempt.operation === "attach" ? "POST" : "DELETE",
            credentials: "same-origin",
            cache: "no-store",
            signal,
            headers: {
              ...headers,
              "Content-Type": "application/json",
              "Idempotency-Key": attempt.clientRequestId,
            },
            body: JSON.stringify(body),
          },
        ),
      ),
    );
  },
};
