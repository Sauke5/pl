// Only routes served by the Platform origin may become post-login destinations.
// Keep this narrower than the browser's notion of a same-origin URL: paths used
// by auth, the API and arbitrary upstreams must never be return targets.
const prefixes = [
  "/directory/",
  "/forms/",
  "/audit/",
  "/audit-arch/",
  "/netmap/",
  "/wiki/",
  "/wayline/",
  "/grafana/",
  "/prometheus/",
  "/alertmanager/",
  "/snmp-exporter/",
  "/blackbox/",
  "/reports/",
  "/websites/",
  "/admin/",
];

const unsafeQueryName =
  /(?:token|secret|password|passwd|authorization|auth|api.?key|code|state|session|redirect|return|next)/i;

export function loginReturnTarget(value: string | null): value is string {
  if (
    !value ||
    value.length > 2048 ||
    !value.startsWith("/") ||
    value.startsWith("//")
  )
    return false;
  if (
    /[\\\u0000-\u001f\u007f#]/.test(value) ||
    /%(?:2f|5c|2e|00|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)
  )
    return false;
  let url: URL;
  try {
    url = new URL(value, location.origin);
  } catch {
    return false;
  }
  const doskaPage =
    /^\/doska\/(?:projects(?:\/[A-Za-z0-9_-]{1,128})?|invitations|management|search|my-tasks|overview)?$/.test(
      url.pathname,
    );
  if (
    url.origin !== location.origin ||
    (url.pathname !== "/proxy-4.14" &&
      url.pathname !== "/sftp-server" &&
      url.pathname !== "/sftp-server/" &&
      url.pathname !== "/sftp-adm" &&
      url.pathname !== "/sftp-adm/" &&
      url.pathname !== "/sftp-adm/open/admin" &&
      url.pathname !== "/sftp-adm/open/files" &&
      !doskaPage &&
      !prefixes.some((prefix) => url.pathname.startsWith(prefix)))
  )
    return false;
  if (
    url.pathname.split("/").some((part) => part === "." || part === "..") ||
    url.pathname.includes("//") ||
    (!doskaPage && url.pathname.split("/").includes("api"))
  )
    return false;
  for (const [name, queryValue] of url.searchParams) {
    if (
      unsafeQueryName.test(name) ||
      /^\s*(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(queryValue)
    )
      return false;
  }
  return url.pathname + url.search === value;
}

export function pendingLoginReturn(): string | null {
  const query = new URLSearchParams(location.search);
  const fragmentReturn =
    location.pathname === "/401" && location.hash.startsWith("#return_to:");
  const supplied = query.has("return_to") || fragmentReturn;
  const requested = fragmentReturn
    ? location.hash.slice("#return_to:".length)
    : query.get("return_to");
  if (fragmentReturn)
    history.replaceState(
      history.state,
      "",
      location.pathname + location.search,
    );
  try {
    if (supplied) {
      if (loginReturnTarget(requested))
        sessionStorage.setItem("pl-ui-login-return", requested);
      else sessionStorage.removeItem("pl-ui-login-return");
    }
    return supplied ? requested : sessionStorage.getItem("pl-ui-login-return");
  } catch {
    return requested;
  }
}

export function clearLoginReturn() {
  try {
    sessionStorage.removeItem("pl-ui-login-return");
  } catch {
    // Storage is optional for a direct login.
  }
}
