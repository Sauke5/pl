export type ManagedNavigationInstance = {
  id: string;
  name: string;
  module_id: string;
  mode: string;
  desired_state: string;
  observed_state?: string;
  last_success?: string;
  error?: string;
};

export function installedLocalModules(
  items: ManagedNavigationInstance[] = [],
  moduleID: string,
) {
  return items.filter(
    (item) =>
      item.module_id === moduleID &&
      item.mode === "local" &&
      item.desired_state !== "removed" &&
      item.observed_state !== "absent" &&
      (item.observed_state === "running" ||
        item.observed_state === "disabled" ||
        !!item.last_success),
  );
}

export function externalModules(
  items: ManagedNavigationInstance[] = [],
  moduleID: string,
) {
  return items.filter(
    (item) =>
      item.module_id === moduleID &&
      item.mode === "external" &&
      item.desired_state !== "removed" &&
      item.observed_state !== "absent",
  );
}

// Navigation reflects the saved connection, including disabled/unavailable
// deployments. Showing a settings entry must not require an upstream probe.
export function netMapModules(items: ManagedNavigationInstance[] = []) {
  return items.filter(
    (item) =>
      item.module_id === "netmap" &&
      (item.mode === "local" || item.mode === "external") &&
      item.desired_state !== "removed" &&
      item.observed_state !== "absent",
  );
}
