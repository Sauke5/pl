// Defence in depth: links come exclusively from the backend board projection.
export function employeeURL(value?: string): string | undefined {
  if (!value || value.trim() !== value || /[\\\r\n\x00]/.test(value))
    return undefined;
  try {
    const absolute = /^https?:\/\//i.test(value);
    if (!absolute && (!value.startsWith("/") || value.startsWith("//")))
      return undefined;
    const url = new URL(value, location.origin);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    if (
      [...url.searchParams.keys()].some((key) =>
        /^(token|access_token|id_token|password|secret|api_key|apikey|authorization)$/i.test(
          key,
        ),
      )
    )
      return undefined;
    const path = decodeURIComponent(url.pathname);
    if (!absolute && (path.startsWith("//") || /[\\\r\n\x00]/.test(path)))
      return undefined;
    if (url.origin === location.origin && /^\/(auth|api)(\/|$)/.test(path))
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
export function readEmployeeFavorites(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value)
      ? [
          ...new Set(
            value.filter((id): id is string => typeof id === "string"),
          ),
        ].slice(0, 1000)
      : [];
  } catch {
    return [];
  }
}
