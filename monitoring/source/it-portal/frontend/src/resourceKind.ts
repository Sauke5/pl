import type { Resource } from "./types";

export type ResourceKind = "applications" | "infrastructure";

// Classify the object, not its URL or direction: management applications may
// share a host address and belong to infrastructure-related directions.
const infrastructureTypes = new Set([
  "сервер",
  "виртуальная машина",
  "устройство",
  "сетевое устройство",
  "хранилище",
  "server",
  "virtual machine",
  "vm",
  "device",
  "network device",
  "storage",
]);

export function resourceKind(resource: Pick<Resource, "type">): ResourceKind {
  return infrastructureTypes.has(resource.type.trim().toLowerCase())
    ? "infrastructure"
    : "applications";
}
