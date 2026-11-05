import { safeURL } from "./api";
import { resourceKind } from "./resourceKind";
import type { Resource } from "./types";

export function isServiceCardResource(
  resource: Pick<Resource, "type" | "url">,
): boolean {
  return (
    resourceKind(resource) === "applications" && Boolean(safeURL(resource.url))
  );
}
